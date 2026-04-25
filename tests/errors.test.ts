import { describe, expect, it, vi } from "vitest";

const { MockAPIError } = vi.hoisted(() => {
	class MockAPIError extends Error {
		public readonly code: string;
		public readonly data: { message?: string; code?: string } | undefined;
		public readonly errorCode: string | undefined;
		constructor(code: string, data?: { message?: string; code?: string }) {
			super(data?.message ?? code);
			this.name = "APIError";
			this.code = code;
			this.data = data;
			this.errorCode = data?.code;
		}
	}
	return { MockAPIError };
});

vi.mock("better-auth/api", () => ({
	APIError: MockAPIError,
	sessionMiddleware: vi.fn(),
	getSessionFromCtx: vi.fn(),
	createAuthEndpoint: vi.fn(),
}));

import { toAPIError } from "../src/utils/errors";
import { createMockLogger, mockApiError } from "./utils/helpers";

describe("toAPIError", () => {
	it("logs parsed status, code, and requestId on the server log line", () => {
		const logger = createMockLogger();
		const err = mockApiError(
			409,
			{ error: { code: "DUPLICATE_CONSUMER", message: "Consumer already exists." } },
			"POST",
			"/api/v2/consumers",
		);
		Object.defineProperty(err, "requestId", { value: "req_abc123", enumerable: true });

		expect(() => toAPIError("StreamPay consumer create failed:", err, logger)).toThrow();
		expect(logger.error).toHaveBeenCalledTimes(1);
		const message = logger.error.mock.calls[0]?.[0];
		expect(message).toContain("StreamPay consumer create failed:");
		expect(message).toContain("status=409");
		expect(message).toContain("code=DUPLICATE_CONSUMER");
		expect(message).toContain("request_id=req_abc123");
	});

	it("propagates the upstream status (409 → CONFLICT) and attaches the plugin-level error code", () => {
		const logger = createMockLogger();
		const err = mockApiError(
			409,
			{ error: { code: "DUPLICATE_CONSUMER", message: "dup" } },
			"POST",
			"/api/v2/consumers",
		);

		expect(() =>
			toAPIError({ logPrefix: "log:", userMessage: "Something failed." }, err, logger),
		).toThrow(
			expect.objectContaining({
				code: "CONFLICT",
				errorCode: "CONSUMER_DUPLICATE",
			}),
		);
	});

	it("propagates 404 → NOT_FOUND when no raw StreamPay code is present", () => {
		const logger = createMockLogger();
		const err = mockApiError(404, {}, "GET", "/api/v2/consumers/x");

		expect(() => toAPIError("lookup failed:", err, logger)).toThrow(
			expect.objectContaining({ code: "NOT_FOUND", errorCode: "NOT_FOUND" }),
		);
	});

	it("propagates 422 → UNPROCESSABLE_ENTITY for upstream validation failures", () => {
		const logger = createMockLogger();
		const err = mockApiError(
			422,
			{ detail: [{ loc: ["body", "items"], msg: "Field required", type: "missing" }] },
			"PATCH",
			"/api/v2/subscriptions/x",
		);

		expect(() => toAPIError("update failed:", err, logger)).toThrow(
			expect.objectContaining({ code: "UNPROCESSABLE_ENTITY", errorCode: "VALIDATION_ERROR" }),
		);
	});

	it("falls back to INTERNAL_SERVER_ERROR for network errors / undefined status", () => {
		const logger = createMockLogger();
		expect(() => toAPIError("net:", new Error("ECONNRESET"), logger)).toThrow(
			expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }),
		);
	});

	it("falls back to INTERNAL_SERVER_ERROR for upstream 5xx", () => {
		const logger = createMockLogger();
		const err = mockApiError(503, {}, "GET", "/api/v2/products");
		expect(() => toAPIError("upstream:", err, logger)).toThrow(
			expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }),
		);
	});

	it("omits the tail bracket when no parsed fields are available", () => {
		const logger = createMockLogger();
		expect(() => toAPIError("generic:", new Error("network down"), logger)).toThrow();
		const message = logger.error.mock.calls[0]?.[0];
		expect(message).toContain("generic: network down");
		expect(message).not.toContain("[");
	});

	it("re-throws existing APIError instances untouched", () => {
		const logger = createMockLogger();
		const existing = new MockAPIError("UNAUTHORIZED", { message: "nope" });

		expect(() => toAPIError("x:", existing, logger)).toThrow(existing);
		expect(logger.error).not.toHaveBeenCalled();
	});
});
