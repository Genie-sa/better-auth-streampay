import type { MockCtx } from "./mocks";

/**
 * The shape that `createAuthEndpoint` returns inside our test bundle.
 * When the plugin's sub-factories call `createAuthEndpoint(path, config,
 * handler)`, our mock swaps in this plain object so we can call
 * `handler(ctx)` directly.
 */
export interface MockedEndpoint<TResult = unknown> {
	path: string;
	config: unknown;
	handler: (ctx: MockCtx) => Promise<TResult>;
}

/**
 * Minimal APIError class that mirrors Better Auth's real constructor
 * signature. Kept here so test files can import it for `instanceof`
 * checks, but NOT registered as a mock from this module — Vitest hoists
 * `vi.mock` per file, and centralizing it in a helper module breaks
 * import ordering. Each test file installs its own mock via `vi.hoisted`.
 */
export class MockAPIError extends Error {
	public readonly code: string;
	public readonly data: { message?: string } | undefined;

	constructor(code: string, data?: { message?: string }) {
		super(data?.message ?? code);
		this.name = "APIError";
		this.code = code;
		this.data = data;
	}
}

/**
 * The `createAuthEndpoint` mock returns `{ path, config, handler }`; the
 * real type system doesn't know that. This helper performs the single,
 * narrowly-scoped structural cast so tests can grab a handler with
 * full intellisense and zero inline `as` noise.
 *
 * @param endpoint the value returned from calling a sub-plugin factory
 *   (e.g. `checkout()(mockClient).checkout`)
 * @returns the async handler typed against `MockCtx` and the caller's
 *   declared result type
 */
export function unwrapHandler<TResult = unknown>(
	endpoint: unknown,
): (ctx: MockCtx) => Promise<TResult> {
	const shape = endpoint as { handler?: (ctx: MockCtx) => Promise<TResult> };
	if (typeof shape.handler !== "function") {
		throw new Error("unwrapHandler: value is not a mocked endpoint object");
	}
	return shape.handler;
}
