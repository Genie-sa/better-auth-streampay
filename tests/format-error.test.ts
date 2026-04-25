import { describe, expect, it } from "vitest";
import { formatStreamPayError } from "../src/utils/format-error";
import { mockApiError } from "./utils/helpers";

describe("formatStreamPayError", () => {
	describe("StreamPay error envelope", () => {
		it("extracts `additional_info` when present", () => {
			const err = mockApiError(403, {
				error: {
					code: "STREAM_ERROR",
					message: "Something wrong happened, please contact support.",
					additional_info:
						"Organization is in sandbox mode and the customer email must match the organization user's email.",
				},
			});

			expect(formatStreamPayError(err)).toBe(
				"Organization is in sandbox mode and the customer email must match the organization user's email.",
			);
		});

		it("falls back to `error.message` when `additional_info` is missing", () => {
			const err = mockApiError(500, {
				error: {
					code: "STREAM_ERROR",
					message: "Something wrong happened, please contact support.",
				},
			});

			expect(formatStreamPayError(err)).toBe("Something wrong happened, please contact support.");
		});

		it("prefers `additional_info` even when `message` is also present", () => {
			const err = mockApiError(403, {
				error: {
					message: "opaque",
					additional_info: "specific",
				},
			});

			expect(formatStreamPayError(err)).toBe("specific");
		});
	});

	describe("FastAPI validation envelope", () => {
		it("renders a `detail` array as `loc: msg` pairs joined by semicolons", () => {
			const err = mockApiError(422, {
				detail: [
					{
						type: "value_error",
						loc: ["body", "email"],
						msg: "value is not a valid email address",
					},
					{
						type: "missing",
						loc: ["body", "name"],
						msg: "field required",
					},
				],
			});

			expect(formatStreamPayError(err)).toBe(
				"body.email: value is not a valid email address; body.name: field required",
			);
		});

		it("handles detail entries missing `loc` or `msg` gracefully", () => {
			const missingLoc = mockApiError(422, {
				detail: [{ msg: "something is wrong" }],
			});
			expect(formatStreamPayError(missingLoc)).toBe("?: something is wrong");

			const missingMsg = mockApiError(422, {
				detail: [{ loc: ["body", "phone_number"] }],
			});
			expect(formatStreamPayError(missingMsg)).toBe("body.phone_number: invalid");
		});

		it("stringifies scalar detail entries", () => {
			const err = mockApiError(422, { detail: ["raw string reason"] });
			expect(formatStreamPayError(err)).toBe("raw string reason");
		});
	});

	describe("fallbacks", () => {
		it("returns JSON.stringify(body) for an unknown object body", () => {
			const err = mockApiError(500, { foo: "bar", baz: 1 });
			expect(formatStreamPayError(err)).toBe('{"foo":"bar","baz":1}');
		});

		it("falls back to `err.message` when body is absent", () => {
			const err = new Error("HTTP 500 calling GET /api/v2/me");
			expect(formatStreamPayError(err)).toBe("HTTP 500 calling GET /api/v2/me");
		});

		it("falls back to `err.message` when body is primitive", () => {
			const err = new Error("fallback message");
			(err as { body?: unknown }).body = "not an object";
			expect(formatStreamPayError(err)).toBe("fallback message");
		});

		it("stringifies non-Error throwables", () => {
			expect(formatStreamPayError("raw string")).toBe("raw string");
			expect(formatStreamPayError(42)).toBe("42");
			expect(formatStreamPayError(null)).toBe("null");
			expect(formatStreamPayError(undefined)).toBe("undefined");
		});

		it("does not throw when body has a circular reference", () => {
			const body: Record<string, unknown> = { circular: null };
			body.circular = body;
			const err = mockApiError(500, body);
			// Should NOT throw; falls back to `err.message`.
			expect(() => formatStreamPayError(err)).not.toThrow();
			expect(formatStreamPayError(err)).toContain("HTTP 500");
		});
	});
});
