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
} from "../utils/consumer";
import { formatStreamPayError } from "../utils/format-error";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

/**
 * The narrow context shape the plugin's hooks actually read. Declared
 * as a structural supertype of Better Auth's `GenericEndpointContext`
 * so tests can pass a `MockCtx` without any cast.
 *
 * The hooks only need a logger now — consumer creation moved to the
 * `before` hook and injects `streampayConsumerId` into the row via the
 * hook's return value, so we no longer call `internalAdapter.updateUser`
 * from the `after` hook.
 */
export interface StreamPayHookContext {
	context: {
		logger: {
			error: (message: string) => void;
		};
	};
}

const isAnonymous = (user: User | Partial<User>): boolean =>
	"isAnonymous" in user && user.isAnonymous === true;

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.trim() === b.trim();
}

function canClaimBy(
	mode: ClaimExistingConsumerBy | undefined,
	identifier: ClaimExistingConsumerIdentifier,
): boolean {
	if (mode === "both") return true;
	return mode === identifier;
}

/**
 * Runs before Better Auth writes the user row. Creates the StreamPay
 * consumer FIRST and injects its id into the row by returning
 * `{ data: { streampayConsumerId } }` — Better Auth merges this into
 * the insert data (see `better-auth/dist/db/with-hooks.mjs:18`).
 *
 * Why it's here and not in `after`: if consumer creation throws, this
 * hook aborts the sign-up before any user row is committed. No orphan
 * row can exist. This is the structural fix for the two-system atomicity
 * problem — there is no cross-system transaction, so the only way to
 * make sign-up atomic is to fail before the row is written.
 *
 * The consumer is created WITHOUT `external_id` because Better Auth
 * generates the user id inside `adapter.create()`, which runs after
 * this hook. `onAfterUserCreate` patches the `external_id` back in.
 *
 * Duplicate handling (optimistic-create):
 *   1. Try `createConsumer` — the O(1) happy path.
 *   2. If StreamPay rejects with `DUPLICATE_CONSUMER`, paginate and
 *      find the existing consumer by any of the identifiers we sent.
 *   3. If the existing consumer is stranded (`external_id` unset),
 *      safe to reuse — return its id, the after-hook will link it.
 *   4. If reclaim is enabled for the matching identifier (email, phone,
 *      or both), reuse its id and overwrite `external_id` in the
 *      after-hook.
 *   5. Otherwise, if it's already linked to another user
 *      (`external_id` set and not equal to this user's id), refuse.
 *      Silently reusing would hand user A access to user B's billing
 *      history.
 */
export const onBeforeUserCreate =
	(options: StreamPayOptions) =>
	async (
		user: Partial<User>,
		context: StreamPayHookContext | null,
	): Promise<{ data: { streampayConsumerId: string } } | undefined> => {
		if (!context || !options.createConsumerOnSignUp) return undefined;
		if (isAnonymous(user)) return undefined;

		if (!user.email) {
			throw new APIError("BAD_REQUEST", {
				message: "StreamPay requires an email address to create a consumer.",
			});
		}

		const extras = options.getConsumerCreateParams
			? await options.getConsumerCreateParams({ user })
			: {};

		// `||` treats empty string as "not set", which `??` would not.
		const createPayload: ConsumerCreate = {
			name: user.name || user.email,
			email: user.email,
			...extras,
		};

		try {
			const consumer = await options.client.createConsumer(createPayload);
			if (!consumer.id) {
				throw new APIError("INTERNAL_SERVER_ERROR", {
					message: "StreamPay consumer was created but did not return an id.",
				});
			}
			return { data: { streampayConsumerId: consumer.id } };
		} catch (err: unknown) {
			if (err instanceof APIError) throw err;

			if (isDuplicateConsumerError(err)) {
				const reusedId = await resolveDuplicateConsumer(options, createPayload, context);
				if (reusedId) {
					return { data: { streampayConsumerId: reusedId } };
				}
			}

			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: `StreamPay consumer creation failed: ${formatStreamPayError(err)}`,
			});
		}
	};

/**
 * Narrow an unknown error to a StreamPay `DUPLICATE_CONSUMER` response.
 * Uses `in` operator narrowing only — no casts, no `any`. Mirrors the
 * style in `src/utils/format-error.ts`.
 */
