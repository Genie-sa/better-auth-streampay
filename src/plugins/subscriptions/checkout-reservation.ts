import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayClient, StreamPayOptions } from "../../types";
import { readSdkErrorFields } from "../../utils/error-envelope";
import { toAPIError } from "../../utils/errors";
import { isUniqueConstraintError } from "../../utils/unique-constraint";
import type { PluginAdapter } from "./adapter";
import { SubscriptionCorrelationError } from "./correlation-error";
import type { Subscription } from "./types";
import { UPGRADE_IDEMPOTENCY_WINDOW_MS } from "./types";

const SUBSCRIPTION_MODEL = "subscription";

type ReservationLog = {
	error: (message: string) => void;
	warn: (message: string) => void;
};

/**
 * How a release treats the reservation's payment link before giving up the slot (C2).
 * `required` fails the release when the link may stay payable; `best-effort` logs and proceeds,
 * because a paid subscription must never wait on it; `skip` is for a link already known to be gone.
 */
type LinkDeactivation = "required" | "best-effort" | "skip";

class LinkDeactivationError extends Error {
	constructor(
		readonly linkId: string,
		override readonly cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "LinkDeactivationError";
	}
}

function checkoutInProgressError(): APIError {
	return new APIError("CONFLICT", {
		code: $ERROR_CODES.SUBSCRIPTION_CHECKOUT_IN_PROGRESS.code,
		message: "A subscription checkout is already being created for this plan group.",
	});
}

function subscriptionAlreadyActiveError(): APIError {
	return new APIError("CONFLICT", {
		code: $ERROR_CODES.SUBSCRIPTION_ALREADY_ACTIVE.code,
		message: "An active subscription already exists for this plan group.",
	});
}

/**
 * Makes an abandoned checkout link unpayable before its reservation releases the slot.
 * A missing link is already unpayable. Custom clients without the status API cannot be
 * compensated, so the release proceeds and a late payment is handled by webhook slot recovery.
 */
async function deactivatePaymentLink(
	client: StreamPayClient,
	paymentLinkId: string,
	log: { warn: (message: string) => void },
): Promise<void> {
	if (!client.updatePaymentLinkStatus) {
		log.warn(
			`payment link=${paymentLinkId} stays payable: client does not implement updatePaymentLinkStatus.`,
		);
		return;
	}
	try {
		await client.updatePaymentLinkStatus(paymentLinkId, { status: "INACTIVE" });
	} catch (err) {
		if (readSdkErrorFields(err).status !== 404) throw err;
	}
}

async function recoverCheckoutUrl(
	client: StreamPayOptions["client"],
	row: Pick<Subscription, "streampayPaymentLinkId">,
): Promise<{ kind: "recovered"; url: string } | { kind: "expired" }> {
	if (!row.streampayPaymentLinkId) return { kind: "expired" };
	try {
		const link = await client.getPaymentLink(row.streampayPaymentLinkId);
		// The SDK returns a URL for inactive links too; their hosted page refuses payment.
		const url = link.status === "INACTIVE" ? null : client.getPaymentUrl(link);
		return url ? { kind: "recovered", url } : { kind: "expired" };
	} catch (err) {
		if (readSdkErrorFields(err).status === 404) return { kind: "expired" };
		throw err;
	}
}

export async function deleteReservedSubscription(
	adapter: PluginAdapter,
	rowId: string,
	log: { error: (message: string) => void },
	reason: string,
): Promise<void> {
	try {
		await adapter.delete({
			model: SUBSCRIPTION_MODEL,
			where: [
				{ field: "id", value: rowId },
				{ field: "status", value: "incomplete" },
			],
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`${reason}: failed to release reserved subscription row=${rowId}: ${message}`);
	}
}

/**
 * R1/R2 → R3. The CAS matches the slot and link this caller observed, so a link persisted
 * concurrently (or a takeover by another writer) makes the release lose instead of orphaning it.
 */
async function releaseReservation(args: {
	client: StreamPayClient;
	adapter: PluginAdapter;
	holder: Subscription;
	deactivation: LinkDeactivation;
	log: ReservationLog;
}): Promise<boolean> {
	const { client, adapter, holder, deactivation, log } = args;
	const linkId = holder.streampayPaymentLinkId;
	if (linkId && deactivation !== "skip") {
		try {
			await deactivatePaymentLink(client, linkId, log);
		} catch (err) {
			if (deactivation === "required") throw new LinkDeactivationError(linkId, err);
			const message = err instanceof Error ? err.message : String(err);
			log.error(
				`payment link=${linkId} of released row=${holder.id} could not be deactivated and may still be paid; deactivate it manually: ${message}`,
			);
		}
	}
	const released = await adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		update: { status: "incomplete_expired", activeSlotKey: null, updatedAt: new Date() },
		where: [
			{ field: "id", value: holder.id },
			{ field: "status", value: "incomplete" },
			{ field: "activeSlotKey", value: holder.activeSlotKey ?? null },
			{ field: "streampayPaymentLinkId", value: linkId ?? null },
		],
	});
	return released !== null;
}

