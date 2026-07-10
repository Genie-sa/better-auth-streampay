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
		where?: Array<{ field: string; value: unknown }>;
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
