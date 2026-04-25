import { describe, expect, it } from "vitest";
import { parseStreamPayError } from "../src/utils/parse-error";
import { mockApiError } from "./utils/helpers";

describe("parseStreamPayError", () => {
	it("extracts code, message, and additional_info from the StreamPay envelope", () => {
		const err = mockApiError(
			409,
			{
				error: {
					code: "DUPLICATE_CONSUMER",
					message: "Consumer already exists.",
					additional_info: "consumer id 42",
				},
			},
			"POST",
			"/api/v2/consumers",
		);
		const parsed = parseStreamPayError(err);
		expect(parsed.status).toBe(409);
		expect(parsed.code).toBe("DUPLICATE_CONSUMER");
		expect(parsed.message).toBe("Consumer already exists.");
		expect(parsed.additionalInfo).toBe("consumer id 42");
		expect(parsed.validationErrors).toEqual([]);
	});

	it("lifts requestId from the error object when the SDK captured it", () => {
		const err = new Error("HTTP 500 calling POST /api/v2/consumers");
		Object.defineProperty(err, "status", { value: 500, enumerable: true });
		Object.defineProperty(err, "requestId", { value: "req_abc123", enumerable: true });
		Object.defineProperty(err, "body", {
			value: { error: { code: "STREAM_ERROR", message: "boom" } },
			enumerable: true,
		});

		const parsed = parseStreamPayError(err);
		expect(parsed.requestId).toBe("req_abc123");
	});

	it("parses 422 HTTPValidationError detail[] into structured issues", () => {
		const err = mockApiError(
			422,
			{
				detail: [
					{ loc: ["body", "email"], msg: "field required", type: "value_error.missing" },
					{ loc: ["body", "phone_number", 0], msg: "invalid phone", type: "value_error" },
				],
			},
			"POST",
			"/api/v2/consumers",
		);

		const parsed = parseStreamPayError(err);
		expect(parsed.status).toBe(422);
		expect(parsed.code).toBeUndefined();
		expect(parsed.validationErrors).toEqual([
			{ loc: ["body", "email"], message: "field required", type: "value_error.missing" },
			{ loc: ["body", "phone_number", 0], message: "invalid phone", type: "value_error" },
		]);
	});

	it("drops validation entries with no useful data", () => {
		const err = mockApiError(422, {
			detail: [{}, { loc: ["body"], msg: "real issue", type: "x" }],
		});
		const parsed = parseStreamPayError(err);
		expect(parsed.validationErrors).toHaveLength(1);
		expect(parsed.validationErrors[0]?.message).toBe("real issue");
	});

	it("falls back to err.message when no envelope is present", () => {
		const parsed = parseStreamPayError(new Error("network down"));
		expect(parsed.status).toBeUndefined();
		expect(parsed.code).toBeUndefined();
		expect(parsed.requestId).toBeUndefined();
		expect(parsed.message).toBe("network down");
		expect(parsed.validationErrors).toEqual([]);
	});

	it("coerces non-Error throwables to a safe shape", () => {
		const parsed = parseStreamPayError("string-thrown");
		expect(parsed.message).toBe("string-thrown");
		expect(parsed.status).toBeUndefined();
		expect(parsed.validationErrors).toEqual([]);
	});

	it("tolerates a malformed envelope (no `error` key)", () => {
		const err = mockApiError(500, { something: "else" });
		const parsed = parseStreamPayError(err);
		expect(parsed.status).toBe(500);
		expect(parsed.code).toBeUndefined();
		expect(parsed.validationErrors).toEqual([]);
	});

	it("treats an empty-string requestId as missing", () => {
		const err = new Error("x");
		Object.defineProperty(err, "requestId", { value: "", enumerable: true });
		Object.defineProperty(err, "status", { value: 500, enumerable: true });
		const parsed = parseStreamPayError(err);
		expect(parsed.requestId).toBeUndefined();
	});
});
