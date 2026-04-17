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
 * Minimal logger-only context shape shared by both the signup hooks and
 * the lazy `ensureConsumerForUser` path. `StreamPayHookContext` in
 * `src/hooks/consumer.ts` and `EnsureConsumerContext` below both
 * satisfy this structurally.
 */
export interface StreamPayLoggerContext {
	context: {
		logger: {
			error: (message: string) => void;
		};
	};
}

/**
 * The narrow context shape `ensureConsumerForUser` needs: a logger and
 * Better Auth's `internalAdapter.updateUser` so the newly-linked
 * `streampayConsumerId` can be written back to the user row.
 *
 * Both `GenericEndpointContext` (from Better Auth's endpoint handlers)
 * and the project's `MockCtx` are structurally assignable here — we
 * deliberately do not import Better Auth's type to keep tests type-safe
 * without a cast.
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
 * Uses the `in` operator narrowing only — no casts, no `any`. Mirrors
 * `formatStreamPayError`'s shape-reading style.
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
 * After a `DUPLICATE_CONSUMER` error, locate the existing consumer and
 * decide whether it is safe to reuse. Returns the id to reuse, or
 * `null` if the caller should fall through to the generic error path.
 *
 * Shared between the signup `before` hook and the lazy
 * `ensureConsumerForUser` path so behavior stays identical — a change
 * to the claim logic applies everywhere a consumer is provisioned.
 */
export async function resolveDuplicateConsumer(
	options: StreamPayOptions,
	createPayload: ConsumerCreate,
	context: StreamPayLoggerContext,
): Promise<string | null> {
	const emailMatch = createPayload.email
		? await findConsumerByIdentifiers(options.client, {
				email: createPayload.email,
			})
		: null;
	const phoneMatch =
		!emailMatch && createPayload.phone_number
			? await findConsumerByIdentifiers(options.client, {
					phone_number: createPayload.phone_number,
				})
			: null;

	const identifiers: ConsumerIdentifiers = {
		email: createPayload.email ?? null,
		phone_number: createPayload.phone_number ?? null,
		external_id: createPayload.external_id ?? null,
		iban: createPayload.iban ?? null,
	};

	const existing =
		emailMatch ?? phoneMatch ?? (await findConsumerByIdentifiers(options.client, identifiers));
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
 * Lazy/on-demand consumer provisioning used by checkout and
 * subscription mutations when `createConsumerOnSignUp` is off (or when
 * a legacy user predates the hook).
 *
 * Flow:
 *   1. Short-circuit if `user.streampayConsumerId` is already set.
 *   2. Recover: scan by `external_id === user.id` for a consumer that
 *      was created previously but whose id never made it to the user
 *      row (crash between create and updateUser, for example).
 *   3. Create the consumer with `external_id: user.id`.
 *   4. On `DUPLICATE_CONSUMER` fall through to `resolveDuplicateConsumer`,
 *      which decides reuse-vs-reject with the same rules as sign-up.
 *   5. Persist `streampayConsumerId` on the user row. A failure here is
 *      logged but not fatal — the consumer exists, and the next call
 *      will rediscover it via the external_id recovery scan.
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

	const recovered = await findConsumerByExternalId(options.client, { externalId: user.id });
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
				await persistConsumerId(ctx, user.id, reusedId);
				return { consumerId: reusedId, created: false };
			}
		}

		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: `StreamPay consumer creation failed: ${formatStreamPayError(err)}`,
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
