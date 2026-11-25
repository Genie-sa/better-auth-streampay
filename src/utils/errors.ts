import { APIError } from "better-auth/api";
import { mapToErrorCode } from "../error-codes";
import { summarizeStreamPayError } from "./format-error";
import { parseStreamPayError } from "./parse-error";
import type { StreamPaySessionUser } from "./session";

type APIErrorStatus =
	| "BAD_REQUEST"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "CONFLICT"
	| "UNPROCESSABLE_ENTITY"
	| "TOO_MANY_REQUESTS"
	| "INTERNAL_SERVER_ERROR";

function statusToAPIErrorStatus(status: number | undefined): APIErrorStatus {
	switch (status) {
		case 400:
			return "BAD_REQUEST";
		case 401:
			return "UNAUTHORIZED";
		case 403:
			return "FORBIDDEN";
		case 404:
			return "NOT_FOUND";
		case 409:
			return "CONFLICT";
		case 422:
			return "UNPROCESSABLE_ENTITY";
		case 429:
			return "TOO_MANY_REQUESTS";
		default:
			return "INTERNAL_SERVER_ERROR";
	}
}

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
	const parsed = parseStreamPayError(err);
	logger.error(`${logPrefix} ${summarizeStreamPayError(err)}`);
	throw new APIError(statusToAPIErrorStatus(parsed.status), {
		code: mapToErrorCode(parsed.code, parsed.status),
		message: userMessage,
	});
}

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
