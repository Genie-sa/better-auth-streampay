import type { ConsumerCreate, ConsumerUpdate } from "@streamsdk/typescript";
import type { User } from "better-auth";
import { APIError } from "better-auth/api";
import type { StreamPayOptions } from "../types";
import {
	isDuplicateConsumerError,
	isNotFoundError,
	resolveDuplicateConsumer,
	type StreamPayLoggerContext,
} from "../utils/ensure-consumer";
import { formatStreamPayError } from "../utils/format-error";
import { asSessionUser } from "../utils/session";

/**
 * Structural supertype of Better Auth's `GenericEndpointContext` used
 * by the plugin's hooks. Only `context.logger` is read here — the
 * before-hook injects `streampayConsumerId` via its return value, so
 * `internalAdapter.updateUser` is not on the hook path.
 */
export type StreamPayHookContext = StreamPayLoggerContext;

const isAnonymous = (user: User | Partial<User>): boolean =>
	"isAnonymous" in user && user.isAnonymous === true;

/**
 * Narrow context shape for hooks that write back to the user row via
 * `internalAdapter.updateUser` (currently just `onUserUpdate`'s
 * self-heal path).
 */
type StreamPayMutableHookContext = StreamPayHookContext & {
	context: {
		internalAdapter: {
			updateUser: (userId: string, data: Record<string, unknown>) => Promise<unknown>;
		};
	};
};

function hasInternalAdapter(ctx: StreamPayHookContext): ctx is StreamPayMutableHookContext {
	return (
		"internalAdapter" in ctx.context &&
		ctx.context.internalAdapter !== null &&
		typeof ctx.context.internalAdapter === "object" &&
		"updateUser" in ctx.context.internalAdapter &&
		typeof ctx.context.internalAdapter.updateUser === "function"
	);
}

/**
 * Runs before Better Auth writes the user row. Creates the StreamPay
 * consumer first and injects its id via the returned `{ data }` — if
 * the create throws, the sign-up is aborted before any user row is
 * committed. That ordering is the structural fix for the two-system
 * atomicity problem: there's no cross-system transaction, so the only
 * way to make sign-up atomic is to fail before the row is written.
 *
 * The consumer is created WITHOUT `external_id` because Better Auth
 * generates the user id inside `adapter.create()`, which runs AFTER
 * this hook — `onAfterUserCreate` patches `external_id` back in.
 *
 * Duplicate handling: on `DUPLICATE_CONSUMER`, `resolveDuplicateConsumer`
 * looks up the existing consumer and decides reuse-vs-reject using
 * `claimExistingConsumerBy`. Stranded consumers (no `external_id`)
 * are always safe to reuse; same-user is idempotent; a linked
 * consumer for a different user is refused — silently reusing would
 * hand one account access to another's billing history.
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

			// Log the detailed upstream failure; surface a generic user-
			// facing message so SDK error strings (which may include other
			// users' identifiers via `DUPLICATE_CONSUMER`'s
			// `additional_info`) cannot reach the response body.
			context.context.logger.error(
				`StreamPay consumer creation failed for user=${user.id ?? "<pre-insert>"}: ${formatStreamPayError(err)}`,
			);
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "StreamPay consumer provisioning failed. Please try again.",
			});
		}
	};

/**
 * Runs after the user row is written. Back-links the consumer created
 * in `onBeforeUserCreate` to the Better Auth user id via `external_id`.
 * Failures here log and return — the user row is already committed,
 * so throwing would surface as a 500 after successful sign-up and
 * desync the two systems. The missing `external_id` is not on any hot
 * path (update/delete hooks key off `streampayConsumerId` on the row).
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
				`StreamPay consumer external_id link failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
			);
		}
	};

/**
 * Sync profile updates to the StreamPay consumer. Runs for any user
 * with a linked `streampayConsumerId` — independent of the
 * `createConsumerOnSignUp` flag.
 *
 * Fetch-diff-update: we GET the remote consumer first and only call
 * `updateConsumer` when `email`/`name` actually differ. Better Auth
 * runs this hook on every user-row mutation (image/emailVerified/etc.
 * too), so a blind PATCH would send no-op writes on every edit.
 *
 * Self-heal: if `getConsumer` returns 404, the consumer was deleted
 * out-of-band (admin action, test cleanup). We clear
 * `streampayConsumerId` from the user row so the next checkout
 * re-provisions via the lazy path — otherwise the stale id would
 * re-404 forever on every profile edit.
 */
export const onUserUpdate =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser?.streampayConsumerId) return;

		try {
			const remote = await options.client.getConsumer(sessionUser.streampayConsumerId);

			// Soft-deleted remote: skip the PATCH. We don't clear the
			// link here — the soft-delete may be reversible on
			// StreamPay's side, and re-provisioning would create a new
			// row that orphans the original relationship.
			if (remote.is_deleted === true) return;

			const patch: ConsumerUpdate = {};
			if (sessionUser.name !== undefined && remote.name !== sessionUser.name) {
				patch.name = sessionUser.name;
			}
			if (sessionUser.email !== undefined && remote.email !== sessionUser.email) {
				patch.email = sessionUser.email;
			}

			if (Object.keys(patch).length === 0) return;

			await options.client.updateConsumer(sessionUser.streampayConsumerId, patch);
		} catch (err: unknown) {
			if (isNotFoundError(err)) {
				context.context.logger.error(
					`StreamPay consumer ${sessionUser.streampayConsumerId} not found for user=${sessionUser.id}; clearing stale link for re-provisioning.`,
				);
				if (hasInternalAdapter(context)) {
					try {
						await context.context.internalAdapter.updateUser(sessionUser.id, {
							streampayConsumerId: null,
						});
					} catch (clearErr: unknown) {
						context.context.logger.error(
							`StreamPay stale-link clear failed for user=${sessionUser.id}: ${formatStreamPayError(clearErr)}`,
						);
					}
				}
				return;
			}
			context.context.logger.error(
				`StreamPay consumer update failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
			);
		}
	};

/**
 * Delete the StreamPay consumer when a Better Auth user is removed.
 * Same gating as `onUserUpdate`: fires whenever a linked consumer
 * exists, independent of `createConsumerOnSignUp`. Logs on failure
 * rather than throwing — the user row is already deleted by the time
 * we run.
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
				`StreamPay consumer delete failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
			);
		}
	};
