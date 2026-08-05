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

function assertOrganizationBillingConfig(
	options: StreamPayOptions,
	plugins: readonly Pick<BetterAuthPlugin, "id" | "schema">[] | undefined,
): void {
	if (!options.organization?.enabled) return;

	const organizationPlugin = plugins?.find((plugin) => plugin.id === "organization");
	if (!organizationPlugin) {
		throw new Error(
			"streampay: `organization.enabled` requires the Better Auth organization plugin.",
		);
	}

	const pluginModelName = organizationPlugin.schema?.organization?.modelName ?? "organization";
	const configuredModelName = options.organization.modelName ?? "organization";
	if (pluginModelName !== configuredModelName) {
		throw new Error(
			`streampay: the organization plugin stores organizations in "${pluginModelName}" ` +
				`but StreamPay organization billing is configured for "${configuredModelName}". ` +
				`Set \`organization.modelName: "${pluginModelName}"\` on the streampay() options` +
				(options.organization.modelName
					? ""
					: " (or remove the custom name from the organization plugin)") +
				".",
		);
	}
}

const organizationBillingSchema = (modelName: string | undefined) =>
	({
		organization: {
			...(modelName ? { modelName } : {}),
			fields: {
				streampayConsumerId: {
					type: "string",
					required: false,
					input: false,
					unique: true,
				},
			},
		},
	}) as const;

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
						unique: true,
					},
				},
			},
			...(options.organization?.enabled
				? organizationBillingSchema(options.organization.modelName)
				: {}),
			...extraSchema,
		},
		init(ctx) {
			assertOrganizationBillingConfig(options, ctx.options.plugins);
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
	} satisfies BetterAuthPlugin & { version: string };
};
