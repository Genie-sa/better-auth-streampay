import { createHash, randomUUID } from "node:crypto";
import type { PaymentRefundRequest, PaymentResponse } from "@streamsdk/typescript";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { $ERROR_CODES } from "../error-codes";
import type { StreamPayClient } from "../types";
import { amountToSmallestUnit } from "../utils/amount";
import { parseStreamPayError } from "../utils/parse-error";
import { isUniqueConstraintError } from "../utils/unique-constraint";
import type { PluginAdapter } from "./subscriptions/adapter";

const MODEL = "streampayRefundIntent";
const REQUEST_WINDOW_MS = 60_000;

export const refundIntentKey = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._-]+$/);

export const refundIntentTable = {
	[MODEL]: {
		fields: {
			requestKey: { type: "string", required: true, unique: true, input: false },
			fingerprint: { type: "string", required: true, input: false },
			paymentId: { type: "string", required: true, index: true, input: false },
			activePaymentId: { type: "string", required: false, unique: true, input: false },
			full: { type: "boolean", required: true, input: false },
			status: { type: "string", required: true, input: false },
			providerStatus: { type: "string", required: false, input: false },
			currency: { type: "string", required: false, input: false },
			amountRefunded: { type: "string", required: false, input: false },
			providerRefundId: { type: "string", required: false, input: false },
			refundEvidence: { type: "string", required: false, input: false },
			createdAt: { type: "date", required: true, input: false },
		},
	},
} as const;

type RefundProviderRequest = PaymentRefundRequest & {
	amount?: string | number | null | undefined;
	payment_is_part_of_related_set?: boolean | undefined;
};

type RefundStatus = "sending" | "pending" | "confirmed" | "needs_review" | "rejected";

interface RefundIntent {
	id: string;
	fingerprint: string;
	paymentId: string;
	full: boolean;
	status: RefundStatus;
	providerStatus: string | null;
	currency: string | null;
	amountRefunded: string | null;
	providerRefundId?: string | null;
	refundEvidence?: string | null;
	createdAt: Date;
}

const decimal = z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()]);
const paymentState = z.object({
	id: z.string(),
	current_status: z.string(),
	currency: z.string(),
	amount_in_smallest_unit: z.number().int().positive().optional(),
	amount_refunded: decimal.nullish(),
	refunds: z
		.array(
			z.object({
				id: z.string().min(1).optional(),
				status: z.string(),
				amount_refunded: decimal.optional(),
				refund_reason: z.string().nullish(),
				refund_note: z.string().nullish(),
			}),
		)
		.nullish(),
});

const refundEvidence = z.object({
	currency: z.string(),
	amount: z.number().int().positive(),
	previousIds: z.array(z.string()),
	requestHash: z.string(),
	generatedNote: z.boolean(),
});

type PaymentState = z.infer<typeof paymentState>;
type RefundEvidence = z.infer<typeof refundEvidence>;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function conflict(
	code:
		| "PAYMENT_REFUND_IN_PROGRESS"
		| "PAYMENT_REFUND_REVIEW_REQUIRED"
		| "PAYMENT_REFUND_KEY_CONFLICT",
) {
	return new APIError("CONFLICT", $ERROR_CODES[code]);
}

function findIntent(adapter: PluginAdapter, paymentId: string, key: string) {
	return adapter.findOne<RefundIntent>({
		model: MODEL,
		where: [{ field: "requestKey", value: digest([paymentId, key]) }],
	});
}

async function writeOutcome(
	adapter: PluginAdapter,
	row: RefundIntent,
	status: RefundStatus,
	state?: PaymentState,
	options: { refundId?: string; writeResponse?: boolean } = {},
) {
	return adapter.update<RefundIntent>({
		model: MODEL,
		where: [
			{ field: "id", value: row.id },
			{ field: "activePaymentId", value: row.paymentId },
			...(options.writeResponse ? [] : [{ field: "status", value: row.status }]),
		],
		update: {
			status,
			...(options.refundId ? { providerRefundId: options.refundId } : {}),
			...(status === "confirmed" || status === "rejected" ? { activePaymentId: null } : {}),
			...(state
				? {
						providerStatus: state.current_status,
						currency: state.currency,
						amountRefunded: state.amount_refunded == null ? null : String(state.amount_refunded),
					}
				: {}),
		},
	});
}

function readState(payment: unknown, paymentId: string) {
	const parsed = paymentState.safeParse(payment);
	return parsed.success && parsed.data.id === paymentId ? parsed.data : undefined;
}

function outcome(
	state: PaymentState | undefined,
	full: boolean,
	partialConfirmed = false,
): RefundStatus {
	if (state?.refunds?.some((refund) => refund.status === "PENDING")) return "pending";
	if (full && state?.current_status === "REFUNDED") return "confirmed";
	if (partialConfirmed) {
		return "confirmed";
	}
	return "needs_review";
}

