import type { ConsumerCreate } from "@streamsdk/typescript";
import type { User } from "better-auth";
import { APIError } from "better-auth/api";
import type { StreamPayOptions } from "../types";
import {
	isDuplicateConsumerError,
	resolveDuplicateConsumer,
	type StreamPayLoggerContext,
} from "../utils/ensure-consumer";
import { formatStreamPayError } from "../utils/format-error";
import { asSessionUser } from "../utils/session";

/**
 * The narrow context shape the plugin's hooks actually read. Declared
 * as a structural supertype of Better Auth's `GenericEndpointContext`
 * so tests can pass a `MockCtx` without any cast.
 *
 * The hooks only need a logger here — consumer creation moved to the
 * `before` hook and injects `streampayConsumerId` into the row via the
 * hook's return value, so we no longer call `internalAdapter.updateUser`
 * from the `after` hook.
 */
export type StreamPayHookContext = StreamPayLoggerContext;

const isAnonymous = (user: User | Partial<User>): boolean =>
	"isAnonymous" in user && user.isAnonymous === true;

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
 *   4. If `claimExistingConsumerBy` lists the matching identifier
 *      (email and/or phone), reuse its id and overwrite `external_id`
 *      in the after-hook.
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
 * Sync profile updates to the StreamPay consumer. Runs for any user
 * with a linked `streampayConsumerId` — regardless of the
 * `createConsumerOnSignUp` flag. Eager-mode users were linked at
 * signup; lazy-mode users were linked at first checkout. Either way,
 * once the link exists we keep it in sync. Users with no link
 * (pre-first-payment in lazy mode, legacy pre-schema users) short-
 * circuit cheaply — no list-scan on the user-update hot path.
 *
 * Failures log only — the Better Auth user update has already
 * committed by the time we run, so throwing would desync the two
 * systems.
 */
export const onUserUpdate =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser?.streampayConsumerId) return;

		const update: Parameters<typeof options.client.updateConsumer>[1] = {};
		if (sessionUser.name !== undefined) update.name = sessionUser.name;
		if (sessionUser.email !== undefined) update.email = sessionUser.email;

		try {
			await options.client.updateConsumer(sessionUser.streampayConsumerId, update);
		} catch (err: unknown) {
			context.context.logger.error(
				`StreamPay consumer update failed: ${formatStreamPayError(err)}`,
			);
		}
	};

/**
 * Delete the StreamPay consumer when a Better Auth user is removed.
 * Same guard as `onUserUpdate`: fires whenever there is a linked
 * consumer, independent of the `createConsumerOnSignUp` flag. Also
 * logs on failure rather than throwing, for the same commit-order
 * reason as `onUserUpdate`.
 */
export const onUserDelete =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser?.streampayConsumerId) return;

		try {
			await options.client.deleteConsumer(sessionUser.streampayConsumerId);
		} catch (err: unknown) {
			context.context.logger.error(
				`StreamPay consumer delete failed: ${formatStreamPayError(err)}`,
			);
		}
	};
