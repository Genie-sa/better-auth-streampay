import type { Where } from "better-auth";
import { APIError } from "better-auth/api";
import { formatStreamPayError } from "./format-error";
import { getLogger } from "./logger";
import type { StreamPaySessionUser } from "./session";

const USER_MODEL = "user";

interface UserLinkStore {
	findOne: <T = unknown>(input: { model: string; where: Where[] }) => Promise<T | null>;
	update?: (input: {
		model: string;
		update: Record<string, unknown>;
		where: Where[];
	}) => Promise<unknown>;
}

export interface StreamPayLoggerContext {
	context: {
		adapter?: UserLinkStore;
		internalAdapter?: {
			updateUser?: (userId: string, data: Record<string, unknown>) => Promise<unknown>;
			listUsers?: (
				limit: number,
				offset: number,
				sortBy: undefined,
				where: Where[],
			) => Promise<Record<string, unknown>[]>;
		};
		logger: {
			error: (message: string) => void;
			warn: (message: string) => void;
			info: (message: string) => void;
			debug: (message: string) => void;
		};
	};
}

export interface EnsureConsumerContext extends StreamPayLoggerContext {
	context: StreamPayLoggerContext["context"] & { adapter: UserLinkStore };
}

export function consumerLinkUnavailable(): APIError {
	return new APIError("INTERNAL_SERVER_ERROR", {
		code: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED",
		message: "StreamPay consumer linking failed. Please try again.",
	});
}

/**
 * The stored link always wins over the session copy: cookie and secondary-storage sessions can
 * outlive a link, an unlink, or a rollback in either direction.
 */
export async function getCurrentConsumerUser(
	ctx: StreamPayLoggerContext,
	user: StreamPaySessionUser,
): Promise<StreamPaySessionUser> {
	if (!ctx.context.adapter) {
		if (!user.streampayConsumerId) return user;
		throw new APIError("INTERNAL_SERVER_ERROR", { message: "Consumer storage is unavailable." });
	}
	const current = await ctx.context.adapter.findOne<StreamPaySessionUser>({
		model: USER_MODEL,
		where: [{ field: "id", value: user.id }],
	});
	if (!user.streampayConsumerId) {
		// An unlinked session must not hide a link written by a request it did not see.
		return current?.id === user.id && typeof current.streampayConsumerId === "string"
			? { ...user, streampayConsumerId: current.streampayConsumerId }
			: user;
	}
	if (!current || current.id !== user.id) {
		throw new APIError("UNAUTHORIZED", { message: "The account no longer exists." });
	}
	if (current.streampayConsumerId != null && typeof current.streampayConsumerId !== "string") {
		throw new APIError("INTERNAL_SERVER_ERROR", { message: "Invalid stored consumer link." });
	}
	return { ...user, streampayConsumerId: current.streampayConsumerId ?? null };
}

async function findConsumerOwner(
	ctx: StreamPayLoggerContext,
	consumerId: string,
): Promise<Record<string, unknown> | null> {
	try {
		// Better Auth before-create hooks run inside a transaction. Its internal
		// adapter uses that transaction; the outer adapter can deadlock on SQLite.
		const where: Where[] = [{ field: "streampayConsumerId", value: consumerId }];
		if (ctx.context.internalAdapter?.listUsers) {
			const owners = await ctx.context.internalAdapter.listUsers(1, 0, undefined, where);
			return owners[0] ?? null;
		}
		if (!ctx.context.adapter) throw consumerLinkUnavailable();
		return await ctx.context.adapter.findOne<Record<string, unknown>>({
			model: USER_MODEL,
			where,
		});
	} catch (err: unknown) {
		getLogger(ctx).error(
			`consumer ownership check failed for consumer=${consumerId}: ${formatStreamPayError(err)}`,
		);
		throw consumerLinkUnavailable();
	}
}

/** One consumer belongs to at most one user. */
export async function assertConsumerUnclaimed(
	ctx: StreamPayLoggerContext,
	consumerId: string,
	userId?: string,
): Promise<void> {
	const owner = await findConsumerOwner(ctx, consumerId);
	if (!owner) return;

	if (typeof owner.id !== "string") {
		getLogger(ctx).error(`consumer ownership check returned a user without an id: ${consumerId}`);
		throw consumerLinkUnavailable();
	}
	if (owner.id === userId) return;

	throw new APIError("CONFLICT", {
		code: "STREAMPAY_CONSUMER_LINK_CONFLICT",
		message: "This StreamPay consumer is already linked to another account.",
	});
}

/**
 * Links an unlinked user to `consumerId`. The guarded write is the only link mutation: it applies
 * only while the user is still unlinked, so concurrent first checkouts converge on whichever
 * consumer was stored first. `claimed` is false when another request stored the link, in which
 * case `consumerId` is that request's consumer and the caller must not undo or backfill it.
 */
export async function linkConsumer(
	ctx: EnsureConsumerContext,
	userId: string,
	consumerId: string,
): Promise<{ consumerId: string; claimed: boolean }> {
	const log = getLogger(ctx);
	await assertConsumerUnclaimed(ctx, consumerId, userId);
	const { update } = ctx.context.adapter;
	if (!update) throw consumerLinkUnavailable();
	let claimed: unknown;
	try {
		claimed = await update({
			model: USER_MODEL,
			where: [
				{ field: "id", value: userId },
				{ field: "streampayConsumerId", value: null },
			],
			update: { streampayConsumerId: consumerId },
		});
	} catch (err: unknown) {
		log.error(`consumer link write failed for user=${userId}: ${formatStreamPayError(err)}`);
		await assertConsumerUnclaimed(ctx, consumerId, userId);
		throw consumerLinkUnavailable();
	}
	if (claimed) return { consumerId, claimed: true };
	const stored = await ctx.context.adapter.findOne<StreamPaySessionUser>({
		model: USER_MODEL,
		where: [{ field: "id", value: userId }],
	});
	if (typeof stored?.streampayConsumerId === "string") {
		return { consumerId: stored.streampayConsumerId, claimed: false };
	}
	log.error(`consumer link write for user=${userId} matched no unlinked user row.`);
	throw consumerLinkUnavailable();
}

/** Clears the link only while it still points at `consumerId`, so a newer link survives. */
export async function unlinkConsumer(
	store: UserLinkStore,
	consumerId: string,
	userId?: string,
): Promise<void> {
	if (!store.update) throw consumerLinkUnavailable();
	const ownerId =
		userId ??
		(
			await store.findOne<{ id: string }>({
				model: USER_MODEL,
				where: [{ field: "streampayConsumerId", value: consumerId }],
			})
		)?.id;
	if (!ownerId) return;
	await store.update({
		model: USER_MODEL,
		where: [
			{ field: "id", value: ownerId },
			{ field: "streampayConsumerId", value: consumerId },
		],
		update: { streampayConsumerId: null },
	});
}
