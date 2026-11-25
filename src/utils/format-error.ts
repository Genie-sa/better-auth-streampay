import { readEnvelope, readSdkErrorFields, readValidationDetails } from "./error-envelope";
import { parseStreamPayError } from "./parse-error";

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
		return body.detail.map((entry) => String(entry)).join("; ");
	}

	try {
		return JSON.stringify(body);
	} catch {
		return fallback;
	}
}

/** Provider responses may echo submitted values. Only log bounded, structured identifiers. */
export function summarizeStreamPayError(error: unknown): string {
	const { status, code, requestId } = parseStreamPayError(error);
	const safeId = /^[A-Za-z0-9_-]{1,128}$/;
	const fields = [];
	if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
		fields.push(`status=${status}`);
	}
	if (code && safeId.test(code)) fields.push(`code=${code}`);
	if (requestId && safeId.test(requestId)) fields.push(`request_id=${requestId}`);
	return fields.length
		? `StreamPay request failed [${fields.join(" ")}]`
		: "StreamPay request failed";
}
