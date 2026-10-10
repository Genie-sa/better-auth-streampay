import { describe, expect, it } from "vitest";
import { checkout } from "../../src/plugins/checkout";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";

describe("checkout request validation", () => {
	it("returns 400 for an empty slug without creating a payment link", async () => {
		const { auth, streamPayClient } = await createStreamPayTestInstance({ use: [checkout()] });

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { slug: "" },
		});

		expect(response.status).toBe(400);
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalled();
	});
});
