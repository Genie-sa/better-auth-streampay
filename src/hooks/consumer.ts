import type { ConsumerCreate, ConsumerUpdate } from "@streamsdk/typescript";
import type { User } from "better-auth";
import { APIError } from "better-auth/api";
import type { StreamPayOptions } from "../types";
import {
	assertConsumerUnclaimed,
	type StreamPayLoggerContext,
	unlinkConsumer,
} from "../utils/consumer-link";
import {
	buildConsumerCreatePayload,
	isDuplicateConsumerError,
	isNotFoundError,
	resolveDuplicateConsumer,
} from "../utils/ensure-consumer";
import { summarizeStreamPayError } from "../utils/format-error";
import { getLogger } from "../utils/logger";
import { asSessionUser } from "../utils/session";

export type StreamPayHookContext = StreamPayLoggerContext;

const isAnonymous = (user: User | Partial<User>): boolean =>
	"isAnonymous" in user && user.isAnonymous === true;

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

		const createPayload: ConsumerCreate = await buildConsumerCreatePayload(options, {
			...user,
			email: user.email,
		});
		// The auth user ID is assigned after insertion, then linked by the after-create hook.
		delete createPayload.external_id;

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
					await assertConsumerUnclaimed(context, reusedId);
					return { data: { streampayConsumerId: reusedId } };
				}
			}

			getLogger(context).error(
				`consumer creation failed for user=${user.id ?? "<pre-insert>"}: ${summarizeStreamPayError(err)}`,
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
				`consumer external_id link failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${summarizeStreamPayError(err)}`,
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
				if (typeof context.context.adapter?.update === "function") {
					try {
						await unlinkConsumer(
							context.context.adapter,
							sessionUser.streampayConsumerId,
							sessionUser.id,
						);
					} catch (clearErr: unknown) {
						getLogger(context).error(
							`stale-link clear failed for user=${sessionUser.id}: ${summarizeStreamPayError(clearErr)}`,
						);
					}
				}
				return;
			}
			getLogger(context).error(
				`consumer update failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${summarizeStreamPayError(err)}`,
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
				`consumer delete failed for user=${sessionUser.id} consumer=${sessionUser.streampayConsumerId}: ${summarizeStreamPayError(err)}`,
			);
		}
	};
