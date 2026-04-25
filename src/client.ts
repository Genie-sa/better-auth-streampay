import type { BetterAuthClientPlugin } from "better-auth";
import { $ERROR_CODES } from "./error-codes";
import type { streampay } from "./streampay";

export { $ERROR_CODES, type StreamPayErrorCode } from "./error-codes";

export const streampayClient = () => {
	return {
		id: "streampay-client",
		$InferServerPlugin: {} as ReturnType<typeof streampay>,
		// Exposed on the client plugin so Better Auth's client reflections
		// (and downstream UI code) can reach the taxonomy without importing
		// the server entry. Mirrors Better Auth's own convention — cf. the
		// organization plugin's `$ERROR_CODES` surface.
		$ERROR_CODES,
	} satisfies BetterAuthClientPlugin;
};
