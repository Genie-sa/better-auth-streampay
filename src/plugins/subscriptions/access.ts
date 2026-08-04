import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import { asSessionUser, type StreamPaySessionUser } from "../../utils/session";
import type { PluginAdapter } from "./adapter";
import type {
	AuthorizeReferenceContext,
	Subscription,
	SubscriptionBillingIdentity,
	SubscriptionReferenceType,
	SubscriptionsOptions,
} from "./types";

const SUBSCRIPTION_MODEL = "subscription";

export function requireUser(ctx: GenericEndpointContext): StreamPaySessionUser {
	const user = asSessionUser(ctx.context.session?.user);
	if (!user) {
		throw new APIError("UNAUTHORIZED", {
			message: "Subscription endpoints require an authenticated session.",
		});
	}
	if (user.isAnonymous) {
		throw new APIError("UNAUTHORIZED", {
			message: "Anonymous users cannot manage subscriptions.",
		});
	}
	return user;
}

export function defaultReferenceType(
	user: StreamPaySessionUser,
	referenceId: string,
	billingIdentity: SubscriptionBillingIdentity | undefined,
): SubscriptionReferenceType {
	if (billingIdentity === "reference") return "user";
	return referenceId === user.id ? "user" : "custom";
}

export function resolveReference(
	user: StreamPaySessionUser,
	query:
		| {
				referenceId?: string | undefined;
				referenceType?: SubscriptionReferenceType | undefined;
		  }
		| null
		| undefined,
	billingIdentity?: SubscriptionBillingIdentity,
): { referenceId: string; referenceType: SubscriptionReferenceType } {
	const referenceId = query?.referenceId ?? user.id;
	return {
		referenceId,
		referenceType: query?.referenceType ?? defaultReferenceType(user, referenceId, billingIdentity),
	};
}

export async function authorizeReference(
	ctx: GenericEndpointContext,
	user: StreamPaySessionUser,
	referenceId: string,
	referenceType: SubscriptionReferenceType,
	action: AuthorizeReferenceContext["action"],
	subsOptions: SubscriptionsOptions,
): Promise<void> {
	if (referenceType === "user" && referenceId === user.id) return;
	if (!subsOptions.authorizeReference) {
		throw new APIError("FORBIDDEN", {
			code: $ERROR_CODES.FORBIDDEN.code,
			message: "Cross-account subscription actions require an `authorizeReference` callback.",
		});
	}
	const authorized = await subsOptions.authorizeReference(
		{ user, referenceId, referenceType, action },
		ctx,
	);
	if (!authorized) {
		throw new APIError("FORBIDDEN", {
			code: $ERROR_CODES.SUBSCRIPTION_REFERENCE_NOT_AUTHORIZED.code,
			message: "Not authorized for this subscription reference.",
		});
	}
}

export async function loadReferenceUser(
	ctx: GenericEndpointContext,
	referenceId: string,
): Promise<StreamPaySessionUser> {
	const row = await getAdapter(ctx).findOne<unknown>({
		model: "user",
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

export async function resolveBillingUser(
	ctx: GenericEndpointContext,
	user: StreamPaySessionUser,
	referenceId: string,
	referenceType: SubscriptionReferenceType,
	billingIdentity: SubscriptionBillingIdentity | undefined,
): Promise<StreamPaySessionUser> {
	if (billingIdentity !== "reference") return user;
	if (referenceId === user.id && referenceType === "user") return user;
	if (referenceType === "user") return loadReferenceUser(ctx, referenceId);
	throw new APIError("BAD_REQUEST", {
		code: $ERROR_CODES.SUBSCRIPTION_REFERENCE_NOT_BILLABLE.code,
		message: `Subscription checkout cannot resolve a StreamPay consumer for referenceType "${referenceType}". Only "user" references have a billing identity.`,
	});
}

export function getAdapter(ctx: GenericEndpointContext): PluginAdapter {
	const adapter = ctx.context.adapter;
	if (!adapter) {
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "Better Auth adapter is not available on the request context.",
		});
	}
	return adapter as unknown as PluginAdapter;
}

export async function findOwnedSubscription(
	ctx: GenericEndpointContext,
	user: StreamPaySessionUser,
	subscriptionId: string,
	subsOptions: SubscriptionsOptions,
	action: Exclude<AuthorizeReferenceContext["action"], "upgrade" | "read">,
): Promise<Subscription> {
	const adapter = getAdapter(ctx);
	const localRow = await adapter.findOne<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [{ field: "id", value: subscriptionId }],
	});
	const row =
		localRow ??
		(await adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [{ field: "streampaySubscriptionId", value: subscriptionId }],
		}));
	if (!row) {
		throw new APIError("NOT_FOUND", {
			code: $ERROR_CODES.SUBSCRIPTION_NOT_FOUND.code,
			message: "Subscription not found.",
		});
	}
	await authorizeReference(
		ctx,
		user,
		row.referenceId,
		row.referenceType ?? "user",
		action,
		subsOptions,
	);
	return row;
}

export async function requireConfirmedOwnedSubscription(
	ctx: GenericEndpointContext,
	subscriptionId: string,
	subsOptions: SubscriptionsOptions,
	action: Exclude<AuthorizeReferenceContext["action"], "upgrade" | "read">,
): Promise<{
	adapter: PluginAdapter;
	row: Subscription & { streampaySubscriptionId: string };
	streampaySubscriptionId: string;
}> {
	const user = requireUser(ctx);
	const adapter = getAdapter(ctx);
	const row = await findOwnedSubscription(ctx, user, subscriptionId, subsOptions, action);
	if (!row.streampaySubscriptionId) {
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
			message: "Subscription has not been confirmed by StreamPay yet.",
		});
	}
	return {
		adapter,
		row: row as Subscription & { streampaySubscriptionId: string },
		streampaySubscriptionId: row.streampaySubscriptionId,
	};
}
