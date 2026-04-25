export interface StreamPaySessionUser {
	id: string;
	email?: string;
	name?: string;
	isAnonymous?: boolean;
	streampayConsumerId?: string | null;
}

/**
 * Narrow an unknown user to a `StreamPaySessionUser` via `in` operator
 * only. Better Auth's `User` generic doesn't include our schema
 * extension (`streampayConsumerId`) at plugin-definition time even
 * though it's present at runtime — `in` narrowing reads it safely.
 */
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