function readEvidence(row: RefundIntent) {
	if (!row.refundEvidence) return undefined;
	try {
		const decoded = refundEvidence.safeParse(JSON.parse(row.refundEvidence));
		return decoded.success ? decoded.data : undefined;
	} catch {
		return undefined;
	}
}

function prepareEvidence(
	payment: PaymentState,
	request: RefundProviderRequest,
	amount: number | null,
) {
	if (amount === null || amount <= 0 || !payment.refunds) return undefined;
	const previousIds = payment.refunds.flatMap((refund) => (refund.id ? [refund.id] : []));
	if (new Set(previousIds).size !== payment.refunds.length) return undefined;

	const generatedNote = request.refund_note == null;
	const note = request.refund_note ?? `better-auth-streampay:${randomUUID()}`;
	const evidence: RefundEvidence = {
		currency: payment.currency,
		amount,
		previousIds,
		requestHash: digest([request.refund_reason, note]),
		generatedNote,
	};
	return { evidence, note };
}

function observeRefund(
	state: PaymentState | undefined,
	row: RefundIntent,
	evidence: RefundEvidence,
	writeResponse = false,
): { status: RefundStatus; refundId?: string } {
	if (state?.currency !== evidence.currency || !state.refunds) return { status: "needs_review" };
	const candidates = state.refunds.filter((refund) => {
		if (!refund.id || evidence.previousIds.includes(refund.id)) return false;
		if (row.providerRefundId && refund.id !== row.providerRefundId) return false;
		if (amountToSmallestUnit(String(refund.amount_refunded), state.currency) !== evidence.amount) {
			return false;
		}
		if (row.providerRefundId) return true;
		return (
			(writeResponse || evidence.generatedNote) &&
			digest([refund.refund_reason, refund.refund_note]) === evidence.requestHash
		);
	});
	const [refund] = candidates;
	if (
		candidates.length !== 1 ||
		!refund?.id ||
		state.refunds.filter((entry) => entry.id === refund.id).length !== 1
	) {
		return {
			status: state.refunds.some((entry) => entry.status === "PENDING")
				? "pending"
				: "needs_review",
		};
	}
	switch (refund.status) {
		case "REFUNDED":
			return { status: "confirmed", refundId: refund.id };
		case "CANCELED":
			return { status: "rejected", refundId: refund.id };
		case "PENDING":
			return { status: "pending", refundId: refund.id };
		default:
			return { status: "needs_review" };
	}
}

async function refreshIntent(adapter: PluginAdapter, client: StreamPayClient, row: RefundIntent) {
	if (row.status === "confirmed" || row.status === "rejected") return { row };
	if (
		row.status === "sending" &&
		Date.now() - new Date(row.createdAt).getTime() < REQUEST_WINDOW_MS
	) {
		return { row };
	}
	let payment: PaymentResponse;
	try {
		payment = await client.getPayment(row.paymentId);
	} catch {
		// Keep the payment claim when the provider cannot report a decisive outcome.
		return { row };
	}
	const state = readState(payment, row.paymentId);
	const evidence = readEvidence(row);
	const observed = evidence
		? observeRefund(state, row, evidence)
		: { status: row.refundEvidence ? ("needs_review" as const) : outcome(state, row.full) };
	const updated = await writeOutcome(adapter, row, observed.status, state, observed);
	return { row: updated ?? row, payment };
}

export async function getRefundIntent(
	adapter: PluginAdapter,
	client: StreamPayClient,
	paymentId: string,
	key: string,
) {
	const stored = await findIntent(adapter, paymentId, key);
	if (!stored) throw new APIError("NOT_FOUND", $ERROR_CODES.NOT_FOUND);
	const { row } = await refreshIntent(adapter, client, stored);
	return {
		paymentId: row.paymentId,
		status: row.status === "sending" ? ("pending" as const) : row.status,
		providerStatus: row.providerStatus,
		currency: row.currency,
		amountRefunded: row.amountRefunded,
		providerRefundId: row.providerRefundId ?? null,
	};
}

