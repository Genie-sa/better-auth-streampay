import { APIError } from "better-auth/api";
import { mapToErrorCode } from "../error-codes";
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
	const tail = [
		parsed.status !== undefined ? `status=${parsed.status}` : undefined,
		parsed.code ? `code=${parsed.code}` : undefined,
		parsed.requestId ? `request_id=${parsed.requestId}` : undefined,
	].filter((segment): segment is string => segment !== undefined);
	const validationSummary =
		parsed.validationErrors.length > 0
			? ` validation=${parsed.validationErrors
					.map((issue) => `${issue.loc.join(".")}: ${issue.message}`)
					.join(" | ")}`
			: "";
	const logDetail =
		(tail.length > 0 ? `${parsed.message} [${tail.join(" ")}]` : parsed.message) +
		validationSummary;
	logger.error(`${logPrefix} ${logDetail}`);
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
