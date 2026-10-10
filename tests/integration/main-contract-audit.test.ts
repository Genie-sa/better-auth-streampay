import type { User } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it, vi } from "vitest";
import { streampayClient } from "../../src/client";
import { onUserUpdate, type StreamPayHookContext } from "../../src/hooks/consumer";
import { checkout } from "../../src/plugins/checkout";
import { portal } from "../../src/plugins/portal";
import { streampay } from "../../src/streampay";
import type { StreamPayOptions } from "../../src/types";
import { type EnsureConsumerContext, ensureConsumerForUser } from "../../src/utils/ensure-consumer";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";
import { mockApiError } from "../utils/helpers";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockPaymentLink,
	createMockStreamPayClient,
} from "../utils/mocks";

const PHONE = "+966500000000";

async function createLazyHarness() {
	const { auth, client, streamPayClient } = await createStreamPayTestInstance();
	const firstEmail = "lazy-first@example.com";
	const secondEmail = "lazy-second@example.com";
	const first = await client.signUp.email(
		{ name: "First", email: firstEmail, password: "password123" },
		{ throw: true },
	);
	const second = await client.signUp.email(
		{ name: "Second", email: secondEmail, password: "password123" },
		{ throw: true },
	);
	const database = await auth.$context;
	const context = {
		context: {
			logger: { error() {}, warn() {}, info() {}, debug() {} },
			adapter: database.adapter,
			internalAdapter: {
				updateUser: (id: string, update: Record<string, unknown>) =>
					database.adapter.update({
						model: "user",
						where: [{ field: "id", value: id }],
						update,
					}),
			},
		},
	} as unknown as EnsureConsumerContext;
	const options: StreamPayOptions = {
		client: streamPayClient,
		use: [],
		claimExistingConsumerBy: ["phone"],
		getConsumerCreateParams: () => ({ phone_number: PHONE }),
	};
	const duplicate = Object.assign(new Error("duplicate consumer"), {
		name: "StreamSDKError",
		status: 409,
		body: { error: { code: "DUPLICATE_CONSUMER" } },
	});
	const strandedConsumer = createMockConsumer({
		id: "lazy-stranded-consumer",
		phone_number: PHONE,
		external_id: null,
	});
	streamPayClient.createConsumer.mockRejectedValue(duplicate);
	streamPayClient.listConsumers.mockImplementation(async (params) =>
		params?.search_term === PHONE
			? createMockConsumerList([strandedConsumer])
			: createMockConsumerList([]),
	);
	return {
		database,
		options,
		context,
		streamPayClient,
		first: { id: first.user.id, email: firstEmail },
		second: { id: second.user.id, email: secondEmail },
		strandedConsumer,
	};
}

async function createLinkedSecondaryStorageSession(email: string) {
	const values = new Map<string, string>();
	const secondaryStorage = {
		get: async (key: string) => values.get(key) ?? null,
		getAndDelete: async (key: string) => {
			const value = values.get(key) ?? null;
			values.delete(key);
			return value;
		},
		increment: async (key: string) => {
			const value = Number(values.get(key) ?? 0) + 1;
			values.set(key, String(value));
			return value;
		},
		set: async (key: string, value: string) => {
			values.set(key, value);
		},
		delete: async (key: string) => {
			values.delete(key);
		},
	};
	const streamPayClient = createMockStreamPayClient();
	streamPayClient.getConsumer.mockResolvedValue(createMockConsumer({ id: "claimed-consumer" }));
	streamPayClient.listConsumers.mockResolvedValue(createMockConsumerList([]));
	streamPayClient.createConsumer.mockResolvedValue(
		createMockConsumer({ id: "fresh-consumer-after-rollback" }),
	);
	streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
	streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");
	const { auth, client, sessionSetter } = await getTestInstance(
		{
			secondaryStorage,
			plugins: [streampay({ client: streamPayClient, use: [checkout(), portal()] })],
		},
		{ disableTestUser: true, clientOptions: { plugins: [streampayClient()] } },
	);
	const credentials = { name: "Cache test", email, password: "password123" };
	const created = await client.signUp.email(credentials, { throw: true });
	const headers = new Headers();
	await client.signIn.email(credentials, { throw: true, onSuccess: sessionSetter(headers) });
	const context = await auth.$context;
	await context.internalAdapter.updateUser(created.user.id, {
		streampayConsumerId: "claimed-consumer",
	});
	const linkedSession = [...values.values()]
		.map((value) => JSON.parse(value))
		.find((value) => value.user?.id === created.user.id);
	expect(linkedSession?.user.streampayConsumerId).toBe("claimed-consumer");
	return { auth, context, headers, streamPayClient, userId: created.user.id };
}

