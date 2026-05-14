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

export function isDuplicateConsumerError(err: unknown): boolean {
	const { body } = readSdkErrorFields(err);
	return readEnvelope(body)?.code === "DUPLICATE_CONSUMER";
}

export function isNotFoundError(err: unknown): boolean {
	return readSdkErrorFields(err).status === 404;
}

/**
 * On `DUPLICATE_CONSUMER`, find the existing consumer and decide whether
 * reuse is safe. Stranded consumers (no `external_id`) are always safe;
 * same-user is idempotent; a linked consumer for a different user is
 * refused unless claimExistingConsumerBy opts in — silently reusing would
 * hand one account access to another's billing history.
 */
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

/**
 * Lazy/on-demand consumer provisioning. Race-safe: two concurrent
 * callers race through `createConsumer`; the loser gets DUPLICATE_CONSUMER,
 * resolves to the winner's consumer, and both writers converge.
 */
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
				// Back-fill external_id so subsequent recovery scans hit
				// findConsumerByExternalId and skip the create round-trip.
				// Failure is non-fatal — we pay the scan cost next time.
				try {
					await options.client.updateConsumer(reusedId, { external_id: user.id });
				} catch (backfillErr: unknown) {
					getLogger(ctx).error(
						`consumer external_id backfill failed for user=${user.id} consumer=${reusedId}: ${formatStreamPayError(backfillErr)}`,
					);
				}
				await persistConsumerId(ctx, user.id, reusedId);
				return { consumerId: reusedId, created: false };
			}
		}

		// Generic user-facing message — SDK strings can carry other users'
		// identifiers via DUPLICATE_CONSUMER.additional_info.
		getLogger(ctx).error(
			`consumer creation failed for user=${user.id}: ${formatStreamPayError(err)}`,
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
		// Consumer is live in StreamPay; next call recovers via findByExternalId.
		getLogger(ctx).error(
			`consumer link write failed for user=${userId}: ${formatStreamPayError(err)}`,
		);
	}
}