export async function runRefundIntent(
	adapter: PluginAdapter,
	client: StreamPayClient,
	paymentId: string,
	key: string,
	request: RefundProviderRequest,
	authorize: () => Promise<void>,
): Promise<PaymentResponse> {
	if (request.allow_refund_multiple_related_payments || request.payment_is_part_of_related_set) {
		throw new APIError("BAD_REQUEST", {
			message: "Durable refund requests apply to a single payment.",
		});
	}
	const requestKey = digest([paymentId, key]);
	const fingerprint = digest(request);
	const full = request.amount == null;
	let row: RefundIntent;
	try {
		row = await adapter.create<RefundIntent>({
			model: MODEL,
			data: {
				requestKey,
				fingerprint,
				paymentId,
				full,
				activePaymentId: paymentId,
				status: "sending",
				createdAt: new Date(),
			},
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		const stored = await findIntent(adapter, paymentId, key);
		if (!stored) throw conflict("PAYMENT_REFUND_IN_PROGRESS");
		if (stored.fingerprint !== fingerprint) throw conflict("PAYMENT_REFUND_KEY_CONFLICT");
		const refreshed = await refreshIntent(adapter, client, stored);
		if (refreshed.row.status === "confirmed")
			return refreshed.payment ?? client.getPayment(paymentId);
		if (refreshed.row.status === "sending" || refreshed.row.status === "pending") {
			throw conflict("PAYMENT_REFUND_IN_PROGRESS");
		}
		throw conflict("PAYMENT_REFUND_REVIEW_REQUIRED");
	}

	let before: PaymentResponse;
	try {
		await authorize();
		before = await client.getPayment(paymentId);
	} catch (err) {
		await writeOutcome(adapter, row, "rejected");
		throw err;
	}

	const current = readState(before, paymentId);
	if (!current) {
		await writeOutcome(adapter, row, "rejected");
		throw conflict("PAYMENT_REFUND_REVIEW_REQUIRED");
	}
	const requested =
		request.amount == null ? null : amountToSmallestUnit(String(request.amount), current.currency);
	const beforeAmount = amountToSmallestUnit(String(current.amount_refunded ?? 0), current.currency);
	if (
		!full &&
		(requested === null ||
			requested <= 0 ||
			(current.amount_in_smallest_unit !== undefined &&
				beforeAmount !== null &&
				requested > current.amount_in_smallest_unit - beforeAmount))
	) {
		await writeOutcome(adapter, row, "rejected", current);
		throw new APIError("BAD_REQUEST", $ERROR_CODES.VALIDATION_ERROR);
	}
	const pending = current.refunds?.some((refund) => refund.status === "PENDING");
	if (pending) {
		await writeOutcome(adapter, row, "rejected", current);
		throw conflict("PAYMENT_REFUND_IN_PROGRESS");
	}
	if (full && current.current_status === "REFUNDED") {
		await writeOutcome(adapter, row, "confirmed", current);
		return before;
	}
	const expected =
		full && current.amount_in_smallest_unit !== undefined && beforeAmount !== null
			? current.amount_in_smallest_unit - beforeAmount
			: requested;
	const prepared = prepareEvidence(current, request, expected);
	if (prepared) {
		const staged = await adapter.update<RefundIntent>({
			model: MODEL,
			where: [
				{ field: "id", value: row.id },
				{ field: "status", value: "sending" },
			],
			update: { refundEvidence: JSON.stringify(prepared.evidence) },
		});
		if (!staged) throw conflict("PAYMENT_REFUND_REVIEW_REQUIRED");
		row = staged;
	}
	let payment: PaymentResponse;
	try {
		payment = await client.refundPayment(
			paymentId,
			prepared ? { ...request, refund_note: prepared.note } : request,
		);
	} catch (err) {
		const { code, status } = parseStreamPayError(err);
		if (
			status !== undefined &&
			status >= 400 &&
			status < 500 &&
			status !== 408 &&
			status !== 429 &&
			code !== "PAYMENT_REFUND_BUSY" &&
			code !== "PAYMENT_REFUNDED_ALREADY"
		) {
			await writeOutcome(adapter, row, "rejected");
			throw err;
		}
		await writeOutcome(adapter, row, "needs_review");
		const stored = await findIntent(adapter, paymentId, key);
		const observed = stored && (await refreshIntent(adapter, client, stored));
		if (observed?.row.status === "confirmed" && observed.payment) return observed.payment;
		if (observed?.row.status === "pending" || code === "PAYMENT_REFUND_BUSY") {
			throw conflict("PAYMENT_REFUND_IN_PROGRESS");
		}
		throw conflict("PAYMENT_REFUND_REVIEW_REQUIRED");
	}

	const state = readState(payment, paymentId);
	const afterAmount =
		state?.amount_refunded == null
			? null
			: amountToSmallestUnit(String(state.amount_refunded), current.currency);
	const partialConfirmed =
		requested !== null &&
		requested > 0 &&
		beforeAmount !== null &&
		afterAmount !== null &&
		state?.currency === current.currency &&
		(state.current_status === "PARTIALLY_REFUNDED" || state.current_status === "REFUNDED") &&
		afterAmount - beforeAmount === requested;
	const observed = prepared
		? observeRefund(state, row, prepared.evidence, true)
		: { status: outcome(state, full, partialConfirmed) };
	const { status } = observed;
	await writeOutcome(adapter, row, status, state, { ...observed, writeResponse: true });
	if (status === "confirmed") return payment;
	throw conflict(
		status === "pending" ? "PAYMENT_REFUND_IN_PROGRESS" : "PAYMENT_REFUND_REVIEW_REQUIRED",
	);
}