function checkoutRequest(headers: Headers): Request {
	const requestHeaders = new Headers(headers);
	requestHeaders.set("content-type", "application/json");
	return new Request("http://localhost:3000/api/auth/checkout", {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({ products: "11111111-1111-4111-8111-111111111111" }),
	});
}

describe("eager consumer duplicate ownership audit", () => {
	it("does not use a rolled-back consumer link cached in a secondary-storage session", async () => {
		const { auth, context, headers, streamPayClient, userId } =
			await createLinkedSecondaryStorageSession("secondary-cache@example.com");

		await context.adapter.update({
			model: "user",
			where: [
				{ field: "id", value: userId },
				{ field: "streampayConsumerId", value: "claimed-consumer" },
			],
			update: { streampayConsumerId: null },
		});

		const portalResponse = await auth.handler(
			new Request("http://localhost:3000/api/auth/consumer/state", { headers }),
		);
		const response = await auth.handler(checkoutRequest(headers));
		expect(portalResponse.status).toBe(200);
		expect(await portalResponse.json()).toMatchObject({ hasConsumer: false, consumer: null });
		expect(response.status).toBe(200);
		expect(streamPayClient.createPaymentLink).toHaveBeenCalledWith(
			expect.objectContaining({
				organization_consumer_id: "fresh-consumer-after-rollback",
			}),
		);
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalledWith(
			expect.objectContaining({ organization_consumer_id: "claimed-consumer" }),
		);
	});

	it("rejects a cached linked session after its account has been deleted", async () => {
		const { auth, context, headers, streamPayClient, userId } =
			await createLinkedSecondaryStorageSession("secondary-deleted@example.com");
		await context.adapter.delete({ model: "user", where: [{ field: "id", value: userId }] });

		const response = await auth.handler(checkoutRequest(headers));

		expect(response.status).toBe(401);
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalled();
	});

	it("fails closed when the database cannot validate a cached consumer link", async () => {
		const { auth, context, headers, streamPayClient } = await createLinkedSecondaryStorageSession(
			"secondary-read-error@example.com",
		);
		vi.spyOn(context.adapter, "findOne").mockRejectedValueOnce(new Error("database unavailable"));

		const response = await auth.handler(checkoutRequest(headers));

		expect(response.status).toBe(500);
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalled();
	});

	it("does not let a new signup reclaim a consumer linked to an existing local user", async () => {
		const linkedConsumer = createMockConsumer({
			id: "consumer-owned-by-first-user",
			email: "first@example.com",
			phone_number: "+966500000000",
			external_id: null,
		});
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			streamPayOptions: {
				createConsumerOnSignUp: true,
				claimExistingConsumerBy: ["phone"],
				getConsumerCreateParams: () => ({ phone_number: "+966500000000" }),
			},
		});
		streamPayClient.createConsumer.mockResolvedValueOnce(linkedConsumer);
		streamPayClient.createConsumer.mockRejectedValueOnce(
			Object.assign(new Error("duplicate consumer"), {
				name: "StreamSDKError",
				status: 409,
				body: { error: { code: "DUPLICATE_CONSUMER" } },
			}),
		);
		streamPayClient.updateConsumer.mockResolvedValue(linkedConsumer);

		const first = await callAuthEndpoint(auth, "/sign-up/email", {
			method: "POST",
			body: { name: "First", email: "first@example.com", password: "password123" },
		});
		expect(first.status).toBe(200);
		const firstUser = (await first.json()) as { user: { id: string } };

		streamPayClient.listConsumers.mockResolvedValue(
			createMockConsumerList([{ ...linkedConsumer, external_id: firstUser.user.id }]),
		);
		const second = await callAuthEndpoint(auth, "/sign-up/email", {
			method: "POST",
			body: { name: "Second", email: "second@example.com", password: "password123" },
		});

		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({
			code: "STREAMPAY_CONSUMER_LINK_CONFLICT",
		});
		expect(streamPayClient.updateConsumer.mock.calls.map(([, patch]) => patch.external_id)).toEqual(
			[firstUser.user.id],
		);
		const localOwner = await (await auth.$context).adapter.findOne<{
			id: string;
			streampayConsumerId: string;
		}>({
			model: "user",
			where: [{ field: "id", value: firstUser.user.id }],
		});
		expect(localOwner?.streampayConsumerId).toBe(linkedConsumer.id);
	});

	it("reuses an unclaimed duplicate consumer and links it to the new signup", async () => {
		const strandedConsumer = createMockConsumer({
			id: "stranded-consumer",
			email: "previous@example.com",
			phone_number: "+966500000000",
			external_id: null,
		});
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			streamPayOptions: {
				createConsumerOnSignUp: true,
				claimExistingConsumerBy: ["phone"],
				getConsumerCreateParams: () => ({ phone_number: "+966500000000" }),
			},
		});
		streamPayClient.createConsumer.mockRejectedValue(
			Object.assign(new Error("duplicate consumer"), {
				name: "StreamSDKError",
				status: 409,
				body: { error: { code: "DUPLICATE_CONSUMER" } },
			}),
		);
		streamPayClient.listConsumers.mockResolvedValue(createMockConsumerList([strandedConsumer]));
		streamPayClient.updateConsumer.mockResolvedValue(strandedConsumer);

		const response = await callAuthEndpoint(auth, "/sign-up/email", {
			method: "POST",
			body: { name: "New owner", email: "new-owner@example.com", password: "password123" },
		});
		expect(response.status).toBe(200);
		const created = (await response.json()) as { user: { id: string } };

		const user = await (await auth.$context).adapter.findOne<
			User & { streampayConsumerId: string }
		>({
			model: "user",
			where: [{ field: "id", value: created.user.id }],
		});
		expect(user?.streampayConsumerId).toBe(strandedConsumer.id);
		expect(
			streamPayClient.updateConsumer.mock.calls.map(([id, patch]) => [id, patch.external_id]),
		).toEqual([[strandedConsumer.id, created.user.id]]);
	});

	it("does not clear a replacement consumer link when stale-link cleanup races with a relink", async () => {
		const { auth, client, streamPayClient } = await createStreamPayTestInstance();
		const created = await client.signUp.email(
			{ name: "Owner", email: "link-race@example.com", password: "password123" },
			{ throw: true },
		);
		const context = await auth.$context;
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: created.user.id }],
			update: { streampayConsumerId: "old-consumer" },
		});

		let beginLookup!: () => void;
		let failLookup!: (error: Error) => void;
		const lookupStarted = new Promise<void>((resolve) => {
			beginLookup = resolve;
		});
		streamPayClient.getConsumer.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					failLookup = reject;
					beginLookup();
				}),
		);

		const hookContext = {
			context: {
				logger: { error() {}, warn() {}, info() {}, debug() {} },
				adapter: context.adapter,
				internalAdapter: {
					updateUser: (id: string, update: Record<string, unknown>) =>
						context.adapter.update({
							model: "user",
							where: [{ field: "id", value: id }],
							update,
						}),
				},
			},
		} as unknown as StreamPayHookContext;
		const updateUser = onUserUpdate({ client: streamPayClient, use: [] });
		const user = await context.adapter.findOne<User & { streampayConsumerId: string }>({
			model: "user",
			where: [{ field: "id", value: created.user.id }],
		});
		expect(user?.streampayConsumerId).toBe("old-consumer");
		const inFlight = updateUser(user as User, hookContext);
		await lookupStarted;
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: created.user.id }],
			update: { streampayConsumerId: "replacement-consumer" },
		});
		failLookup(mockApiError(404, { error: { code: "NOT_FOUND" } }, "GET"));
		await inFlight;

		const persisted = await context.adapter.findOne<{ streampayConsumerId: string }>({
			model: "user",
			where: [{ field: "id", value: created.user.id }],
		});
		expect(persisted?.streampayConsumerId).toBe("replacement-consumer");
	});

	it("claims a lazy duplicate locally before back-linking it upstream", async () => {
		const { database, options, context, streamPayClient, first, second, strandedConsumer } =
			await createLazyHarness();
		let releaseFirstUpdate!: () => void;
		let firstUpdateStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstUpdateStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseFirstUpdate = resolve;
		});
		streamPayClient.updateConsumer.mockImplementation(async (consumerId, patch) => {
			if (patch.external_id === first.id) {
				firstUpdateStarted();
				await release;
			}
			return createMockConsumer({
				...strandedConsumer,
				id: consumerId,
				external_id: patch.external_id ?? strandedConsumer.external_id ?? null,
			});
		});

		const firstEnsure = ensureConsumerForUser(options, context, {
			...first,
			streampayConsumerId: null,
		});
		await started;
		const secondOutcome = await Promise.allSettled([
			ensureConsumerForUser(options, context, { ...second, streampayConsumerId: null }),
		]);
		releaseFirstUpdate();
		const firstOutcome = await Promise.allSettled([firstEnsure]);

		expect(secondOutcome[0]).toMatchObject({
			status: "rejected",
			reason: {
				status: "CONFLICT",
				statusCode: 409,
				body: { code: "STREAMPAY_CONSUMER_LINK_CONFLICT" },
			},
		});
		expect(firstOutcome[0].status).toBe("fulfilled");
		expect(streamPayClient.updateConsumer.mock.calls).toEqual([
			[strandedConsumer.id, { external_id: first.id }],
		]);
		const owner = await database.adapter.findOne<User & { streampayConsumerId: string }>({
			model: "user",
			where: [{ field: "streampayConsumerId", value: strandedConsumer.id }],
		});
		expect(owner?.id).toBe(first.id);
	});

	it("releases a failed lazy backfill claim so a retry can recover", async () => {
		const { database, options, context, streamPayClient, first, strandedConsumer } =
			await createLazyHarness();
		let claimedAtProviderBoundary: string | null = null;
		streamPayClient.updateConsumer.mockImplementationOnce(async () => {
			const owner = await database.adapter.findOne<User & { streampayConsumerId: string }>({
				model: "user",
				where: [{ field: "id", value: first.id }],
			});
			claimedAtProviderBoundary = owner?.streampayConsumerId ?? null;
			throw Object.assign(new Error("provider unavailable"), { status: 503 });
		});
		streamPayClient.updateConsumer.mockResolvedValueOnce(strandedConsumer);

		await expect(
			ensureConsumerForUser(options, context, { ...first, streampayConsumerId: null }),
		).rejects.toMatchObject({
			status: "INTERNAL_SERVER_ERROR",
			body: { code: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED" },
		});
		const afterFailure = await database.adapter.findOne<
			User & { streampayConsumerId: string | null }
		>({
			model: "user",
			where: [{ field: "id", value: first.id }],
		});
		const outcome = await Promise.allSettled([
			ensureConsumerForUser(options, context, {
				...first,
				streampayConsumerId: afterFailure?.streampayConsumerId ?? null,
			}),
		]);

		expect(claimedAtProviderBoundary).toBe(strandedConsumer.id);
		expect(afterFailure?.streampayConsumerId).toBeNull();
		expect(outcome[0].status).toBe("fulfilled");
		const afterRetry = await database.adapter.findOne<User & { streampayConsumerId: string }>({
			model: "user",
			where: [{ field: "id", value: first.id }],
		});
		expect(afterRetry?.streampayConsumerId).toBe(strandedConsumer.id);
		expect(streamPayClient.updateConsumer.mock.calls).toHaveLength(2);
	});

	it("does not roll back a replacement link when failed backfill races with relinking", async () => {
		const { database, options, context, streamPayClient, first, strandedConsumer } =
			await createLazyHarness();
		streamPayClient.updateConsumer.mockImplementationOnce(async () => {
			await database.adapter.update({
				model: "user",
				where: [{ field: "id", value: first.id }],
				update: { streampayConsumerId: "replacement-consumer" },
			});
			throw Object.assign(new Error("provider unavailable"), { status: 503 });
		});

		await expect(
			ensureConsumerForUser(options, context, { ...first, streampayConsumerId: null }),
		).rejects.toMatchObject({
			status: "INTERNAL_SERVER_ERROR",
			body: { code: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED" },
		});
		const persisted = await database.adapter.findOne<User & { streampayConsumerId: string }>({
			model: "user",
			where: [{ field: "id", value: first.id }],
		});
		expect(persisted?.streampayConsumerId).toBe("replacement-consumer");
		expect(streamPayClient.updateConsumer).toHaveBeenCalledWith(strandedConsumer.id, {
			external_id: first.id,
		});
	});
});
