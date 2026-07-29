import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayOptions } from "../../types";
import { readSdkErrorFields } from "../../utils/error-envelope";
import { toAPIError } from "../../utils/errors";
import type { PluginAdapter } from "./adapter";
import { isUniqueConstraintError } from "./sync";
import type { Subscription } from "./types";
import { UPGRADE_IDEMPOTENCY_WINDOW_MS } from "./types";

const SUBSCRIPTION_MODEL = "subscription";

export async function recoverCheckoutUrl(
	client: StreamPayOptions["client"],
	row: Pick<Subscription, "streampayPaymentLinkId">,
): Promise<{ kind: "recovered"; url: string } | { kind: "expired" }> {
	if (!row.streampayPaymentLinkId) return { kind: "expired" };
	try {
		const url = client.getPaymentUrl(await client.getPaymentLink(row.streampayPaymentLinkId));
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
			where: [{ field: "id", value: rowId }],
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`${reason}: failed to release reserved subscription row=${rowId}: ${message}`);
	}
}

export function checkoutInProgressError(): APIError {
	return new APIError("CONFLICT", {
		code: $ERROR_CODES.SUBSCRIPTION_CHECKOUT_IN_PROGRESS.code,
		message: "A subscription checkout is already being created for this plan group.",
	});
}

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
	log: { error: (message: string) => void; warn: (message: string) => void };
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
		let recovery: Awaited<ReturnType<typeof recoverCheckoutUrl>>;
		try {
			recovery = await recoverCheckoutUrl(client, reuseCandidate);
		} catch (err) {
			toAPIError(
				{
					logPrefix: `resume subscription checkout failed for row=${reuseCandidate.id}:`,
					userMessage: "Unable to resume subscription checkout.",
				},
				err,
				log,
			);
		}
		if (recovery.kind === "recovered") {
			return { kind: "recovered", row: reuseCandidate, url: recovery.url };
		}
		await adapter.update({
			model: SUBSCRIPTION_MODEL,
			update: { status: "incomplete_expired", activeSlotKey: null, updatedAt: new Date() },
			where: [{ field: "id", value: reuseCandidate.id }],
		});
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
		if (reserved?.status !== "incomplete") throw err;

		if (matchesCheckout(reserved)) {
			let recovery: Awaited<ReturnType<typeof recoverCheckoutUrl>>;
			try {
				recovery = await recoverCheckoutUrl(client, reserved);
			} catch (recoveryError) {
				toAPIError(
					{
						logPrefix: `resume concurrent subscription checkout failed for row=${reserved.id}:`,
						userMessage: "Unable to resume subscription checkout.",
					},
					recoveryError,
					log,
				);
			}
			if (recovery.kind === "recovered") {
				return { kind: "recovered", row: reserved, url: recovery.url };
			}
		}

		const reservationIsStale =
			!(reserved.createdAt instanceof Date) ||
			now - reserved.createdAt.getTime() >= UPGRADE_IDEMPOTENCY_WINDOW_MS;
		if (!reservationIsStale) throw checkoutInProgressError();

		const released = await adapter.update<Subscription>({
			model: SUBSCRIPTION_MODEL,
			update: { status: "incomplete_expired", activeSlotKey: null, updatedAt: new Date() },
			where: [
				{ field: "id", value: reserved.id },
				{ field: "activeSlotKey", value: activeSlotKey },
			],
		});
		if (!released) throw checkoutInProgressError();

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