function isDuplicateConsumerError(err: unknown): boolean {
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
 */
async function resolveDuplicateConsumer(
	options: StreamPayOptions,
	createPayload: ConsumerCreate,
	context: StreamPayHookContext,
): Promise<string | null> {
	// Prefer exact identifier matches in a stable order so the chosen
	// reclaim mode doesn't get blocked by an earlier match on a different
	// identifier.
	const emailMatch =
		createPayload.email
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
	if (!existing?.id) {
		// StreamPay said duplicate but the scan missed — paging gap, race, or
		// soft-delete weirdness. Fall through so the caller surfaces the
		// original error instead of silently succeeding.
		return null;
	}

	if (existing.external_id) {
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

		// Linked to another Better Auth user — reusing would mean inheriting
		// their billing history. Refuse with a generic message (avoid
		// user-enumeration via "another account exists at this email").
		context.context.logger.error(
			`StreamPay duplicate: consumer ${existing.id} is already linked to external_id=${existing.external_id}`,
		);
		throw new APIError("CONFLICT", {
			message: "This account cannot be created at this time. Please contact support.",
		});
	}

	// Stranded consumer — safe to reuse. The after-hook will patch
	// external_id onto it once Better Auth has assigned a user.id.
	return existing.id;
}

/**
 * Runs after the user row is written. Back-links the StreamPay consumer
 * created by `onBeforeUserCreate` to the Better Auth user id via
 * `external_id`. Failures here are logged but never thrown — the user
 * row is already committed by the time this runs, and a throw would
 * surface as a 500 after a successful sign-up, which is worse than
 * leaving the consumer temporarily unlinked. Subsequent hook runs
 * (update/delete) resolve the consumer via the id stored on the row, so
 * the missing `external_id` is not on any hot path; the reconciliation
 * is still reachable via `findConsumerByExternalId` for legacy users.
 */
export const onAfterUserCreate =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context || !options.createConsumerOnSignUp) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser?.streampayConsumerId) return;

		try {
			await options.client.updateConsumer(sessionUser.streampayConsumerId, {
				external_id: sessionUser.id,
			});
		} catch (err: unknown) {
			context.context.logger.error(
				`StreamPay consumer external_id link failed: ${formatStreamPayError(err)}`,
			);
		}
	};

/**
 * Sync profile updates to the StreamPay consumer. Failures log only —
 * the Better Auth user update has already committed by the time we run,
 * so throwing would desync the two systems.
 */
export const onUserUpdate =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context || !options.createConsumerOnSignUp) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser) return;

		const consumerId = await resolveConsumerId(options, sessionUser);
		if (!consumerId) return;

		// Build the update payload conditionally so we don't send explicit
		// `undefined` for fields the user didn't set — `exactOptionalPropertyTypes`
		// rejects that, and StreamPay treats missing fields as "don't change".
		const update: Parameters<typeof options.client.updateConsumer>[1] = {};
		if (sessionUser.name !== undefined) update.name = sessionUser.name;
		if (sessionUser.email !== undefined) update.email = sessionUser.email;

		try {
			await options.client.updateConsumer(consumerId, update);
		} catch (err: unknown) {
			context.context.logger.error(
				`StreamPay consumer update failed: ${formatStreamPayError(err)}`,
			);
		}
	};

/**
 * Delete the StreamPay consumer when a Better Auth user is removed.
 * Also logs on failure rather than throwing, for the same commit-order
 * reason as `onUserUpdate`.
 */
export const onUserDelete =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context || !options.createConsumerOnSignUp) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser) return;

		const consumerId = await resolveConsumerId(options, sessionUser);
		if (!consumerId) return;

		try {
			await options.client.deleteConsumer(consumerId);
		} catch (err: unknown) {
			context.context.logger.error(
				`StreamPay consumer delete failed: ${formatStreamPayError(err)}`,
			);
		}
	};

async function resolveConsumerId(
	options: StreamPayOptions,
	user: StreamPaySessionUser,
): Promise<string | null> {
	if (user.streampayConsumerId) return user.streampayConsumerId;
	return findConsumerByExternalId(options.client, { externalId: user.id });
}
