import { z } from "zod";

/**
 * Shared zod parsers for the StreamPay error envelope. The SDK throws
 * `StreamSDKError` (subclass of `Error`) whose `.body` carries the
 * actual API response. This module centralizes the shape checks so
 * `parseStreamPayError`, `formatStreamPayError`, `isDuplicateConsumerError`,
 * `isNotFoundError`, and `classifyWebhookFailure` all parse the same way.
 */

const ErrorShape = z.object({
	code: z.string().optional(),
	message: z.string().optional(),
	additional_info: z.string().optional(),
});

const DetailEntryShape = z
	.object({
		loc: z.array(z.unknown()).optional(),
		msg: z.string().optional(),
		type: z.string().optional(),
	})
	.passthrough();

const StreamPayErrorBodySchema = z
	.object({
		error: ErrorShape.optional(),
		detail: z.array(z.unknown()).optional(),
	})
	.passthrough();

const SdkErrorShape = z
	.object({
		status: z.number().optional(),
		requestId: z.string().optional(),
		body: z.unknown().optional(),
	})
	.passthrough();

export interface StreamPayErrorEnvelope {
	code: string | undefined;
	message: string | undefined;
	additionalInfo: string | undefined;
}

export interface StreamPayValidationDetail {
	loc: (string | number)[];
	msg: string;
	type: string;
}

export interface SdkErrorFields {
	status: number | undefined;
	requestId: string | undefined;
	body: unknown;
	message: string;
}

/**
 * Pull the standard `status` / `requestId` / `body` off an SDK-thrown
 * error without requiring the SDK's non-exported error class.
 * Non-`Error` inputs come back as an empty-fields shape.
 */
export function readSdkErrorFields(err: unknown): SdkErrorFields {
	if (!(err instanceof Error)) {
		return { status: undefined, requestId: undefined, body: undefined, message: String(err) };
	}
	const parsed = SdkErrorShape.safeParse(err);
	const data = parsed.success ? parsed.data : undefined;
	return {
		status: data?.status,
		requestId: data?.requestId && data.requestId.length > 0 ? data.requestId : undefined,
		body: data?.body,
		message: err.message,
	};
}

/**
 * Parse the `{ error: { code, message, additional_info } }` envelope.
 * Returns `null` when the body has no recognizable envelope fields so
 * callers can fall back to validation-detail or raw-message handling.
 */
export function readEnvelope(body: unknown): StreamPayErrorEnvelope | null {
	const parsed = StreamPayErrorBodySchema.safeParse(body);
	if (!parsed.success || !parsed.data.error) return null;
	const { code, message, additional_info } = parsed.data.error;
	if (code === undefined && message === undefined && additional_info === undefined) return null;
	return { code, message, additionalInfo: additional_info };
}

/**
 * Parse FastAPI's 422 validation detail array. Empty entries are
 * dropped; every entry that survives has at least one of `loc`, `msg`,
 * or `type` populated.
 */
export function readValidationDetails(body: unknown): StreamPayValidationDetail[] {
	const parsed = StreamPayErrorBodySchema.safeParse(body);
	if (!parsed.success || !parsed.data.detail) return [];
	const entries: StreamPayValidationDetail[] = [];
	for (const entry of parsed.data.detail) {
		const parsedEntry = DetailEntryShape.safeParse(entry);
		if (!parsedEntry.success) continue;
		const loc = (parsedEntry.data.loc ?? []).filter(
			(v): v is string | number => typeof v === "string" || typeof v === "number",
		);
		const msg = parsedEntry.data.msg ?? "";
		const type = parsedEntry.data.type ?? "";
		if (!msg && !type && loc.length === 0) continue;
		entries.push({ loc, msg, type });
	}
	return entries;
}
