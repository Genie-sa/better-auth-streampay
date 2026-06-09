import { readEnvelope, readSdkErrorFields, readValidationDetails } from "./error-envelope";

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
