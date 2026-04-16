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
 *
 * 1. `{ error: { additional_info: "..." } }` — StreamPay's branded error
 *    wrapper (e.g. "Organization ... is in sandbox mode and the customer
 *    email must match the organization user's email.").
 * 2. `{ error: { message: "..." } }` — fallback on the same wrapper when
 *    `additional_info` is absent.
 * 3. `{ detail: [{ loc: [...], msg: "..." }] }` — FastAPI / pydantic
 *    validation errors, rendered as a semicolon-separated `loc: msg` list.
 * 4. Anything else — `JSON.stringify(body)` if the body is an object,
 *    otherwise `err.message`.
 * 5. Non-Error throwables — `String(err)`.
 *
 * Implementation note: this function uses exclusively the `in` operator
 * for narrowing. Zero type assertions. Every access is guarded.
 */
export function formatStreamPayError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	if (!("body" in err)) return err.message;

	const { body } = err;
	if (!body || typeof body !== "object") return err.message;

	const envelope = readEnvelopeMessage(body);
	if (envelope !== null) return envelope;

	const validation = readValidationMessage(body);
	if (validation !== null) return validation;

	try {
		return JSON.stringify(body);
	} catch {
		return err.message;
	}
}

/**
 * Reads `{ error: { additional_info?: string; message?: string } }`
 * using `in` operator narrowing only.
 */
function readEnvelopeMessage(body: object): string | null {
	if (!("error" in body) || !body.error || typeof body.error !== "object") {
		return null;
	}
	const error = body.error;
	if ("additional_info" in error && typeof error.additional_info === "string") {
		return error.additional_info;
	}
	if ("message" in error && typeof error.message === "string") {
		return error.message;
	}
	return null;
}

/**
 * Reads `{ detail: Array<{ loc?, msg? }> }` from FastAPI validation
 * errors, rendering each entry as `loc.path: msg` joined by `; `.
 */
function readValidationMessage(body: object): string | null {
	if (!("detail" in body) || !Array.isArray(body.detail) || body.detail.length === 0) {
		return null;
	}
	return body.detail.map(formatValidationEntry).join("; ");
}

function formatValidationEntry(entry: unknown): string {
	if (!entry || typeof entry !== "object") return String(entry);
	const loc = "loc" in entry && Array.isArray(entry.loc) ? entry.loc.join(".") : "?";
	const msg = "msg" in entry && typeof entry.msg === "string" ? entry.msg : "invalid";
	return `${loc}: ${msg}`;
}
