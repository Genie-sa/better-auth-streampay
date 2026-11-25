import { randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../error-codes";
import type { PluginAdapter, SyncContext } from "../plugins/subscriptions/adapter";
import { readEnvelope, readSdkErrorFields } from "../utils/error-envelope";
import { scopedLogger } from "../utils/logger";
import { isUniqueConstraintError } from "../utils/unique-constraint";
import { isStreamPayWebhookEnvelope, type StreamPayWebhookEnvelope } from "./events";

export const WEBHOOK_EVENT_MODEL = "streampayWebhookEvent";
export const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5;
export const WEBHOOK_PROCESSING_LEASE_MS = 2 * 60 * 1000;
const WEBHOOK_RETRY_DELAYS_MS = [5, 30, 120, 360, 720].map((minutes) => minutes * 60 * 1000);
const UNREPLAYABLE_PAYLOAD_CODE = "UNREPLAYABLE_PAYLOAD";
const SCOPE_DISABLED_CODE = "WEBHOOK_INBOX_SCOPE_DISABLED";
export const HANDLERS_EVENT_ID_PREFIX = "handlers";
export const ACTIVATION_EVENT_ID_PREFIX = "activation";
const SCOPED_EVENT_ID_PREFIXES: readonly string[] = [
	HANDLERS_EVENT_ID_PREFIX,
	ACTIVATION_EVENT_ID_PREFIX,
];

export type WebhookEventStatus = "pending" | "completed" | "dead_letter";

export interface WebhookEventRow {
	id: string;
	eventId: string;
	eventType: string;
	status: WebhookEventStatus;
	attemptCount: number;
	receivedAt: Date;
	lastAttemptAt: Date | null;
	nextAttemptAt: Date | null;
	completedAt: Date | null;
	deadLetteredAt: Date | null;
	lockedAt: Date | null;
	lockedBy: string | null;
	rawPayload: string | null;
	signatureHeader: string | null;
	lastError: string | null;
	lastErrorCode: string | null;
}

export type ClaimAdvanceResult =
	| { action: "process"; row: WebhookEventRow | null }
	| { action: "skip"; reason: "completed" | "dead_letter" | "in_progress" }
	| { action: "dead_letter"; row: WebhookEventRow };

type InboxStoreContext = { context: { adapter: PluginAdapter } };

/**
 * A concurrent delivery holds the processing lease. Surfaced as a retryable HTTP failure so the
 * provider redelivers instead of treating the event as handled while the lease holder may crash.
 */
export class WebhookEventInProgressError extends Error {
	constructor(eventType: string) {
		super(`Webhook ${eventType} is already being processed; retry later.`);
		this.name = "WebhookEventInProgressError";
	}
}

/** A processing failure that records a stable `lastErrorCode` on the inbox row. */
export class WebhookProcessingError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

/** What a scope learns about the attempt it is running. */
export interface WebhookInboxAttempt {
	eventId: string | null;
	previousError: string | null;
	previousErrorCode: string | null;
}

export type WebhookEventRunner = (ctx: SyncContext, attempt: WebhookInboxAttempt) => Promise<void>;

/**
 * One kind of work the inbox runs for a StreamPay event, identified by `eventIdPrefix`.
 */
export interface WebhookInboxScope {
	/** `null` keeps the unprefixed event IDs that subscription sync has always stored. */
	eventIdPrefix: string | null;
	/** Internal scopes can share a receipt across distinct deliveries of the same business event. */
	eventKey?: (payload: StreamPayWebhookEnvelope) => string;
	maxAttempts: number;
	/** Returns the work for an event this scope handles, or `null` to leave the event alone. */
	prepare: (payload: StreamPayWebhookEnvelope) => WebhookEventRunner | null;
	isPermanentFailure: (err: unknown) => boolean;
	/** Releases scope-owned state that waits on the event before an operator discards it. */
	onDiscard?: (ctx: SyncContext, row: WebhookEventRow) => Promise<void>;
}

export type WebhookDeliveryOutcome = "ignored" | "processed" | "duplicate" | "dead_letter";

export interface ProcessDueWebhookEventsResult {
	succeeded: string[];
	failed: Array<{ eventId: string; error: string }>;
}

export interface WebhookInbox {
	/**
	 * Adds a scope. A scope that is not `replayable` keeps its discard hook for rows it stored
	 * earlier, but its events are neither replayed nor retried.
	 *
	 * @throws TypeError if replay cannot route the prefix.
	 */
	register: (scope: WebhookInboxScope, options?: { replayable?: boolean }) => void;
	isEnabled: () => boolean;
	/** With `dueAttemptCount`, replays only while the event is still that pending, due attempt. */
	replay: (
		ctx: SyncContext,
		eventId: string,
		options?: { dueAttemptCount?: number },
	) => Promise<{ replayed: true; eventId: string }>;
	/** @throws APIError `CONFLICT` while a worker holds the event or claims it during the discard. */
	discard: (ctx: SyncContext, eventId: string) => Promise<{ discarded: true; eventId: string }>;
	processDue: (ctx: SyncContext, limit: number) => Promise<ProcessDueWebhookEventsResult>;
}

function legacyEventId(payload: StreamPayWebhookEnvelope): string | null {
	if (!payload.timestamp || !payload.entity_id) return null;
	return `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
}

export function webhookEventId(payload: StreamPayWebhookEnvelope): string | null {
	return payload.webhook_delivery_id
		? `delivery:${payload.webhook_delivery_id}`
		: legacyEventId(payload);
}

function scopedEventId(eventId: string | null, prefix: string | null): string | null {
	return eventId && (prefix ? `${prefix}:${eventId}` : eventId);
}

/** CAS clauses that match only while no worker has claimed, advanced, or finished the row. */
function unchangedSince(row: WebhookEventRow): Array<{ field: string; value: unknown }> {
	return [
		{ field: "id", value: row.id },
		{ field: "status", value: row.status },
		{ field: "lockedAt", value: row.lockedAt ?? null },
		{ field: "attemptCount", value: row.attemptCount ?? null },
	];
}

function hasLiveLease(row: Pick<WebhookEventRow, "lockedAt">, now: Date): boolean {
	return (
		row.lockedAt instanceof Date &&
		now.getTime() - row.lockedAt.getTime() < WEBHOOK_PROCESSING_LEASE_MS
	);
}

function webhookFailureCode(err: unknown): string {
	const sdkError = readSdkErrorFields(err);
	return (
		readEnvelope(sdkError.body)?.code ??
		(sdkError.status !== undefined
			? `HTTP_${sdkError.status}`
			: err instanceof WebhookProcessingError
				? err.code
				: err instanceof Error
					? err.name
					: "UNKNOWN")
	);
}

/** Pending events whose retry time has passed, plus events whose processing lease was abandoned. */
export async function findDueWebhookEvents(
	ctx: InboxStoreContext,
	now: Date,
	limit: number,
): Promise<WebhookEventRow[]> {
	const [retryDue, abandoned] = await Promise.all([
		ctx.context.adapter.findMany<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			where: [
				{ field: "status", value: "pending" },
				{ field: "nextAttemptAt", operator: "lte", value: now },
			],
			limit,
			sortBy: { field: "nextAttemptAt", direction: "asc" },
		}),
		ctx.context.adapter.findMany<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			where: [
				{ field: "status", value: "pending" },
				{
					field: "lockedAt",
					operator: "lt",
					value: new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS),
				},
			],
			limit,
			sortBy: { field: "lockedAt", direction: "asc" },
		}),
	]);
	const byId = new Map([...retryDue, ...abandoned].map((row) => [row.id, row]));
	return [...byId.values()].slice(0, limit);
}

export async function claimOrAdvanceWebhookEvent(
	ctx: SyncContext,
	payload: StreamPayWebhookEnvelope,
	rawBody: string | null,
	signatureHeader: string | null,
	maxAttempts: number,
	scope?: string,
	eventKey?: string,
): Promise<ClaimAdvanceResult> {
	const log = scopedLogger(ctx.context.logger);
	const prefix = scope ?? null;
	const legacyId = scopedEventId(legacyEventId(payload), prefix);
	const legacyRow =
		eventKey === undefined && payload.webhook_delivery_id && legacyId
			? await ctx.context.adapter.findOne<WebhookEventRow>({
					model: WEBHOOK_EVENT_MODEL,
					where: [{ field: "eventId", value: legacyId }],
				})
			: null;
	const eventId = legacyRow?.eventId ?? scopedEventId(eventKey ?? webhookEventId(payload), prefix);
	if (!eventId) {
		log.warn(
			`webhook ${payload.event_type}: missing entity_id/timestamp — processing without dedupe.`,
		);
		return { action: "process", row: null };
	}

	const now = new Date();
	const lockId = randomUUID();

	if (!legacyRow) {
		try {
			const inserted = await ctx.context.adapter.create<WebhookEventRow>({
				model: WEBHOOK_EVENT_MODEL,
				data: {
					eventId,
					eventType: payload.event_type,
					status: "pending",
					attemptCount: 1,
					receivedAt: now,
					lastAttemptAt: now,
					lockedAt: now,
					lockedBy: lockId,
					rawPayload: rawBody,
					signatureHeader,
				},
			});
			return { action: "process", row: inserted };
		} catch (err) {
			if (!isUniqueConstraintError(err)) throw err;
		}
	}

	const existing =
		legacyRow ??
		(await ctx.context.adapter.findOne<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			where: [{ field: "eventId", value: eventId }],
		}));
	if (!existing) {
		throw new Error(
			`Webhook inbox row missing after unique conflict for ${eventId}; retry delivery.`,
		);
	}

	if (existing.status === "completed") {
		log.info(`webhook ${payload.event_type} (${eventId}) already completed — skipping.`);
		return { action: "skip", reason: "completed" };
	}
	if (existing.status === "dead_letter") {
		log.warn(
			`webhook ${payload.event_type} (${eventId}) already dead-lettered — skipping (replay manually).`,
		);
		return { action: "skip", reason: "dead_letter" };
	}
	if (hasLiveLease(existing, now)) {
		log.info(
			`webhook ${payload.event_type} (${eventId}) is already being processed — skipping concurrent delivery.`,
		);
		return { action: "skip", reason: "in_progress" };
	}

	const nextAttempt = (existing.attemptCount ?? 0) + 1;
	const leaseGuard = unchangedSince(existing);
	if (nextAttempt > maxAttempts) {
		const updated = await ctx.context.adapter.update<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			update: {
				status: "dead_letter",
				attemptCount: nextAttempt,
				lastAttemptAt: now,
				deadLetteredAt: now,
				nextAttemptAt: null,
				...(rawBody !== null ? { rawPayload: rawBody, signatureHeader } : {}),
				lockedAt: null,
				lockedBy: null,
			},
			where: leaseGuard,
		});
		return updated
			? { action: "dead_letter", row: updated }
			: { action: "skip", reason: "in_progress" };
	}

	const updated = await ctx.context.adapter.update<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			attemptCount: nextAttempt,
			lastAttemptAt: now,
			nextAttemptAt: null,
			lockedAt: now,
			lockedBy: lockId,
			...(rawBody !== null ? { rawPayload: rawBody, signatureHeader } : {}),
		},
		where: leaseGuard,
	});
	return updated ? { action: "process", row: updated } : { action: "skip", reason: "in_progress" };
}

export async function claimWebhookEventForReplay(
	ctx: InboxStoreContext,
	row: WebhookEventRow,
): Promise<WebhookEventRow | null> {
	const now = new Date();
	if (hasLiveLease(row, now)) return null;
	return ctx.context.adapter.update<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			status: "pending",
			attemptCount: (row.attemptCount ?? 0) + 1,
			lastAttemptAt: now,
			nextAttemptAt: null,
			completedAt: null,
			deadLetteredAt: null,
			lockedAt: now,
			lockedBy: randomUUID(),
		},
		where: unchangedSince(row),
	});
}

/** The due queue may retry a row only while it is still the pending attempt it selected and is due. */
function isStillDue(row: WebhookEventRow, selectedAttemptCount: number, now: Date): boolean {
	const retryDue = row.nextAttemptAt instanceof Date && row.nextAttemptAt <= now;
	const leaseAbandoned = row.lockedAt instanceof Date && !hasLiveLease(row, now);
	return (
		row.status === "pending" &&
		row.attemptCount === selectedAttemptCount &&
		(retryDue || leaseAbandoned)
	);
}

/**
 * Takes a pending event that cannot be replayed out of the due queue so it stops filling every
 * batch. It stays pending: a StreamPay redelivery carries the body and can still complete it. The
 * CAS includes the attempt that was inspected, so a redelivery that ran meanwhile keeps its retry.
 */
export async function parkUnreplayableWebhookEvent(
	ctx: InboxStoreContext,
	row: WebhookEventRow,
	reason: string,
	code: string = UNREPLAYABLE_PAYLOAD_CODE,
): Promise<void> {
	if (row.status !== "pending" || hasLiveLease(row, new Date())) return;
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			nextAttemptAt: null,
			lockedAt: null,
			lockedBy: null,
			lastError: reason,
			lastErrorCode: code,
		},
		where: unchangedSince(row),
	});
}

const COMPLETED_ROW_FIELDS = {
	status: "completed",
	nextAttemptAt: null,
	lockedAt: null,
	lockedBy: null,
	rawPayload: null,
	signatureHeader: null,
	lastError: null,
	lastErrorCode: null,
} as const;

/** Completes the event only while `lockId` still holds its lease (W2). */
export async function markWebhookEventCompleted(
	ctx: InboxStoreContext,
	rowId: string,
	lockId: string,
): Promise<void> {
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: { ...COMPLETED_ROW_FIELDS, completedAt: new Date() },
		where: [
			{ field: "id", value: rowId },
			{ field: "lockedBy", value: lockId },
		],
	});
}

export async function recordWebhookEventFailure(
	ctx: InboxStoreContext,
	failure: {
		rowId: string;
		lockId: string;
		err: unknown;
		deadLetter: boolean;
		rawBody?: string | null;
		signatureHeader?: string | null;
	},
): Promise<void> {
	const { rowId, lockId, err, deadLetter } = failure;
	const leaseHolder = [
		{ field: "id", value: rowId },
		{ field: "lockedBy", value: lockId },
	];
	const row = await ctx.context.adapter.findOne<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		where: leaseHolder,
	});
	const attemptCount = row?.attemptCount ?? 1;
	const retryDelay =
		WEBHOOK_RETRY_DELAYS_MS[Math.min(attemptCount - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
	const now = new Date();
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			...(deadLetter ? { status: "dead_letter", deadLetteredAt: now } : {}),
			lastAttemptAt: now,
			nextAttemptAt:
				deadLetter || retryDelay === undefined ? null : new Date(now.getTime() + retryDelay),
			lockedAt: null,
			lockedBy: null,
			lastError: err instanceof Error ? err.message : String(err),
			lastErrorCode: webhookFailureCode(err),
			...(failure.rawBody != null ? { rawPayload: failure.rawBody } : {}),
			...(failure.signatureHeader != null ? { signatureHeader: failure.signatureHeader } : {}),
		},
		where: leaseHolder,
	});
}

async function runClaimedEvent(
	ctx: SyncContext,
	scope: WebhookInboxScope,
	run: WebhookEventRunner,
	claimed: WebhookEventRow,
	failure: {
		previousStatus: WebhookEventStatus;
		rawBody: string | null;
		signatureHeader: string | null;
	},
): Promise<void> {
	const lockId = claimed.lockedBy;
	if (!lockId) throw new Error(`Webhook inbox row ${claimed.eventId} was claimed without a lease.`);
	try {
		await run(ctx, {
			eventId: claimed.eventId,
			previousError: claimed.lastError ?? null,
			previousErrorCode: claimed.lastErrorCode ?? null,
		});
		await markWebhookEventCompleted(ctx, claimed.id, lockId);
	} catch (err) {
		await recordWebhookEventFailure(ctx, {
			rowId: claimed.id,
			lockId,
			err,
			deadLetter:
				failure.previousStatus === "dead_letter" ||
				scope.isPermanentFailure(err) ||
				claimed.attemptCount >= scope.maxAttempts,
			rawBody: failure.rawBody,
			signatureHeader: failure.signatureHeader,
		});
		throw err;
	}
}

/**
 * Runs one delivery through the inbox: claims the event's row, runs the scope's work under the
 * lease, then completes the row or records the failure for retry or dead-lettering.
 *
 * @throws WebhookEventInProgressError while another delivery holds the lease.
 * @throws the scope's own error after the failure is recorded.
 */
export async function deliverWebhookEvent(
	ctx: SyncContext,
	scope: WebhookInboxScope,
	payload: StreamPayWebhookEnvelope,
	request: { rawBody: string | null; signatureHeader: string | null },
): Promise<WebhookDeliveryOutcome> {
	const run = scope.prepare(payload);
	if (!run) return "ignored";
	const claim = await claimOrAdvanceWebhookEvent(
		ctx,
		payload,
		request.rawBody,
		request.signatureHeader,
		scope.maxAttempts,
		scope.eventIdPrefix ?? undefined,
		scope.eventKey?.(payload),
	);
	if (claim.action === "skip" && claim.reason === "in_progress") {
		throw new WebhookEventInProgressError(payload.event_type);
	}
	if (claim.action === "skip") return "duplicate";
	if (claim.action === "dead_letter") {
		scopedLogger(ctx.context.logger).warn(
			`webhook ${payload.event_type} (${claim.row.eventId}) dead-lettered after ${claim.row.attemptCount} attempts. Replay manually.`,
		);
		return "dead_letter";
	}
	if (claim.row) {
		await runClaimedEvent(ctx, scope, run, claim.row, {
			previousStatus: "pending",
			rawBody: request.rawBody,
			signatureHeader: request.signatureHeader,
		});
	} else {
		await run(ctx, { eventId: null, previousError: null, previousErrorCode: null });
	}
	return "processed";
}

function replayInProgress(eventId: string, state: string): APIError {
	return new APIError("CONFLICT", {
		code: $ERROR_CODES.WEBHOOK_REPLAY_IN_PROGRESS.code,
		message: `Webhook event ${eventId} ${state}.`,
	});
}

type ReplayTarget =
	| { scope: WebhookInboxScope; run: WebhookEventRunner }
	| { unreplayable: string; code: string };

export function createWebhookInbox(): WebhookInbox {
	const scopes = new Map<string | null, { scope: WebhookInboxScope; replayable: boolean }>();

	/** A prefixed ID never falls through to the unprefixed scope, even when its own scope is off. */
	function scopeFor(eventId: string) {
		const prefix = SCOPED_EVENT_ID_PREFIXES.find((candidate) =>
			eventId.startsWith(`${candidate}:`),
		);
		return scopes.get(prefix ?? null);
	}

	function replayTarget(row: WebhookEventRow): ReplayTarget {
		const entry = scopeFor(row.eventId);
		if (!entry?.replayable) {
			return {
				unreplayable: `no enabled webhook inbox handles event ${row.eventId}`,
				code: SCOPE_DISABLED_CODE,
			};
		}
		const unreplayable = (reason: string) => ({
			unreplayable: `webhook event ${row.eventId} ${reason}`,
			code: UNREPLAYABLE_PAYLOAD_CODE,
		});
		if (!row.rawPayload) return unreplayable("has no stored payload");
		let payload: unknown;
		try {
			payload = JSON.parse(row.rawPayload);
		} catch {
			return unreplayable("has malformed stored JSON");
		}
		const run = isStreamPayWebhookEnvelope(payload) ? entry.scope.prepare(payload) : null;
		if (!run) return unreplayable("has an invalid stored payload");
		return { scope: entry.scope, run };
	}

	async function findRow(ctx: InboxStoreContext, eventId: string): Promise<WebhookEventRow> {
		const row = await ctx.context.adapter.findOne<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			where: [{ field: "eventId", value: eventId }],
		});
		if (!row) {
			throw new APIError("NOT_FOUND", {
				code: $ERROR_CODES.NOT_FOUND.code,
				message: `Webhook event ${eventId} not found.`,
			});
		}
		return row;
	}

	async function replayRow(
		ctx: SyncContext,
		row: WebhookEventRow,
		target: Extract<ReplayTarget, { scope: WebhookInboxScope }>,
	): Promise<void> {
		// The claim rewrites the status to pending, and adapters may hand back the same row object.
		const previousStatus = row.status;
		const claimed = await claimWebhookEventForReplay(ctx, row);
		if (!claimed?.lockedBy) throw replayInProgress(row.eventId, "is already being replayed");
		await runClaimedEvent(ctx, target.scope, target.run, claimed, {
			previousStatus,
			rawBody: null,
			signatureHeader: null,
		});
	}

	return {
		register(scope, options = {}) {
			const prefix = scope.eventIdPrefix;
			if (prefix !== null && !SCOPED_EVENT_ID_PREFIXES.includes(prefix)) {
				throw new TypeError(`Webhook inbox cannot route event IDs with prefix "${prefix}".`);
			}
			scopes.set(prefix, { scope, replayable: options.replayable !== false });
		},
		isEnabled: () => [...scopes.values()].some((entry) => entry.replayable),
		async replay(ctx, eventId, options = {}) {
			const row = await findRow(ctx, eventId);
			if (
				options.dueAttemptCount !== undefined &&
				!isStillDue(row, options.dueAttemptCount, new Date())
			) {
				throw replayInProgress(eventId, "is no longer due");
			}
			const target = replayTarget(row);
			if ("unreplayable" in target) {
				await parkUnreplayableWebhookEvent(ctx, row, target.unreplayable, target.code);
				throw new APIError("BAD_REQUEST", { message: `Cannot replay: ${target.unreplayable}.` });
			}
			await replayRow(ctx, row, target);
			return { replayed: true, eventId };
		},
		async discard(ctx, eventId) {
			const row = await findRow(ctx, eventId);
			const inProgress = () =>
				replayInProgress(eventId, "is being processed; retry after its lease expires");
			if (row.status === "pending" && hasLiveLease(row, new Date())) throw inProgress();
			// Complete first: once no worker can claim the event, scope state waiting on it is safe to release.
			const completed = await ctx.context.adapter.update({
				model: WEBHOOK_EVENT_MODEL,
				update: { ...COMPLETED_ROW_FIELDS, completedAt: new Date() },
				where: unchangedSince(row),
			});
			if (!completed) throw inProgress();
			await scopeFor(eventId)?.scope.onDiscard?.(ctx, row);
			return { discarded: true, eventId };
		},
		async processDue(ctx, limit) {
			const due = await findDueWebhookEvents(ctx, new Date(), limit);
			const result: ProcessDueWebhookEventsResult = { succeeded: [], failed: [] };
			for (const selected of due) {
				// Re-read: a redelivery, a parking, or an overlapping run may have changed the row since selection.
				const row = await ctx.context.adapter.findOne<WebhookEventRow>({
					model: WEBHOOK_EVENT_MODEL,
					where: [{ field: "id", value: selected.id }],
				});
				if (!row || !isStillDue(row, selected.attemptCount, new Date())) continue;
				const target = replayTarget(row);
				try {
					if ("unreplayable" in target) {
						await parkUnreplayableWebhookEvent(ctx, row, target.unreplayable, target.code);
						result.failed.push({ eventId: row.eventId, error: target.unreplayable });
						continue;
					}
					await replayRow(ctx, row, target);
					result.succeeded.push(row.eventId);
				} catch (err: unknown) {
					if (err instanceof APIError && err.status === "CONFLICT") continue;
					result.failed.push({
						eventId: row.eventId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return result;
		},
	};
}
