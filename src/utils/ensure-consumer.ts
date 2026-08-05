import type { ConsumerCreate } from "@streamsdk/typescript";
import type { User, Where } from "better-auth";
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
	sameEmail,
	samePhone,
} from "./consumer";
import { readEnvelope, readSdkErrorFields } from "./error-envelope";
import { formatStreamPayError } from "./format-error";
import { getLogger } from "./logger";
import type { StreamPaySessionUser } from "./session";

export interface StreamPayLoggerContext {
	context: {
		logger: {
			error: (message: string) => void;
			warn: (message: string) => void;
			info: (message: string) => void;
			debug: (message: string) => void;
		};
	};
}

export interface EnsureConsumerContext extends StreamPayLoggerContext {
	context: StreamPayLoggerContext["context"] & {
		adapter: {
			findOne: <T = unknown>(input: { model: string; where: Where[] }) => Promise<T | null>;
		};
		internalAdapter: {
			updateUser: (userId: string, data: Record<string, unknown>) => Promise<unknown>;
		};
	};
}

export const ORGANIZATION_EXTERNAL_ID_PREFIX = "ref:organization:";

export function canClaimBy(
	mode: ClaimExistingConsumerBy | undefined,
	identifier: ClaimExistingConsumerIdentifier,
): boolean {
	return mode?.includes(identifier) ?? false;
}

export function isDuplicateConsumerError(err: unknown): boolean {
	const { body } = readSdkErrorFields(err);
	return readEnvelope(body)?.code === "DUPLICATE_CONSUMER";
}

export function isNotFoundError(err: unknown): boolean {
	return readSdkErrorFields(err).status === 404;
}

export async function resolveDuplicateConsumer(
	options: StreamPayOptions,
	createPayload: ConsumerCreate,
	context: StreamPayLoggerContext,
): Promise<string | null> {
	const identifiers: ConsumerIdentifiers = {
		email: createPayload.email ?? null,
		phone_number: createPayload.phone_number ?? null,
		external_id: createPayload.external_id ?? null,
		iban: createPayload.iban ?? null,
	};
	const existing = await findConsumerByIdentifiers(options.client, identifiers);
	if (!existing?.id) return null;

	if (existing.external_id) {
		if (existing.external_id.startsWith(ORGANIZATION_EXTERNAL_ID_PREFIX)) {
			getLogger(context).error(
				`duplicate: consumer ${existing.id} belongs to an organization (${existing.external_id}) and cannot be claimed by a user`,
			);
			throw new APIError("CONFLICT", {
				code: "STREAMPAY_CONSUMER_LINK_CONFLICT",
				message: "This StreamPay consumer is already linked to another account.",
			});
		}
		if (createPayload.external_id && existing.external_id === createPayload.external_id) {
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

		getLogger(context).error(
			`duplicate: consumer ${existing.id} is already linked to external_id=${existing.external_id}`,
		);
		throw new APIError("CONFLICT", {
			code: "CONSUMER_DUPLICATE_LINKED",
			message:
				"A StreamPay consumer with one of these identifiers is already linked to another account.",
		});
	}

	return existing.id;
}

export async function ensureConsumerForUser(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	user: StreamPaySessionUser,
): Promise<{ consumerId: string; created: boolean }> {
	if (user.streampayConsumerId) {
		return { consumerId: user.streampayConsumerId, created: false };
	}

	const recovered = await findConsumerByExternalId(options.client, {
		externalId: user.id,
	});
	if (recovered) {
		await persistConsumerId(options, ctx, user.id, recovered);
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
		consumer_type: "INDIVIDUAL",
		...extras,
	};

	try {
		const consumer = await options.client.createConsumer(payload);
		if (!consumer.id) {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "StreamPay consumer was created but did not return an id.",
			});
		}
		await persistConsumerId(options, ctx, user.id, consumer.id);
		return { consumerId: consumer.id, created: true };
	} catch (err: unknown) {
		if (err instanceof APIError) throw err;

		if (isDuplicateConsumerError(err)) {
			const reusedId = await resolveDuplicateConsumer(options, payload, ctx);
			if (reusedId) {
				await assertConsumerUnclaimed(options, ctx, reusedId, user.id);
				try {
					await options.client.updateConsumer(reusedId, { external_id: user.id });
				} catch (backfillErr: unknown) {
					getLogger(ctx).error(
						`consumer external_id backfill failed for user=${user.id} consumer=${reusedId}: ${formatStreamPayError(backfillErr)}`,
					);
					throw new APIError("INTERNAL_SERVER_ERROR", {
						code: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED",
						message: "StreamPay consumer linking failed. Please try again.",
					});
				}
				await persistConsumerId(options, ctx, user.id, reusedId);
				return { consumerId: reusedId, created: false };
			}
		}

		getLogger(ctx).error(
			`consumer creation failed for user=${user.id}: ${formatStreamPayError(err)}`,
		);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "StreamPay consumer provisioning failed. Please try again.",
		});
	}
}

function consumerLinkUnavailable(): APIError {
	return new APIError("INTERNAL_SERVER_ERROR", {
		code: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED",
		message: "StreamPay consumer linking failed. Please try again.",
	});
}

async function findConsumerOwner(
	ctx: EnsureConsumerContext,
	consumerId: string,
	model: "user" | "organization",
): Promise<Record<string, unknown> | null> {
	try {
		return await ctx.context.adapter.findOne<Record<string, unknown>>({
			model,
			where: [{ field: "streampayConsumerId", value: consumerId }],
		});
	} catch (err: unknown) {
		getLogger(ctx).error(
			`consumer ownership check failed for consumer=${consumerId} model=${model}: ${formatStreamPayError(err)}`,
		);
		throw consumerLinkUnavailable();
	}
}

function consumerClaimConflict(): APIError {
	return new APIError("CONFLICT", {
		code: "STREAMPAY_CONSUMER_LINK_CONFLICT",
		message: "This StreamPay consumer is already linked to another account.",
	});
}

export async function assertConsumerUnclaimed(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	consumerId: string,
	userId: string,
): Promise<void> {
	const owner = await findConsumerOwner(ctx, consumerId, "user");
	if (owner) {
		if (typeof owner.id !== "string") {
			getLogger(ctx).error(`consumer ownership check returned a user without an id: ${consumerId}`);
			throw consumerLinkUnavailable();
		}
		if (owner.id !== userId) throw consumerClaimConflict();
	}

	if (options.organization?.enabled) {
		const organizationOwner = await findConsumerOwner(ctx, consumerId, "organization");
		if (organizationOwner) throw consumerClaimConflict();
		return;
	}

	// Org billing may have been enabled in the past: an organization that still
	// owns this consumer must stay protected. When the organization model does
	// not exist at all, the lookup fails and the consumer is simply unowned.
	let organizationOwner: unknown = null;
	try {
		organizationOwner = await ctx.context.adapter.findOne({
			model: "organization",
			where: [{ field: "streampayConsumerId", value: consumerId }],
		});
	} catch {
		organizationOwner = null;
	}
	if (organizationOwner) throw consumerClaimConflict();
}

async function persistConsumerId(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	userId: string,
	consumerId: string,
): Promise<void> {
	await assertConsumerUnclaimed(options, ctx, consumerId, userId);
	try {
		await ctx.context.internalAdapter.updateUser(userId, {
			streampayConsumerId: consumerId,
		});
	} catch (err: unknown) {
		getLogger(ctx).error(
			`consumer link write failed for user=${userId}: ${formatStreamPayError(err)}`,
		);
		await assertConsumerUnclaimed(options, ctx, consumerId, userId);
		throw consumerLinkUnavailable();
	}
}