/** Releases a reservation for a replacement checkout, or fails the request with a mapped error. */
async function releaseForReplacement(
	client: StreamPayClient,
	adapter: PluginAdapter,
	holder: Subscription,
	deactivation: Exclude<LinkDeactivation, "best-effort">,
	log: ReservationLog,
): Promise<void> {
	let released: boolean;
	try {
		released = await releaseReservation({ client, adapter, holder, deactivation, log });
	} catch (err) {
		if (!(err instanceof LinkDeactivationError)) throw err;
		toAPIError(
			{
				logPrefix: `deactivate stale checkout link=${err.linkId} failed for row=${holder.id}:`,
				userMessage: "Unable to replace the previous subscription checkout.",
			},
			err.cause,
			log,
		);
	}
	if (!released) throw checkoutInProgressError();
}

async function resumeCheckout(
	client: StreamPayClient,
	row: Subscription,
	log: ReservationLog,
	logPrefix: string,
): Promise<Awaited<ReturnType<typeof recoverCheckoutUrl>>> {
	try {
		return await recoverCheckoutUrl(client, row);
	} catch (err) {
		toAPIError(
			{
				logPrefix: `${logPrefix} for row=${row.id}:`,
				userMessage: "Unable to resume subscription checkout.",
			},
			err,
			log,
		);
	}
}

/** C-a, C-e, C-f, C-g, C-h and C-k: reuse a live checkout for the same plan and seats, or reserve. */
export async function resumeOrReserveCheckoutSlot(args: {
	client: StreamPayOptions["client"];
	adapter: PluginAdapter;
	candidates: readonly Subscription[];
	createReservation: () => Promise<{
		data: Omit<Subscription, "id">;
		consumerId: string;
	}>;
	activeSlotKey: string;
	planName: string;
	seats: number;
	now: number;
	log: ReservationLog;
}): Promise<
	| { kind: "recovered"; row: Subscription; url: string }
	| { kind: "reserved"; row: Subscription; consumerId: string }
> {
	const { client, adapter, candidates, activeSlotKey, planName, seats, now, log } = args;
	const matchesCheckout = (row: Subscription) =>
		row.plan === planName && (row.seats ?? 1) === seats;
	const reuseCandidate = candidates.find(
		(row) =>
			matchesCheckout(row) &&
			row.status === "incomplete" &&
			Boolean(row.streampayPaymentLinkId) &&
			row.createdAt instanceof Date &&
			now - row.createdAt.getTime() < UPGRADE_IDEMPOTENCY_WINDOW_MS,
	);
	if (reuseCandidate) {
		const recovery = await resumeCheckout(
			client,
			reuseCandidate,
			log,
			"resume subscription checkout failed",
		);
		if (recovery.kind === "recovered") {
			return { kind: "recovered", row: reuseCandidate, url: recovery.url };
		}
		await releaseForReplacement(client, adapter, reuseCandidate, "skip", log);
	}

	const { data: reservationData, consumerId } = await args.createReservation();
	let row: Subscription;
	try {
		row = await adapter.create<Subscription>({
			model: SUBSCRIPTION_MODEL,
			data: reservationData,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		const reserved = await adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [{ field: "activeSlotKey", value: activeSlotKey }],
		});
		if (!reserved) throw err;
		if (reserved.status !== "incomplete") throw subscriptionAlreadyActiveError();

		const reservationIsStale =
			!(reserved.createdAt instanceof Date) ||
			now - reserved.createdAt.getTime() >= UPGRADE_IDEMPOTENCY_WINDOW_MS;
		let linkExpired = false;
		if (!reservationIsStale && matchesCheckout(reserved)) {
			const recovery = await resumeCheckout(
				client,
				reserved,
				log,
				"resume concurrent subscription checkout failed",
			);
			if (recovery.kind === "recovered") {
				return { kind: "recovered", row: reserved, url: recovery.url };
			}
			linkExpired = Boolean(reserved.streampayPaymentLinkId);
		}
		if (!reservationIsStale && !linkExpired) throw checkoutInProgressError();
		// A link that expired inside the window is already unpayable; a stale one must be deactivated.
		await releaseForReplacement(
			client,
			adapter,
			reserved,
			reservationIsStale ? "required" : "skip",
			log,
		);

		try {
			row = await adapter.create<Subscription>({
				model: SUBSCRIPTION_MODEL,
				data: reservationData,
			});
		} catch (retryError) {
			if (!isUniqueConstraintError(retryError)) throw retryError;
			throw checkoutInProgressError();
		}
		log.warn(`released stale checkout reservation row=${reserved.id} for plan=${planName}.`);
	}
	return { kind: "reserved", row, consumerId };
}

