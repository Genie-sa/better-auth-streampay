import type { ConsumerCreate } from "@streamsdk/typescript";
import type { User } from "better-auth";
import { APIError } from "better-auth/api";
import type {
	ClaimExistingConsumerBy,
	ClaimExistingConsumerIdentifier,
	StreamPayOptions,
} from "../types";
import {
	type ConsumerIdentifiers,
	findConsumerByExternalId,
	findConsumerByIdentifiers,
} from "./consumer";
import { formatStreamPayError } from "./format-error";
import type { StreamPaySessionUser } from "./session";

/**
 * Default cap for fallback list-based lookups. Tied to StreamPay's
 * 100-item page ceiling — 100 pages = 10,000 items per scan, a
 * generous ceiling that covers large orgs without tuning while still
 * bounding worst-case latency. Exposed as a knob via
 * `StreamPayOptions.consumerLookupMaxPages`.
 */
export const DEFAULT_CONSUMER_LOOKUP_MAX_PAGES = 100;

/**
 * Resolve the page cap for list-based lookups. Accepts the caller's
 * option, a per-callsite override, or the default — and clamps the
 * result to at least 1 integer. A `0`, negative, or non-integer value
 * from user config would otherwise break pagination silently
 * (0-iteration loop or `NaN` comparisons).
 */
export function resolveConsumerLookupMaxPages(
	options: Pick<StreamPayOptions, "consumerLookupMaxPages">,
	override?: number,
): number {
	const raw = override ?? options.consumerLookupMaxPages ?? DEFAULT_CONSUMER_LOOKUP_MAX_PAGES;
	const coerced = Math.floor(Number(raw));
	return Number.isFinite(coerced) ? Math.max(1, coerced) : DEFAULT_CONSUMER_LOOKUP_MAX_PAGES;
}

/**
 * Minimal logger-only context shape shared by the signup hooks and
 * `ensureConsumerForUser`. Structurally satisfied by
 * `StreamPayHookContext` and `EnsureConsumerContext` below.
 */
export interface StreamPayLoggerContext {
	context: {
		logger: {
			error: (message: string) => void;
		};
	};
}

/**
 * Context shape `ensureConsumerForUser` needs: a logger and Better
 * Auth's `internalAdapter.updateUser` so the newly-linked
 * `streampayConsumerId` can be written back to the user row. Both
 * `GenericEndpointContext` and the project's `MockCtx` satisfy this
 * structurally.
 */
export interface EnsureConsumerContext extends StreamPayLoggerContext {
	context: StreamPayLoggerContext["context"] & {
		internalAdapter: {
			updateUser: (userId: string, data: Record<string, unknown>) => Promise<unknown>;
		};
	};
}

export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.trim() === b.trim();
}

export function canClaimBy(
	mode: ClaimExistingConsumerBy | undefined,
	identifier: ClaimExistingConsumerIdentifier,
): boolean {
	return mode?.includes(identifier) ?? false;
}

/**
 * Narrow an unknown error to a StreamPay `DUPLICATE_CONSUMER` response.
 * `in` operator narrowing only — no casts, no `any`.
 */
export function isDuplicateConsumerError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (!("body" in err)) return false;
	const { body } = err;
	if (!body || typeof body !== "object") return false;
	if (!("error" in body) || !body.error || typeof body.error !== "object") {
		return false;
	}
	const error = body.error;
	return "code" in error && typeof error.code === "string" && error.code === "DUPLICATE_CONSUMER";
}

/**
 * Narrow an unknown error to an HTTP 404 Not Found from the StreamPay
 * SDK. The SDK decorates its errors with a numeric `status` property
 * (see `mockApiError` in tests/utils/helpers.ts for the full shape).
 * Used by hooks that need to self-heal when a remote consumer was
 * deleted out-of-band.
 */
export function isNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (!("status" in err)) return false;
	return typeof err.status === "number" && err.status === 404;
}

/**
 * After a `DUPLICATE_CONSUMER` error, locate the existing consumer and
 * decide whether it is safe to reuse. Returns the id to reuse, or
 * `null` if the caller should fall through to the generic error path.
 * Shared between the signup hook and the lazy path so claim rules stay
 * in lockstep.
 */
