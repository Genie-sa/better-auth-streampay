import type { ConsumerCreate } from "@streamsdk/typescript";
import type { GenericEndpointContext, Where } from "better-auth";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../error-codes";
import type { BillingOrganization, ConsumerCreateOverrides, StreamPayOptions } from "../types";
import { findConsumerByExternalId } from "./consumer";
import { type EnsureConsumerContext, ensureConsumerForUser } from "./ensure-consumer";
import { readEnvelope, readSdkErrorFields } from "./error-envelope";
import { formatStreamPayError } from "./format-error";
import { getLogger } from "./logger";
import { asSessionUser, type StreamPaySessionUser } from "./session";

const ORGANIZATION_MODEL = "organization";
const USER_MODEL = "user";

interface BillingAdapter {
	findOne: <T = unknown>(input: { model: string; where: Where[] }) => Promise<T | null>;
	update: <T = unknown>(input: {
		model: string;
		update: Record<string, unknown>;
		where: Where[];
	}) => Promise<T | null>;
}

export type BillingAccountResolution =
	| { referenceType: "user"; referenceId: string; user: StreamPaySessionUser }
	| { referenceType: "organization"; referenceId: string; organization: BillingOrganization };

export function organizationExternalId(organizationId: string): string {
	return `ref:organization:${organizationId}`;
}

function getBillingAdapter(ctx: GenericEndpointContext): BillingAdapter {
	const adapter = ctx.context.adapter;
	if (!adapter) {
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "Better Auth adapter is not available on the request context.",
		});
	}
	return adapter as unknown as BillingAdapter;
}

export async function loadReferenceUser(
	ctx: GenericEndpointContext,
	referenceId: string,
): Promise<StreamPaySessionUser> {
	const row = await getBillingAdapter(ctx).findOne<unknown>({
		model: USER_MODEL,
		where: [{ field: "id", value: referenceId }],
	});
	const referenceUser = asSessionUser(row);
	if (!referenceUser) {
		throw new APIError("NOT_FOUND", {
			code: $ERROR_CODES.SUBSCRIPTION_REFERENCE_USER_NOT_FOUND.code,
			message: "The referenced user does not exist.",
		});
	}
	if (referenceUser.isAnonymous) {
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_REFERENCE_USER_NOT_BILLABLE.code,
			message: "Anonymous users cannot be billed for subscriptions.",
		});
	}
	return referenceUser;
}

function asBillingOrganization(row: unknown): BillingOrganization | null {
	if (row === null || typeof row !== "object") return null;
	if (!("id" in row) || typeof row.id !== "string") return null;
	if (!("name" in row) || typeof row.name !== "string") return null;
	return row as BillingOrganization;
}

export async function resolveOrganizationBillingAccount(
	ctx: GenericEndpointContext,
	options: StreamPayOptions,
	referenceId: string,
): Promise<Extract<BillingAccountResolution, { referenceType: "organization" }>> {
	if (!options.organization?.enabled) {
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_ORG_BILLING_NOT_ENABLED.code,
			message: $ERROR_CODES.SUBSCRIPTION_ORG_BILLING_NOT_ENABLED.message,
		});
	}
	let row: unknown;
	try {
		row = await getBillingAdapter(ctx).findOne<unknown>({
			model: ORGANIZATION_MODEL,
			where: [{ field: "id", value: referenceId }],
		});
	} catch (err) {
		getLogger(ctx).error(
			`organization lookup failed for reference=${referenceId}: ${formatStreamPayError(err)}`,
		);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message:
				"The organization model could not be queried. Is the Better Auth organization plugin installed and migrated?",
		});
	}
	const organization = asBillingOrganization(row);
	if (!organization) {
		throw new APIError("NOT_FOUND", {
			code: $ERROR_CODES.ORG_NOT_FOUND.code,
			message: $ERROR_CODES.ORG_NOT_FOUND.message,
		});
	}
	return { referenceType: "organization", referenceId, organization };
}

function sanitizeOverrides(
	overrides: ConsumerCreateOverrides | undefined,
): ConsumerCreateOverrides {
	if (!overrides) return {};
	const {
		name: _name,
		email: _email,
		external_id: _externalId,
		...rest
	} = overrides as Record<string, unknown>;
	return rest as ConsumerCreateOverrides;
}

async function buildOrganizationConsumerPayload(
	ctx: GenericEndpointContext,
	options: StreamPayOptions,
	organization: BillingOrganization,
): Promise<ConsumerCreate> {
	const overrides = options.organization?.getBillingDetails
		? sanitizeOverrides(await options.organization.getBillingDetails({ organization }, ctx))
		: {};
	return {
		consumer_type: "INDIVIDUAL",
		...overrides,
		name: organization.name,
		external_id: organizationExternalId(organization.id),
	};
}

