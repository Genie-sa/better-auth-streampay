export interface StreamPaySessionUser {
	id: string;
	email?: string;
	name?: string;
	isAnonymous?: boolean;
	streampayConsumerId?: string | null;
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