export async function resolveDuplicateConsumer(
	options: StreamPayOptions,
	createPayload: ConsumerCreate,
	context: StreamPayLoggerContext,
): Promise<string | null> {
	const maxPages = resolveConsumerLookupMaxPages(options);
	const emailMatch = createPayload.email
		? await findConsumerByIdentifiers(
				options.client,
				{ email: createPayload.email },
				{ maxPages },
			)
		: null;
	const phoneMatch =
		!emailMatch && createPayload.phone_number
			? await findConsumerByIdentifiers(
					options.client,
					{ phone_number: createPayload.phone_number },
					{ maxPages },
				)
			: null;

	const identifiers: ConsumerIdentifiers = {
		email: createPayload.email ?? null,
		phone_number: createPayload.phone_number ?? null,
		external_id: createPayload.external_id ?? null,
		iban: createPayload.iban ?? null,
	};

	const existing =
		emailMatch ??
		phoneMatch ??
		(await findConsumerByIdentifiers(options.client, identifiers, { maxPages }));
	if (!existing?.id) return null;

	if (existing.external_id) {
		// Same-user re-provision is always safe (idempotent).
		if (
			createPayload.external_id &&
			existing.external_id === createPayload.external_id
		) {
			return existing.id;
		}
		if (
			canClaimBy(options.claimExistingConsumerBy, "email") &&
			sameEmail(existing.email, createPayload.email)
		) {
			return existing.id;
		}
		if (
			canClaimBy(options.claimExistingConsumerBy, "phone") &&
			samePhone(existing.phone_number, createPayload.phone_number)
		) {
			return existing.id;
		}

		context.context.logger.error(
			`StreamPay duplicate: consumer ${existing.id} is already linked to external_id=${existing.external_id}`,
		);
		throw new APIError("CONFLICT", {
			message: "This account cannot be created at this time. Please contact support.",
		});
	}

	// Stranded consumer — safe to reuse.
	return existing.id;
}

/**
 * Lazy/on-demand consumer provisioning used by checkout when
 * `createConsumerOnSignUp` is off (or when a legacy user predates the
 * hook). Short-circuits on the already-linked case; otherwise tries
 * recovery-scan → create → duplicate-resolve → persist.
 *
 * Race safety: two concurrent callers race through create; the loser
 * gets `DUPLICATE_CONSUMER`, falls through to lookup, finds the same
 * consumer, both writers converge on the same id.
 */
export async function ensureConsumerForUser(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	user: StreamPaySessionUser,
): Promise<{ consumerId: string; created: boolean }> {
	if (user.streampayConsumerId) {
		return { consumerId: user.streampayConsumerId, created: false };
	}

	const maxPages = resolveConsumerLookupMaxPages(options);
	const recovered = await findConsumerByExternalId(options.client, {
		externalId: user.id,
		maxPages,
	});
	if (recovered) {
		await persistConsumerId(ctx, user.id, recovered);
		return { consumerId: recovered, created: false };
	}

	if (!user.email) {
		throw new APIError("BAD_REQUEST", {
			message: "StreamPay requires an email address to create a consumer.",
		});
	}

	const userForParams: Partial<User> = { id: user.id, email: user.email };
	if (user.name !== undefined) userForParams.name = user.name;

	const extras = options.getConsumerCreateParams
		? await options.getConsumerCreateParams({ user: userForParams })
		: {};

	const payload: ConsumerCreate = {
		name: user.name || user.email,
		email: user.email,
		external_id: user.id,
		...extras,
	};

	try {
		const consumer = await options.client.createConsumer(payload);
		if (!consumer.id) {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "StreamPay consumer was created but did not return an id.",
			});
		}
		await persistConsumerId(ctx, user.id, consumer.id);
		return { consumerId: consumer.id, created: true };
	} catch (err: unknown) {
		if (err instanceof APIError) throw err;

		if (isDuplicateConsumerError(err)) {
			const reusedId = await resolveDuplicateConsumer(options, payload, ctx);
			if (reusedId) {
				// Back-fill external_id on the reused consumer so subsequent
				// recovery scans in `findConsumerByExternalId` can locate it
				// without falling through to another `createConsumer` +
				// `DUPLICATE_CONSUMER` round. Failure here is non-fatal — the
				// consumer is still usable; we just pay the list-scan cost
				// on the next cold call.
				try {
					await options.client.updateConsumer(reusedId, { external_id: user.id });
				} catch (backfillErr: unknown) {
					ctx.context.logger.error(
						`StreamPay consumer external_id backfill failed for user=${user.id} consumer=${reusedId}: ${formatStreamPayError(backfillErr)}`,
					);
				}
				await persistConsumerId(ctx, user.id, reusedId);
				return { consumerId: reusedId, created: false };
			}
		}

		// Log the detailed upstream failure server-side; surface a generic
		// message to the client so SDK error strings (which may include
		// other users' identifiers via DUPLICATE_CONSUMER's
		// `additional_info`) can never reach a response body.
		ctx.context.logger.error(
			`StreamPay consumer creation failed for user=${user.id}: ${formatStreamPayError(err)}`,
		);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "StreamPay consumer provisioning failed. Please try again.",
		});
	}
}

async function persistConsumerId(
	ctx: EnsureConsumerContext,
	userId: string,
	consumerId: string,
): Promise<void> {
	try {
		await ctx.context.internalAdapter.updateUser(userId, {
			streampayConsumerId: consumerId,
		});
	} catch (err: unknown) {
		// The consumer is live in StreamPay; a failed row write is
		// recoverable on the next call via `findConsumerByExternalId`.
		// Log-and-continue rather than 500-ing a successful checkout.
		ctx.context.logger.error(
			`StreamPay consumer link write failed for user=${userId}: ${formatStreamPayError(err)}`,
		);
	}
}
