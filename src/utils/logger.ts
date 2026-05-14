/**
 * Better Auth's logger wraps every message with `[Better Auth]: …`. Every
 * line that originates in this plugin should additionally carry a
 * `[streampay]` token so operators can filter the plugin's output with
 * a single regex regardless of Better Auth's outer formatting.
 *
 * Wire it once at the top of any code path that owns a `ctx.context.logger`
 * (endpoint handler, sync function, hook). The shape mirrors the subset
 * of Better Auth's logger the plugin actually calls — keeping the surface
 * minimal avoids tight-coupling to logger features we don't depend on.
 */

export interface ScopedLogger {
	error: (message: string) => void;
	warn: (message: string) => void;
	info: (message: string) => void;
	debug: (message: string) => void;
}

interface UnderlyingLogger {
	error: (message: string) => void;
	warn: (message: string) => void;
	info: (message: string) => void;
	debug: (message: string) => void;
}

const PLUGIN_PREFIX = "[streampay]";

export function scopedLogger(logger: UnderlyingLogger): ScopedLogger {
	return {
		error: (message) => logger.error(`${PLUGIN_PREFIX} ${message}`),
		warn: (message) => logger.warn(`${PLUGIN_PREFIX} ${message}`),
		info: (message) => logger.info(`${PLUGIN_PREFIX} ${message}`),
		debug: (message) => logger.debug(`${PLUGIN_PREFIX} ${message}`),
	};
}

/**
 * Pulls Better Auth's request logger from any context shape that has one
 * and wraps it with the plugin prefix. Use at the top of every endpoint
 * handler, webhook callback, or hook body that emits log lines.
 */
export function getLogger(ctx: { context: { logger: UnderlyingLogger } }): ScopedLogger {
	return scopedLogger(ctx.context.logger);
}
