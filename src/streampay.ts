import type { BetterAuthPlugin } from "better-auth";
import {
	onAfterUserCreate,
	onBeforeUserCreate,
	onUserDelete,
	onUserUpdate,
} from "./hooks/consumer";
import type { StreamPayPluginRegistry } from "./plugins/subscriptions";
import type { StreamPayEndpoints, StreamPayOptions } from "./types";
import { version as PACKAGE_VERSION } from "./version";

export const streampay = <O extends StreamPayOptions>(options: O) => {
	const registry: StreamPayPluginRegistry = {};
	const endpoints = {} as StreamPayEndpoints;
	let extraSchema: Record<string, unknown> = {};

	for (const use of options.use) {
		const result = use(options, registry);
		Object.assign(endpoints, result.endpoints);
		if ("schema" in result && result.schema) {
			extraSchema = { ...extraSchema, ...result.schema };
		}
	}

	return {
		id: "streampay",
		version: PACKAGE_VERSION,
		endpoints,
		schema: {
			user: {
				fields: {
					streampayConsumerId: {
						type: "string",
						required: false,
						input: false,
					},
				},
			},
			...extraSchema,
		},
		init() {
			return {
				options: {
					databaseHooks: {
						user: {
							create: {
								before: onBeforeUserCreate(options),
								after: onAfterUserCreate(options),
							},
							update: {
								after: onUserUpdate(options),
							},
							delete: {
								after: onUserDelete(options),
							},
						},
					},
				},
			};
		},
	} satisfies BetterAuthPlugin;
};
