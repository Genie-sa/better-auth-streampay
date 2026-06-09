import type { User } from "better-auth";
import type { StreamPayHookContext } from "../../src/hooks/consumer";
import type { MockCtx } from "./mocks";

type HookFn<TUser> = (
	user: TUser,
	context: StreamPayHookContext | null,
) => Promise<unknown> | unknown;

export async function invokeHook<TUser extends Partial<User>>(
	hook: HookFn<TUser>,
	user: TUser,
	context: MockCtx | null,
): Promise<unknown> {
	return await hook(user, context);
}

export type HookUser = User & { streampayConsumerId: string | null };
