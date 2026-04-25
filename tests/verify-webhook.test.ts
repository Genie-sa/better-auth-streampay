import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StreamPayWebhookError, verifyWebhook, verifyWebhookOrThrow } from "../src/webhooks/verify";

const SECRET = "super-secret";

function sign(timestamp: number, body: string, secret = SECRET): string {
	const hex = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
	return `t=${timestamp},v1=${hex}`;
}

describe("verifyWebhook", () => {
	const body = JSON.stringify({ event_type: "PAYMENT_SUCCEEDED" });
	const now = () => 1_700_000_000;

	it("accepts a well-signed payload within tolerance", () => {
		const header = sign(now(), body);
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: header,
			now,
		});
		expect(result).toEqual({ ok: true, timestamp: now() });
	});

	it("tolerates reordered or extra header fields", () => {
		const ts = now();
		const hex = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
		const header = `v1=${hex},t=${ts},v2=ignored`;
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: header,
			now,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects when the header is missing", () => {
		const result = verifyWebhook({ secret: SECRET, rawBody: body, signatureHeader: null });
		expect(result).toEqual({ ok: false, reason: "MISSING_HEADER" });
	});

	it("rejects a malformed header", () => {
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: "not-a-real-signature",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("MALFORMED_HEADER");
	});

	it("rejects a non-integer timestamp", () => {
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: "t=abc,v1=deadbeef",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("INVALID_TIMESTAMP");
	});

	it("rejects a timestamp older than the tolerance window", () => {
		const header = sign(now() - 1000, body);
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: header,
			toleranceSeconds: 300,
			now,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("EXPIRED");
	});

	it("rejects a future timestamp outside the tolerance window", () => {
		const header = sign(now() + 1000, body);
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: header,
			toleranceSeconds: 300,
			now,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("EXPIRED");
	});

	it("rejects a payload signed with a different secret", () => {
		const header = sign(now(), body, "other-secret");
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: header,
			now,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("INVALID_SIGNATURE");
	});

	it("rejects a payload where the body was mutated after signing", () => {
		const header = sign(now(), body);
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: `${body}tampered`,
			signatureHeader: header,
			now,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("INVALID_SIGNATURE");
	});

	it("rejects signatures of the wrong length (not a valid HMAC-SHA256)", () => {
		const result = verifyWebhook({
			secret: SECRET,
			rawBody: body,
			signatureHeader: `t=${now()},v1=deadbeef`,
			now,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("INVALID_SIGNATURE");
	});

	it("verifyWebhookOrThrow throws a typed error on failure", () => {
		expect(() =>
			verifyWebhookOrThrow({ secret: SECRET, rawBody: body, signatureHeader: null }),
		).toThrowError(StreamPayWebhookError);
	});

	describe("secret rotation", () => {
		it("accepts a payload signed with any secret in the array", () => {
			const oldSecret = "old-secret";
			const newSecret = "new-secret";
			const header = sign(now(), body, oldSecret);
			const result = verifyWebhook({
				secret: [newSecret, oldSecret],
				rawBody: body,
				signatureHeader: header,
				now,
			});
			expect(result).toEqual({ ok: true, timestamp: now() });
		});

		it("rejects when the signature matches none of the provided secrets", () => {
			const header = sign(now(), body, "foreign-secret");
			const result = verifyWebhook({
				secret: ["secret-a", "secret-b"],
				rawBody: body,
				signatureHeader: header,
				now,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("INVALID_SIGNATURE");
		});

		it("rejects when the secret array is empty", () => {
			const header = sign(now(), body, SECRET);
			const result = verifyWebhook({
				secret: [],
				rawBody: body,
				signatureHeader: header,
				now,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("INVALID_SIGNATURE");
		});
	});
});
