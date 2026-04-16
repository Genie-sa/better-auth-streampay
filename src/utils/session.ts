/**
 * The subset of the authenticated user the StreamPay plugin actually
 * reads. Every endpoint and hook flows user data through this shape so
 * the rest of the source can treat it as a concrete contract.
 */
export interface StreamPaySessionUser {
	id: string;
	email?: string;
	name?: string;
	isAnonymous?: boolean;
	streampayConsumerId?: string | null;
}

/**
 * Narrow an unknown (or Better-Auth-typed) user to a
 * `StreamPaySessionUser` using only TypeScript's `in` operator —
 * zero type assertions. Returns `null` when the input isn't an object
 * or doesn't carry a string `id`, so callers can branch on a single
 * nullable check instead of scattering guards.
 *
 * Why this exists: Better Auth's `User` type is a generic whose shape
 * depends on the registered plugin set. At plugin-definition time, the
 * generic defaults back to the base user shape and doesn't include the
 * `streampayConsumerId` column the plugin's schema extension adds —
 * even though the column is present at runtime. `in` narrowing lets us
 * read that field without pretending to know more about the type than
 * TypeScript does.
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
