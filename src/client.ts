import type { BetterAuthClientPlugin } from "better-auth";
import { $ERROR_CODES } from "./error-codes";
import type { streampay } from "./streampay";

export { $ERROR_CODES, type StreamPayErrorCode } from "./error-codes";

/** Better Auth client plugin. Add to `createAuthClient` to type the StreamPay endpoints and error codes. */
export const streampayClient = () => {
	return {
		id: "streampay-client",
		$InferServerPlugin: {} as ReturnType<typeof streampay>,
		$ERROR_CODES,
	} satisfies BetterAuthClientPlugin;
};
