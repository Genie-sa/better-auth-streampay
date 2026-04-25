import { readEnvelope, readSdkErrorFields, readValidationDetails } from "./error-envelope";

/**
 * Structural parser for errors thrown by the StreamPay SDK (or any
 * HTTP client that follows the same envelope). Returns a narrow,
 * serializable shape so callers can branch on `code`, log `requestId`,
 * and render `validationErrors` without pattern-matching on `unknown`.
 *
 * Parsing delegates to zod schemas in `error-envelope.ts` so every
 * caller (parse, format, classify) sees the same shape.
 */

/**
 * One entry of FastAPI/Pydantic's 422 validation detail array.
 * `loc` is the field path (`["body", "email"]`), `msg` is a human
 * string, `type` is Pydantic's machine type.
 */
export interface StreamPayValidationIssue {
	loc: (string | number)[];
	message: string;
	type: string;
}

export interface ParsedStreamPayError {
	/** HTTP status from the response, or `undefined` if the error was thrown before a response arrived. */
	status: number | undefined;
	/** StreamPay's stable error code (e.g. `"DUPLICATE_CONSUMER"`), or `undefined` for 422 / network errors. */
	code: string | undefined;
	/** Value of the `x-request-id` response header if the SDK captured it. Forward this to support tickets. */
	requestId: string | undefined;
	/** Human-readable message from the error envelope, falling back to `err.message`. */
	message: string;
	/** The `additional_info` field from StreamPay's envelope — optional debug detail. */
	additionalInfo: string | undefined;
	/** 422 validation issues. Empty array when the error is not a validation error. */
	validationErrors: StreamPayValidationIssue[];
}

export function parseStreamPayError(err: unknown): ParsedStreamPayError {
	const { status, requestId, body, message: fallbackMessage } = readSdkErrorFields(err);
	const envelope = readEnvelope(body);

	if (envelope && (envelope.code !== undefined || envelope.message !== undefined)) {
		return {
			status,
			code: envelope.code,
			requestId,
			message: envelope.message ?? fallbackMessage,
			additionalInfo: envelope.additionalInfo,
			validationErrors: [],
		};
	}

	const validationErrors = readValidationDetails(body).map((entry) => ({
		loc: entry.loc,
		message: entry.msg,
		type: entry.type,
	}));

	return {
		status,
		code: undefined,
		requestId,
		message: fallbackMessage,
		additionalInfo: undefined,
		validationErrors,
	};
}
