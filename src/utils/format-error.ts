import { readEnvelope, readSdkErrorFields, readValidationDetails } from "./error-envelope";

/**
 * Unwraps the useful detail out of a `@streamsdk/typescript` error.
 *
 * The SDK throws `StreamSDKError` (a subclass of `Error`) whose `.message`
 * is always the opaque shape `HTTP <status> calling <method> <path>`. The
 * actual StreamPay API response — including `additional_info` and FastAPI
 * validation details — lives on `.body`. This helper surfaces the best
 * available message so developers see *why* an upstream call failed, not
 * just that it did.
 *
 * Shapes handled:
 *   1. `{ error: { additional_info: "..." } }` — branded envelope, preferred.
 *   2. `{ error: { message: "..." } }` — same envelope, fallback.
 *   3. `{ detail: [{ loc, msg }] }` — FastAPI 422 validation errors.
 *   4. Anything else — `JSON.stringify(body)` if object, else `err.message`.
 *   5. Non-Error throwables — `String(err)`.
 */
export function formatStreamPayError(err: unknown): string {
	const { body, message: fallback } = readSdkErrorFields(err);
	if (body === undefined) return fallback;
	if (!body || typeof body !== "object") return fallback;

	const envelope = readEnvelope(body);
	if (envelope?.additionalInfo) return envelope.additionalInfo;
	if (envelope?.message) return envelope.message;

	if ("detail" in body && Array.isArray(body.detail) && body.detail.length > 0) {
		const details = readValidationDetails(body);
		if (details.length > 0) {
			return details
				.map((entry) => {
					const loc = entry.loc.length > 0 ? entry.loc.join(".") : "?";
					const msg = entry.msg || "invalid";
					return `${loc}: ${msg}`;
				})
				.join("; ");
		}
		// Scalar entries fall through to String(entry) (e.g. 422 bodies
		// from non-standard servers). Matches the previous formatter.
		return body.detail.map((entry) => String(entry)).join("; ");
	}

	try {
		return JSON.stringify(body);
	} catch {
		return fallback;
	}
}
