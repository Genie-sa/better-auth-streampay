import StreamSDK from "@streamsdk/typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("better-auth/api", async () => {
	const { MockAPIError } = await import("./utils/better-auth-mock");
	return {
		APIError: MockAPIError,
		sessionMiddleware: vi.fn(),
		createAuthEndpoint: (path: string, config: unknown, handler: unknown) => ({
			path,
			config,
			handler,
		}),
	};
});

import { portal } from "../src/plugins/portal";
import { findConsumerByExternalId } from "../src/utils/consumer";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions } from "./utils/helpers";
import { createMockContext, createMockUser } from "./utils/mocks";

describe("Stream API pagination wire contract", () => {
	it.each([
		"invoices",
		"subscriptions",
	] as const)("uses the provider's limit parameter for %s", async (endpoint) => {
		const requests: URL[] = [];
		const sdk = StreamSDK.init("test-key", {
			baseUrl: "https://stream.example",
			fetchFn: async (input) => {
				const url = new URL(String(input));
				requests.push(url);
				const limit = Number(url.searchParams.get("limit") ?? 10);
				return Response.json({
					data: Array.from({ length: limit }, (_, index) => ({ id: `item-${index}` })),
					pagination: { current_page: 2, limit },
				});
			},
		});
		const handler = unwrapHandler<{ data: unknown[] }>(
			portal()(createTestStreamPayOptions({ client: sdk })).endpoints[endpoint],
		);

		const result = await handler(
			createMockContext({
				user: createMockUser({ streampayConsumerId: "owned-consumer" }),
				query: { page: 2, size: 1, organization_consumer_id: "someone-else" },
			}),
		);

		expect(result.data).toHaveLength(1);
		expect(requests[0]?.pathname).toBe(`/api/v2/${endpoint}`);
		expect(requests[0]?.searchParams.get("limit")).toBe("1");
		expect(requests[0]?.searchParams.has("size")).toBe(false);
		expect(requests[0]?.searchParams.get("page")).toBe("2");
		expect(requests[0]?.searchParams.get("organization_consumer_id")).toBe("owned-consumer");
	});

	it("uses limit for consumer searches through the actual SDK serializer", async () => {
		let request: URL | undefined;
		const sdk = StreamSDK.init("test-key", {
			baseUrl: "https://stream.example",
			fetchFn: async (input) => {
				request = new URL(String(input));
				return Response.json({ data: [], pagination: { has_next_page: false } });
			},
		});

		expect(await findConsumerByExternalId(sdk, { externalId: "user-42" })).toBeNull();
		expect(request?.searchParams.get("limit")).toBe("50");
		expect(request?.searchParams.has("size")).toBe(false);
		expect(request?.searchParams.get("search_term")).toBe("user-42");
	});
});