function isMissingContactRejection(err: unknown, payload: ConsumerCreate): boolean {
	if (payload.email || payload.phone_number) return false;
	const { status, body } = readSdkErrorFields(err);
	if (readEnvelope(body)?.code === "INVALID_PARAMETERS") return true;
	return status === 400 || status === 422;
}

function claimConflictError(): APIError {
	return new APIError("CONFLICT", {
		code: $ERROR_CODES.STREAMPAY_CONSUMER_LINK_CONFLICT.code,
		message: $ERROR_CODES.STREAMPAY_CONSUMER_LINK_CONFLICT.message,
	});
}

async function assertConsumerUnclaimed(
	ctx: GenericEndpointContext,
	consumerId: string,
	organizationId: string,
): Promise<void> {
	const adapter = getBillingAdapter(ctx);
	const where: Where[] = [{ field: "streampayConsumerId", value: consumerId }];

	const userOwner = await adapter.findOne<{ id?: unknown }>({ model: USER_MODEL, where });
	if (userOwner) throw claimConflictError();

	const orgOwner = await adapter.findOne<{ id?: unknown }>({ model: ORGANIZATION_MODEL, where });
	if (orgOwner && orgOwner.id !== organizationId) throw claimConflictError();
}

async function persistOrganizationConsumerId(
	ctx: GenericEndpointContext,
	organizationId: string,
	consumerId: string,
): Promise<void> {
	await assertConsumerUnclaimed(ctx, consumerId, organizationId);
	await getBillingAdapter(ctx).update({
		model: ORGANIZATION_MODEL,
		update: { streampayConsumerId: consumerId },
		where: [{ field: "id", value: organizationId }],
	});
}

async function ensureConsumerForOrganization(
	options: StreamPayOptions,
	ctx: GenericEndpointContext,
	organization: BillingOrganization,
): Promise<{ consumerId: string; created: boolean }> {
	if (typeof organization.streampayConsumerId === "string") {
		return { consumerId: organization.streampayConsumerId, created: false };
	}

	const externalId = organizationExternalId(organization.id);
	const recovered = await findConsumerByExternalId(options.client, { externalId });
	if (recovered) {
		await persistOrganizationConsumerId(ctx, organization.id, recovered);
		return { consumerId: recovered, created: false };
	}

	const payload = await buildOrganizationConsumerPayload(ctx, options, organization);
	try {
		const consumer = await options.client.createConsumer(payload);
		if (!consumer.id) {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "StreamPay consumer was created but did not return an id.",
			});
		}
		await persistOrganizationConsumerId(ctx, organization.id, consumer.id);
		return { consumerId: consumer.id, created: true };
	} catch (err: unknown) {
		if (err instanceof APIError) throw err;

		if (readEnvelope(readSdkErrorFields(err).body)?.code === "DUPLICATE_CONSUMER") {
			const raced = await findConsumerByExternalId(options.client, { externalId });
			if (raced) {
				await persistOrganizationConsumerId(ctx, organization.id, raced);
				return { consumerId: raced, created: false };
			}
		}
		if (isMissingContactRejection(err, payload)) {
			throw new APIError("BAD_REQUEST", {
				code: $ERROR_CODES.BILLING_CONTACT_REQUIRED.code,
				message:
					"StreamPay rejected a contact-less consumer. Provide contact fields via `organization.getBillingDetails`.",
			});
		}
		getLogger(ctx).error(
			`consumer provisioning failed for organization=${organization.id}: ${formatStreamPayError(err)}`,
		);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "StreamPay consumer provisioning failed. Please try again.",
		});
	}
}

export async function resolveReferenceBillingAccount(
	ctx: GenericEndpointContext,
	options: StreamPayOptions,
	referenceId: string,
	referenceType: "user" | "organization",
): Promise<BillingAccountResolution> {
	if (referenceType === "organization") {
		return resolveOrganizationBillingAccount(ctx, options, referenceId);
	}
	return { referenceType: "user", referenceId, user: await loadReferenceUser(ctx, referenceId) };
}

export async function ensureConsumerForBillingAccount(
	options: StreamPayOptions,
	ctx: GenericEndpointContext,
	resolution: BillingAccountResolution,
): Promise<{ consumerId: string; created: boolean }> {
	if (resolution.referenceType === "user") {
		return ensureConsumerForUser(
			options,
			{ context: ctx.context } as EnsureConsumerContext,
			resolution.user,
		);
	}
	return ensureConsumerForOrganization(options, ctx, resolution.organization);
}
