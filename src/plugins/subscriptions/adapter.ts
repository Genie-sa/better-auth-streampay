export interface PluginAdapter {
	create: <T = unknown, D extends object = Record<string, unknown>>(args: {
		model: string;
		data: D;
	}) => Promise<T>;
	update: <T = unknown, D extends object = Record<string, unknown>>(args: {
		model: string;
		update: D;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<T | null>;
	findOne: <T = unknown>(args: {
		model: string;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<T | null>;
	findMany: <T = unknown>(args: {
		model: string;
		where?: Array<{ field: string; value: unknown; operator?: "lt" | "lte" }>;
		limit?: number;
		offset?: number;
		sortBy?: { field: string; direction: "asc" | "desc" };
	}) => Promise<T[]>;
	delete: (args: {
		model: string;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<void>;
	count: (args: {
		model: string;
		where?: Array<{ field: string; value: unknown }>;
	}) => Promise<number>;
}

export interface SyncContext {
	context: {
		adapter: PluginAdapter;
		logger: {
			error: (msg: string) => void;
			warn: (msg: string) => void;
			info: (msg: string) => void;
			debug: (msg: string) => void;
		};
		session?: { user?: unknown };
		internalAdapter?: {
			findUserById?: (userId: string) => Promise<unknown>;
		};
	};
}

/** Better Auth's endpoint context carries a structurally wider adapter than the plugin needs. */
export function toSyncContext(ctx: { context: unknown }): SyncContext {
	return { context: ctx.context as SyncContext["context"] };
}
