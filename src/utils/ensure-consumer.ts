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
	sameEmail,
	samePhone,
} from "./consumer";
import {
	consumerLinkUnavailable,
	type EnsureConsumerContext,
	getCurrentConsumerUser,
	linkConsumer,
	type StreamPayLoggerContext,
	unlinkConsumer,
} from "./consumer-link";
import { readEnvelope, readSdkErrorFields } from "./error-envelope";
import { toAPIError } from "./errors";
import { formatStreamPayError } from "./format-error";
import { getLogger } from "./logger";
import type { StreamPaySessionUser } from "./session";

export {
	assertConsumerUnclaimed,
	type EnsureConsumerContext,
	type StreamPayLoggerContext,
} from "./consumer-link";

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

/** Signup and lazy provisioning create the same consumer; only the `external_id` timing differs. */
export async function buildConsumerCreatePayload(
	options: StreamPayOptions,
	user: Partial<User> & { email: string },
): Promise<ConsumerCreate> {
	const extras = options.getConsumerCreateParams
		? await options.getConsumerCreateParams({ user })
		: {};
	return {
		consumer_type: "INDIVIDUAL",
		...extras,
		name: user.name || user.email,
		email: user.email,
	};
}

/** A consumer created for a user who was linked by a concurrent request would stay orphaned. */
async function discardOrphanedConsumer(
	options: StreamPayOptions,
	ctx: StreamPayLoggerContext,
	userId: string,
	orphanId: string,
): Promise<void> {
	try {
		await options.client.deleteConsumer(orphanId);
	} catch (err: unknown) {
		getLogger(ctx).error(
			`orphaned consumer=${orphanId} for user=${userId} could not be deleted; delete it manually: ${formatStreamPayError(err)}`,
		);
	}
}

export async function ensureConsumerForUser(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	user: StreamPaySessionUser,
): Promise<{ consumerId: string; created: boolean }> {
	user = await getCurrentConsumerUser(ctx, user);
	if (user.streampayConsumerId) {
		return { consumerId: user.streampayConsumerId, created: false };
	}

	const recovered = await findConsumerByExternalId(options.client, {
		externalId: user.id,
	});
	if (recovered) {
		const { consumerId } = await linkConsumer(ctx, user.id, recovered);
		return { consumerId, created: false };
	}

	if (!user.email) {
		throw new APIError("BAD_REQUEST", {
			message: "StreamPay requires an email address to create a consumer.",
		});
	}

	const userForParams: Partial<User> & { email: string } = { id: user.id, email: user.email };
	if (user.name !== undefined) userForParams.name = user.name;
	const payload: ConsumerCreate = {
		...(await buildConsumerCreatePayload(options, userForParams)),
		external_id: user.id,
	};

	try {
		const consumer = await options.client.createConsumer(payload);
		if (!consumer.id) {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "StreamPay consumer was created but did not return an id.",
			});
		}
		const link = await linkConsumer(ctx, user.id, consumer.id);
		if (!link.claimed && link.consumerId !== consumer.id) {
			await discardOrphanedConsumer(options, ctx, user.id, consumer.id);
		}
		return { consumerId: link.consumerId, created: link.claimed };
	} catch (err: unknown) {
		if (err instanceof APIError) throw err;

		if (isDuplicateConsumerError(err)) {
			const reusedId = await resolveDuplicateConsumer(options, payload, ctx);
			if (reusedId) {
				// Claim the unique local link before changing the provider's owner.
				const link = await linkConsumer(ctx, user.id, reusedId);
				// Only the request that stored the link owns its provider backfill and rollback.
				if (!link.claimed) return { consumerId: link.consumerId, created: false };
				try {
					await options.client.updateConsumer(reusedId, { external_id: user.id });
				} catch (backfillErr: unknown) {
					try {
						await unlinkConsumer(ctx.context.adapter, reusedId, user.id);
					} catch (clearErr: unknown) {
						getLogger(ctx).error(
							`consumer claim cleanup failed for user=${user.id} consumer=${reusedId}: ${formatStreamPayError(clearErr)}`,
						);
					}
					getLogger(ctx).error(
						`consumer external_id backfill failed for user=${user.id} consumer=${reusedId}: ${formatStreamPayError(backfillErr)}`,
					);
					throw consumerLinkUnavailable();
				}
				return { consumerId: reusedId, created: false };
			}
		}

		const { status } = readSdkErrorFields(err);
		const transient =
			(status !== undefined && status >= 500) || (status === undefined && err instanceof TypeError);
		let recoveredId: string | null = null;
		if (transient) {
			try {
				recoveredId = await findConsumerByExternalId(options.client, { externalId: user.id });
			} catch (searchErr: unknown) {
				getLogger(ctx).warn(
					`consumer recovery search failed for user=${user.id}: ${formatStreamPayError(searchErr)}`,
				);
			}
		}
		if (recoveredId) {
			const { consumerId } = await linkConsumer(ctx, user.id, recoveredId);
			getLogger(ctx).warn(`consumer recovered after failed creation for user=${user.id}`);
			return { consumerId, created: false };
		}
		toAPIError(
			{
				logPrefix: `consumer creation failed for user=${user.id}:`,
				userMessage: "StreamPay consumer provisioning failed. Please try again.",
			},
			err,
			getLogger(ctx),
		);
	}
}
