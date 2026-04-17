import { vi } from "vitest";
import type { StreamPayOptions, StreamPayPlugins } from "../../src/types";
import { createMockStreamPayClient } from "./mocks";

/**
 * Build a `StreamPayOptions` with sensible test defaults. `use` falls
 * back to an empty tuple — the main plugin factory accepts it because
 * `StreamPayPlugins` is now `readonly StreamPayPlugin[]`, so hook tests
 * that don't exercise any sub-plugin can omit it entirely.
 *
 * Leaves `createConsumerOnSignUp` unset (matching the public default of
 * `false`). Tests that exercise the eager signup path pass it as an
 * override.
 */
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

/**
 * Variant of `createTestStreamPayOptions` that opts the plugin into the
 * eager signup flow (`createConsumerOnSignUp: true`). Use in tests that
 * specifically exercise `onBeforeUserCreate` / `onAfterUserCreate` /
 * `onUserUpdate` / `onUserDelete`.
 */
export const createEagerTestStreamPayOptions = (
	overrides: Partial<Omit<StreamPayOptions, "use">> & { use?: StreamPayPlugins } = {},
): StreamPayOptions =>
	createTestStreamPayOptions({ createConsumerOnSignUp: true, ...overrides });

/**
 * Build an `Error` that mimics the `StreamSDKError` shape the real SDK
 * throws on a non-2xx response. The important field for our plugin is
 * `.body`, which carries the StreamPay JSON envelope. `.message` follows
 * the SDK's "HTTP <status> calling ..." convention so tests read well.
 */
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

/**
 * Produce a minimal logger with every level stubbed to `vi.fn()`. Handy
 * for tests that need their own logger rather than the one on `MockCtx`.
 */
export const createMockLogger = (): {
	error: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	info: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
} => ({
	error: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
});