/**
 * C-b, C-d and C-i: records the payment link created for a reservation and returns the
 * subscription row to report. A link without a URL can never be paid, so its reservation is
 * released on the spot. A reservation that was released while the link was being created gets
 * its new link deactivated, and the request fails so the customer is never sent to pay it (C3).
 */
export async function attachCheckoutLink(args: {
	client: StreamPayClient;
	adapter: PluginAdapter;
	reservation: Subscription;
	consumerId: string;
	link: { id: string; url: string | null };
	log: ReservationLog;
}): Promise<{ subscriptionId: string; url: string }> {
	const { client, adapter, reservation, consumerId, link, log } = args;
	if (!link.url) {
		log.error(`createPaymentLink returned link=${link.id} with no url.`);
		try {
			await adapter.update({
				model: SUBSCRIPTION_MODEL,
				update: {
					streampayPaymentLinkId: link.id,
					status: "incomplete_expired",
					activeSlotKey: null,
					updatedAt: new Date(),
				},
				where: [
					{ field: "id", value: reservation.id },
					{ field: "status", value: "incomplete" },
					{ field: "streampayConsumerId", value: consumerId },
				],
			});
		} catch (persistenceError) {
			const message =
				persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
			log.error(
				`failed to mark unusable payment link=${link.id} expired for row=${reservation.id}: ${message}`,
			);
			await deleteReservedSubscription(
				adapter,
				reservation.id,
				log,
				"unusable payment link cleanup",
			);
		}
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "Payment link was created but no URL was returned.",
		});
	}

	let attached: Subscription | null = null;
	try {
		// No status match: the returned row must reveal a release that happened meanwhile.
		attached = await adapter.update<Subscription>({
			model: SUBSCRIPTION_MODEL,
			update: { streampayPaymentLinkId: link.id, updatedAt: new Date() },
			where: [
				{ field: "id", value: reservation.id },
				{ field: "referenceId", value: reservation.referenceId },
				{ field: "referenceType", value: reservation.referenceType },
				{ field: "streampayConsumerId", value: consumerId },
				{ field: "streampayPaymentLinkId", value: null },
			],
		});
	} catch (persistenceError) {
		const message =
			persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
		log.error(
			`failed to persist payment link=${link.id} for row=${reservation.id}: ${message}. Protected checkout metadata will reconcile the row from the webhook.`,
		);
	}
	if (attached?.status === "incomplete_expired") {
		log.warn(
			`checkout reservation row=${reservation.id} was released while payment link=${link.id} was created; deactivating the link.`,
		);
		try {
			await deactivatePaymentLink(client, link.id, log);
		} catch (deactivationError) {
			toAPIError(
				{
					logPrefix: `deactivate orphaned checkout link=${link.id} failed for row=${reservation.id}:`,
					userMessage: "Failed to start subscription checkout.",
				},
				deactivationError,
				log,
			);
		}
		throw checkoutInProgressError();
	}
	return { subscriptionId: attached?.id ?? reservation.id, url: link.url };
}

/**
 * C-j and S4: a provider-confirmed subscription outranks an unpaid checkout reservation for the
 * same slot. Two live subscriptions in one slot are never merged silently.
 *
 * @throws SubscriptionCorrelationError when a live subscription already holds the slot.
 */
export async function yieldReservationToPaidSubscription(args: {
	client: StreamPayClient;
	adapter: PluginAdapter;
	slotKey: string;
	ownerRowId: string | null;
	streampaySubscriptionId: string;
	log: ReservationLog;
}): Promise<void> {
	const { client, adapter, slotKey, ownerRowId, streampaySubscriptionId, log } = args;
	const holder = await adapter.findOne<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [{ field: "activeSlotKey", value: slotKey }],
	});
	if (!holder || holder.id === ownerRowId) return;
	if (holder.streampaySubscriptionId === streampaySubscriptionId) {
		throw new Error(
			`StreamPay sub=${streampaySubscriptionId} was linked to row=${holder.id} concurrently. Retry delivery.`,
		);
	}
	if (holder.status !== "incomplete" || holder.streampaySubscriptionId) {
		throw new SubscriptionCorrelationError(
			`StreamPay sub=${streampaySubscriptionId} needs the billing slot held by live row=${holder.id} (${holder.status}). Resolve the duplicate subscription, then replay.`,
		);
	}
	const released = await releaseReservation({
		client,
		adapter,
		holder,
		deactivation: "best-effort",
		log,
	});
	if (!released) {
		throw new Error(`Checkout reservation row=${holder.id} changed while releasing its slot.`);
	}
	log.warn(
		`released checkout reservation row=${holder.id} for paid StreamPay sub=${streampaySubscriptionId}.`,
	);
}
