import type { BetterAuthClientPlugin } from "better-auth";
import type { streampay } from "./streampay";

export const streampayClient = () => {
	return {
		id: "streampay-client",
		$InferServerPlugin: {} as ReturnType<typeof streampay>,
	} satisfies BetterAuthClientPlugin;
};
