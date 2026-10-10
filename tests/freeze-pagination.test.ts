import type { FreezeListResponse } from "@streamsdk/typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("better-auth/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("better-auth/api")>()),
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { buildSubscriptionEndpoints } from "../src/plugins/subscriptions/endpoints";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions } from "./utils/helpers";
import { createMockContext, createMockStreamPayClient } from "./utils/mocks";
import { createMockAdapter, createMockSubscriptionRow } from "./utils/subscription-helpers";

const historical = {
	id: "old",
	freeze_start_datetime: "2026-01-01T00:00:00Z",
	freeze_end_datetime: "2026-01-02T00:00:00Z",
};
const active = {
	id: "target",
	freeze_start_datetime: "2026-01-01T00:00:00Z",
	freeze_end_datetime: null,
};
function page(
	current: number,
	data: NonNullable<FreezeListResponse["data"]>,
	more: boolean,
): FreezeListResponse {
	return {
		data,
		pagination: {
			current_page: current,
			max_page: 2,
			total_count: 2,
			limit: 100,
			has_next_page: more,
			has_previous_page: current > 1,
		},
	};
}
async function setup() {
	const client = createMockStreamPayClient();
	const adapter = createMockAdapter();
	await adapter.create({
		model: "subscription",
		data: createMockSubscriptionRow({
			id: "owned",
			streampaySubscriptionId: "sub_owned",
			status: "frozen",
		}),
	});
	client.getSubscription.mockResolvedValue({ id: "sub_owned", status: "ACTIVE" });
	client.listSubscriptionFreezes.mockResolvedValue(page(1, [historical], true));
	const list =
		vi.fn<(id: string, params: { page: number; limit: number }) => Promise<FreezeListResponse>>();
	const plan = {
		name: "pro",
		productId: "prod_pro",
		priceInSmallestUnit: 100,
		billingInterval: "MONTH" as const,
	};
	const endpoints = buildSubscriptionEndpoints(
		createTestStreamPayOptions({ client }),
		{ plans: [plan], listSubscriptionFreezes: list },
		async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
	);
	const ctx = createMockContext({ body: { subscriptionId: "owned", freezeId: "target" } });
	ctx.context.adapter = adapter;
	return { client, adapter, list, endpoints, ctx };
}

describe("freeze history pagination", () => {
	it("cancels a requested freeze found on the second page", async () => {
		const { client, list, endpoints, ctx } = await setup();
		list
			.mockResolvedValueOnce(page(1, [historical], true))
			.mockResolvedValueOnce(page(2, [active], false));
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).resolves.toMatchObject({
			canceled: true,
			reused: false,
		});
		expect(client.deleteSubscriptionFreeze).toHaveBeenCalledWith("sub_owned", "target");
		expect(list.mock.calls).toEqual([
			["sub_owned", { page: 1, limit: 100 }],
			["sub_owned", { page: 2, limit: 100 }],
		]);
	});
	it("unfreezes an active period on the second page and reconciles access", async () => {
		const { client, adapter, list, endpoints, ctx } = await setup();
		list
			.mockResolvedValueOnce(page(1, [historical], true))
			.mockResolvedValueOnce(page(2, [active], false));
		await expect(unwrapHandler(endpoints.unfreezeSubscription)(ctx)).resolves.toEqual({
			unfrozen: true,
		});
		expect(client.updateSubscriptionFreeze).toHaveBeenCalledWith(
			"sub_owned",
			"target",
			expect.objectContaining({
				freeze_start_datetime: active.freeze_start_datetime,
				freeze_end_datetime: expect.any(String),
			}),
		);
		expect(adapter.tables.subscription?.[0]?.status).toBe("active");
	});
	it("acknowledges an absent freeze only after completing the history", async () => {
		const { client, list, endpoints, ctx } = await setup();
		list
			.mockResolvedValueOnce(page(1, [historical], true))
			.mockResolvedValueOnce(page(2, [], false));
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).resolves.toMatchObject({
			canceled: true,
			reused: true,
		});
		expect(list).toHaveBeenCalledTimes(2);
		expect(client.deleteSubscriptionFreeze).not.toHaveBeenCalled();
	});
	it.each([
		"cancel",
		"unfreeze",
	])("does not mutate or falsely acknowledge %s after a later page fails", async (action) => {
		const { client, adapter, list, endpoints, ctx } = await setup();
		list
			.mockResolvedValueOnce(page(1, [historical], true))
			.mockRejectedValueOnce(new Error("provider unavailable"));
		const endpoint =
			action === "cancel" ? endpoints.cancelSubscriptionFreeze : endpoints.unfreezeSubscription;
		await expect(unwrapHandler(endpoint)(ctx)).rejects.toThrow();
		expect(list).toHaveBeenCalledTimes(2);
		expect(client.deleteSubscriptionFreeze).not.toHaveBeenCalled();
		expect(client.updateSubscriptionFreeze).not.toHaveBeenCalled();
		expect(adapter.tables.subscription?.[0]?.status).toBe("frozen");
	});
	it.each([
		"repeated IDs",
		"nonadvancing page",
	])("fails with a bounded conflict on %s", async (fault) => {
		const { client, list, endpoints, ctx } = await setup();
		list
			.mockResolvedValueOnce(page(1, [historical], true))
			.mockResolvedValue(
				page(
					fault === "nonadvancing page" ? 1 : 2,
					fault === "repeated IDs" ? [historical] : [{ ...historical, id: "different" }],
					true,
				),
			);
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).rejects.toMatchObject({
			status: "CONFLICT",
		});
		expect(list.mock.calls.length).toBeLessThanOrEqual(3);
		expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(client.deleteSubscriptionFreeze).not.toHaveBeenCalled();
	});
	it("checks ownership before invoking the history callback", async () => {
		const { adapter, list, endpoints, ctx } = await setup();
		await adapter.update({
			model: "subscription",
			where: [{ field: "id", value: "owned" }],
			update: { referenceId: "another_user" },
		});
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).rejects.toThrow();
		expect(list).not.toHaveBeenCalled();
	});
	it.each([
		["missing data", { pagination: page(1, [], false).pagination }],
		["non-array data", { ...page(1, [], false), data: {} }],
		["missing pagination", { data: [] }],
		["missing continuation flag", { data: [], pagination: { current_page: 1 } }],
		["incorrect current page", page(2, [], false)],
		["empty page with continuation", page(1, [], true)],
	])("rejects %s without claiming a freeze is canceled", async (_name, response) => {
		const { client, list, endpoints, ctx } = await setup();
		list.mockResolvedValue(response as unknown as FreezeListResponse);
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).rejects.toMatchObject({
			status: "CONFLICT",
		});
		expect(list).toHaveBeenCalledTimes(1);
		expect(client.deleteSubscriptionFreeze).not.toHaveBeenCalled();
		expect(client.updateSubscriptionFreeze).not.toHaveBeenCalled();
	});
	it("bounds a provider history that keeps returning unique pages", async () => {
		const { client, list, endpoints, ctx } = await setup();
		list.mockImplementation(async (_id, params) =>
			page(params.page, [{ ...historical, id: `old_${params.page}` }], true),
		);
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).rejects.toMatchObject({
			status: "CONFLICT",
		});
		expect(list).toHaveBeenCalledTimes(100);
		expect(client.deleteSubscriptionFreeze).not.toHaveBeenCalled();
		expect(client.updateSubscriptionFreeze).not.toHaveBeenCalled();
	});
});
