import type { BetterAuthPlugin } from "better-auth";
import {
	onAfterUserCreate,
	onBeforeUserCreate,
	onUserDelete,
	onUserUpdate,
} from "./hooks/consumer";
import type { StreamPayEndpoints, StreamPayOptions } from "./types";

export const streampay = <O extends StreamPayOptions>(options: O) => {
	const endpoints = options.use
		.map((use) => use(options))
		.reduce((acc, plugin) => {
			Object.assign(acc, plugin);
			return acc;
		}, {} as StreamPayEndpoints);

	return {
		id: "streampay",
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
