import { createAuthClient } from "better-auth/client";
import { describe, expect, it } from "vitest";
import { streampayClient } from "../src/client";

// The portal has no client-supplied arguments: the server derives ownership from the session.
// Exercise Better Auth's real dynamic proxy so a default GET cannot silently replace POST.
describe("hosted portal client contract", () => {
	it("creates a portal session with POST when called without arguments", async () => {
		const requests: Request[] = [];
		const client = createAuthClient({
			baseURL: "https://merchant.example",
			plugins: [streampayClient()],
			fetchOptions: {
				customFetchImpl: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					return Response.json(
						request.method === "POST"
							? { url: "https://billing.streampay.sa/session/test" }
							: { message: "Method not allowed" },
						{ status: request.method === "POST" ? 200 : 405 },
					);
				},
			},
		});

		const response = await client.consumer.portal.session();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://merchant.example/api/auth/consumer/portal/session");
		expect(requests[0]?.method).toBe("POST");
		expect(response.error).toBeNull();
		expect(response.data).toEqual({ url: "https://billing.streampay.sa/session/test" });
	});
});
