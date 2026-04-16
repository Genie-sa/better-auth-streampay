import type { User } from "better-auth";
import type { StreamPayHookContext } from "../../src/hooks/consumer";
import type { MockCtx } from "./mocks";

/**
 * Call a StreamPay plugin hook from a test. Zero casts: the plugin's
 * hooks are parameterized on `StreamPayHookContext`, a narrow interface
 * that `MockCtx` structurally satisfies.
 *
 * The return type is deliberately wide (`unknown`) because the `before`
 * variant of a Better Auth create hook may return `{ data: {...} }`
 * (merged into the insert) while the `after` variant returns `void`.
 * Tests that need the before-hook's return value can cast the result.
 */
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
