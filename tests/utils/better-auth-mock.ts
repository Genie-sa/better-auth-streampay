import type { MockCtx } from "./mocks";

export interface MockedEndpoint<TResult = unknown> {
	path: string;
	config: unknown;
	handler: (ctx: MockCtx) => Promise<TResult>;
}

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

export function unwrapHandler<TResult = unknown>(
	endpoint: unknown,
): (ctx: MockCtx) => Promise<TResult> {
	const shape = endpoint as { handler?: (ctx: MockCtx) => Promise<TResult> };
	if (typeof shape.handler !== "function") {
		throw new Error("unwrapHandler: value is not a mocked endpoint object");
	}
	return shape.handler;
}
