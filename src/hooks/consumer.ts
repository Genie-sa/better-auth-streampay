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
import { getLogger } from "../utils/logger";
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

			getLogger(context).error(
				`consumer creation failed for user=${user.id ?? "<pre-insert>"}: ${formatStreamPayError(err)}`,
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
			getLogger(context).error(
				`consumer external_id link failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
			);
		}
	};

export const onUserUpdate =
	(options: StreamPayOptions) =>
	async (user: User, context: StreamPayHookContext | null): Promise<void> => {
		if (!context) return;
		if (isAnonymous(user)) return;

		const sessionUser = asSessionUser(user);
		if (!sessionUser?.streampayConsumerId) return;

		try {
			const remote = await options.client.getConsumer(sessionUser.streampayConsumerId);

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
				getLogger(context).error(
					`consumer ${sessionUser.streampayConsumerId} not found for user=${sessionUser.id}; clearing stale link for re-provisioning.`,
				);
				if (hasInternalAdapter(context)) {
					try {
						await context.context.internalAdapter.updateUser(sessionUser.id, {
							streampayConsumerId: null,
						});
					} catch (clearErr: unknown) {
						getLogger(context).error(
							`stale-link clear failed for user=${sessionUser.id}: ${formatStreamPayError(clearErr)}`,
						);
					}
				}
				return;
			}
			getLogger(context).error(
				`consumer update failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
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
			if (isNotFoundError(err)) return;
			getLogger(context).error(
				`consumer delete failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${formatStreamPayError(err)}`,
			);
		}
	};
