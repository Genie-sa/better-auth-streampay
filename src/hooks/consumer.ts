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

export type StreamPayHookContext = StreamPayLoggerContext;

const isAnonymous = (user: User | Partial<User>): boolean =>
	"isAnonymous" in user && user.isAnonymous === true;

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
 * Create the StreamPay consumer before Better Auth writes the user row
 * and inject the consumer id via `{ data }`. If creation throws, the
 * sign-up aborts before any user row is committed — the only way to make
 * two-system sign-up atomic without a cross-system transaction.
 *
 * `external_id` is patched on in `onAfterUserCreate` because Better Auth
 * generates `user.id` inside `adapter.create()`, which runs after this.
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

		// `||` so empty-string name falls through to email.
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

			// Generic user-facing message — SDK strings can contain other
			// users' identifiers via DUPLICATE_CONSUMER.additional_info.
			context.context.logger.error(
				`StreamPay consumer creation failed for user=${user.id ?? "<pre-insert>"}: ${formatStreamPayError(err)}`,
			);
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "StreamPay consumer provisioning failed. Please try again.",
			});
		}
	};

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
 * Sync profile changes to the linked StreamPay consumer. Fetch-diff-update:
 * Better Auth fires this on every row mutation (image, emailVerified, …),
 * so a blind PATCH would generate no-op remote writes. On 404 we clear
 * the stale link so the lazy path re-provisions.
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

			// Soft-delete may be reversible on StreamPay's side; don't
			// clear the link or a reversal would orphan it.
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
			// 404 = already gone; desired end state reached.
			if (isNotFoundError(err)) return;
			context.context.logger.error(
				`StreamPay consumer delete failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
			);
		}
	};
