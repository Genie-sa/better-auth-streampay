import { APIError } from "better-auth/api";
import type { StreamPayLoggerContext } from "./ensure-consumer";

export interface StreamPaySessionUser {
	id: string;
	email?: string;
	name?: string;
	isAnonymous?: boolean;
	streampayConsumerId?: string | null;
}

export async function getCurrentConsumerUser(
	ctx: StreamPayLoggerContext,
	user: StreamPaySessionUser,
): Promise<StreamPaySessionUser> {
	if (!user.streampayConsumerId) return user;
	if (!ctx.context.adapter) {
		throw new APIError("INTERNAL_SERVER_ERROR", { message: "Consumer storage is unavailable." });
	}
	// Cookie and secondary-storage sessions can outlive a link change or rollback.
	const current = await ctx.context.adapter.findOne<StreamPaySessionUser>({
		model: "user",
		where: [{ field: "id", value: user.id }],
	});
	if (!current || current.id !== user.id) {
		throw new APIError("UNAUTHORIZED", { message: "The account no longer exists." });
	}
	if (current.streampayConsumerId != null && typeof current.streampayConsumerId !== "string") {
		throw new APIError("INTERNAL_SERVER_ERROR", { message: "Invalid stored consumer link." });
	}
	return { ...user, streampayConsumerId: current.streampayConsumerId ?? null };
}

export function asSessionUser(user: unknown): StreamPaySessionUser | null {
	if (user === null || typeof user !== "object") return null;
	if (!("id" in user) || typeof user.id !== "string") return null;

	const result: StreamPaySessionUser = { id: user.id };

	if ("email" in user && typeof user.email === "string") {
		result.email = user.email;
	}
	if ("name" in user && typeof user.name === "string") {
		result.name = user.name;
	}
	if ("isAnonymous" in user && user.isAnonymous === true) {
		result.isAnonymous = true;
	}
	if ("streampayConsumerId" in user) {
		const value = user.streampayConsumerId;
		if (typeof value === "string") {
			result.streampayConsumerId = value;
		} else if (value === null) {
			result.streampayConsumerId = null;
		}
	}

	return result;
}
