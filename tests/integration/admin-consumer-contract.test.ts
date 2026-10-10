import { describe, expect, it } from "vitest";
import { admin } from "../../src";
import type { SyncContext } from "../../src/plugins/subscriptions/sync";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";
import { createMockConsumer } from "../utils/mocks";

describe("admin consumer deletion ownership", () => {
	it("preserves a new user linkage committed after the deletion cleanup read", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [admin({ isAdmin: () => true })],
		});
		const owner = await client.signUp.email(
			{ name: "Owner", email: "consumer-race@example.com", password: "password123" },
			{ throw: true },
		);
		const context = (await auth.$context) as SyncContext["context"];
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: owner.user.id }],
			update: { streampayConsumerId: "deleted-consumer" },
		});
		streamPayClient.getConsumer.mockResolvedValue(
			createMockConsumer({ id: "deleted-consumer", external_id: owner.user.id }),
		);
		streamPayClient.deleteConsumer.mockResolvedValue(undefined);
		const headers = new Headers();
		await client.signIn.email(
			{ email: "consumer-race@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		const findOne = context.adapter.findOne;
		let moved = false;
		context.adapter.findOne = async <T>(
			input: Parameters<SyncContext["context"]["adapter"]["findOne"]>[0],
		) => {
			const row = await findOne<T>(input);
			if (
				input.model === "user" &&
				input.where.some(({ field }) => field === "streampayConsumerId") &&
				row &&
				!moved
			) {
				moved = true;
				await context.adapter.update({
					model: "user",
					where: [{ field: "id", value: owner.user.id }],
					update: { streampayConsumerId: "new-consumer" },
				});
			}
			return row;
		};
		try {
			const response = await callAuthEndpoint(auth, "/admin/streampay/consumers/deleted-consumer", {
				method: "DELETE",
				headers,
			});
			expect(response.status).toBe(200);
			expect(moved).toBe(true);
			expect(
				await context.adapter.findOne({
					model: "user",
					where: [{ field: "id", value: owner.user.id }],
				}),
			).toMatchObject({ streampayConsumerId: "new-consumer" });
		} finally {
			context.adapter.findOne = findOne;
		}
	});

	it("clears the actual linked user while preserving the different consumer of external_id's user", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [admin({ isAdmin: () => true })],
		});
		const owner = await client.signUp.email(
			{ name: "Owner", email: "consumer-owner@example.com", password: "password123" },
			{ throw: true },
		);
		const unrelated = await client.signUp.email(
			{ name: "Unrelated", email: "consumer-other@example.com", password: "password123" },
			{ throw: true },
		);
		const context = (await auth.$context) as SyncContext["context"];
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: owner.user.id }],
			update: { streampayConsumerId: "deleted-consumer" },
		});
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: unrelated.user.id }],
			update: { streampayConsumerId: "other-consumer" },
		});
		streamPayClient.getConsumer.mockResolvedValue(
			createMockConsumer({ id: "deleted-consumer", external_id: unrelated.user.id }),
		);
		streamPayClient.deleteConsumer.mockResolvedValue(undefined);
		const headers = new Headers();
		await client.signIn.email(
			{ email: "consumer-owner@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		const response = await callAuthEndpoint(auth, "/admin/streampay/consumers/deleted-consumer", {
			method: "DELETE",
			headers,
		});
		expect(response.status).toBe(200);
		expect(
			await context.adapter.findOne({
				model: "user",
				where: [{ field: "id", value: owner.user.id }],
			}),
		).toMatchObject({ streampayConsumerId: null });
		expect(
			await context.adapter.findOne({
				model: "user",
				where: [{ field: "id", value: unrelated.user.id }],
			}),
		).toMatchObject({ streampayConsumerId: "other-consumer" });
	});
});
