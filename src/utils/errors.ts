import { APIError } from "better-auth/api";
import type { StreamPaySessionUser } from "./session";

/**
 * Translate an unknown error thrown by the StreamPay SDK (or any
 * downstream dependency) into a Better Auth `APIError`. Re-throws
 * existing `APIError` instances untouched so inner throws bubble up
 * unchanged.
 *
 * `logPrefix` is included verbatim in the server log along with the
 * underlying error detail so ops can trace the failure. `userMessage`
 * is what the client sees — keep it generic so SDK error strings
 * (which may include third-party identifiers) cannot reach a response
 * body. When called with a single string both fields are the same,
 * matching the simpler portal usage.
 */
export function toAPIError(
	messageOrConfig: string | { logPrefix: string; userMessage: string },
	err: unknown,
	logger: { error: (message: string) => void },
): never {
	if (err instanceof APIError) throw err;
	const { logPrefix, userMessage } =
		typeof messageOrConfig === "string"
			? { logPrefix: messageOrConfig, userMessage: messageOrConfig }
			: messageOrConfig;
	const detail = err instanceof Error ? err.message : String(err);
	logger.error(`${logPrefix} ${detail}`);
	throw new APIError("INTERNAL_SERVER_ERROR", { message: userMessage });
}

/**
 * Centralized session-guard used by portal and subscription-mutation
 * endpoints. Asserts that the caller is authenticated and not an
 * anonymous session. Uses TypeScript's assertion-function feature to
 * narrow `user` to non-null on the happy path.
 *
 * The anonymous-session message is parameterized so each endpoint can
 * return a reason that reads naturally at its surface (e.g. "cannot
 * access the billing portal" vs. "cannot manage subscriptions").
 */
export function rejectUnauthorized(
	user: StreamPaySessionUser | null,
	anonymousMessage: string,
): asserts user is StreamPaySessionUser {
	if (!user) {
		throw new APIError("UNAUTHORIZED", { message: "Session user is missing." });
	}
	if (user.isAnonymous) {
		throw new APIError("UNAUTHORIZED", { message: anonymousMessage });
	}
}
