import { vi } from "vitest";
import type { StreamPayOptions, StreamPayPlugins } from "../../src/types";
import { createMockStreamPayClient } from "./mocks";

export const createTestStreamPayOptions = (
	overrides: Partial<Omit<StreamPayOptions, "use">> & { use?: StreamPayPlugins } = {},
): StreamPayOptions => {
	const { use, ...rest } = overrides;
	return {
		client: createMockStreamPayClient(),
		use: use ?? ([] as StreamPayPlugins),
		...rest,
	};
};

export const createEagerTestStreamPayOptions = (
	overrides: Partial<Omit<StreamPayOptions, "use">> & { use?: StreamPayPlugins } = {},
): StreamPayOptions => createTestStreamPayOptions({ createConsumerOnSignUp: true, ...overrides });

export const mockApiError = (
	status: number,
	body: unknown,
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" = "POST",
	path: string = "/api/v2/test",
): Error => {
	const err = new Error(`HTTP ${status} calling ${method} ${path}`);
	Object.defineProperty(err, "status", { value: status, enumerable: true });
	Object.defineProperty(err, "body", { value: body, enumerable: true });
	err.name = "StreamSDKError";
	return err;
};

export const createMockLogger = (): {
	error: ReturnType<typeof vi.fn<(message: string) => void>>;
	warn: ReturnType<typeof vi.fn<(message: string) => void>>;
	info: ReturnType<typeof vi.fn<(message: string) => void>>;
	debug: ReturnType<typeof vi.fn<(message: string) => void>>;
} => ({
	error: vi.fn<(message: string) => void>(),
	warn: vi.fn<(message: string) => void>(),
	info: vi.fn<(message: string) => void>(),
	debug: vi.fn<(message: string) => void>(),
});
