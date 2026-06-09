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

export function getLogger(ctx: { context: { logger: UnderlyingLogger } }): ScopedLogger {
	return scopedLogger(ctx.context.logger);
}
