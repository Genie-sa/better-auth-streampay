import { getTestInstance } from "better-auth/test";
import { streampayClient as createStreamPayClientPlugin } from "../../src/client";
import { streampay } from "../../src/streampay";
import type { StreamPayOptions, StreamPayPlugins } from "../../src/types";
import { createMockStreamPayClient, type MockedStreamPayClient } from "./mocks";

interface StreamPayTestInstanceOptions {
	client?: MockedStreamPayClient;
	streamPayOptions?: Partial<Omit<StreamPayOptions, "client" | "use">>;
	use?: StreamPayPlugins;
	disableTestUser?: boolean;
}

type AuthSuccessContext = {
	data: unknown;
	request: Request;
	response: Response;
};
type AuthCredentials = { email: string; password: string; name?: string };

export interface StreamPayTestInstance {
	auth: {
		api: Record<string, unknown>;
		handler: (request: Request) => Response | Promise<Response>;
		options: { plugins?: Array<{ id: string; version?: string }> };
		$context: Promise<{
			adapter: {
				findOne: <T>(input: {
					model: string;
					where: Array<{ field: string; value: unknown }>;
				}) => Promise<T | null>;
			};
		}>;
	};
	client: {
		signUp: {
			email: (
				credentials: AuthCredentials,
				options?: { throw?: boolean },
			) => Promise<{ user: { id: string } }>;
		};
		signIn: {
			email: (
				credentials: AuthCredentials,
				options?: {
					throw?: boolean;
					onSuccess?: (context: AuthSuccessContext) => void;
				},
			) => Promise<unknown>;
		};
	};
	sessionSetter: (headers: Headers) => (context: AuthSuccessContext) => void;
	streamPayClient: MockedStreamPayClient;
}

export async function createStreamPayTestInstance({
	client = createMockStreamPayClient(),
	streamPayOptions = {},
	use = [],
	disableTestUser = true,
}: StreamPayTestInstanceOptions = {}): Promise<StreamPayTestInstance> {
	const instance = await getTestInstance(
		{
			plugins: [
				streampay({
					client,
					use,
					...streamPayOptions,
				}),
			],
		},
		{
			disableTestUser,
			clientOptions: {
				plugins: [createStreamPayClientPlugin()],
			},
		},
	);

	return { ...instance, streamPayClient: client } as StreamPayTestInstance;
}

export async function callAuthEndpoint(
	auth: StreamPayTestInstance["auth"],
	path: string,
	init: {
		method?: string;
		body?: unknown;
		headers?: HeadersInit;
	} = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.body !== undefined && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}

	const requestInit: RequestInit = {
		method: init.method ?? "GET",
		headers,
	};
	if (init.body !== undefined) {
		requestInit.body = JSON.stringify(init.body);
	}

	return auth.handler(new Request(`http://localhost:3000/api/auth${path}`, requestInit));
}
