import { createHash } from "node:crypto";
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
	createdAt: Date;
}

const paymentState = z.object({
	id: z.string(),
	current_status: z.string(),
	currency: z.string(),
	amount_in_smallest_unit: z.number().int().positive().optional(),
	amount_refunded: z
		.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()])
		.nullish(),
	refunds: z.array(z.object({ status: z.string() })).nullish(),
});

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
	state?: z.infer<typeof paymentState>,
	authoritative = false,
) {
	return adapter.update<RefundIntent>({
		model: MODEL,
		where: [
			{ field: "id", value: row.id },
			...(authoritative ? [] : [{ field: "status", value: row.status }]),
		],
		update: {
			status,
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
	state: z.infer<typeof paymentState> | undefined,
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
	const status = outcome(state, row.full);
	const updated = await writeOutcome(adapter, row, status, state);
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
		await writeOutcome(adapter, row, "pending", current);
		throw conflict("PAYMENT_REFUND_IN_PROGRESS");
	}
	if (full && current.current_status === "REFUNDED") {
		await writeOutcome(adapter, row, "confirmed", current, true);
		return before;
	}
	let payment: PaymentResponse;
	try {
		payment = await client.refundPayment(paymentId, request);
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
	const status = outcome(state, full, partialConfirmed);
	await writeOutcome(adapter, row, status, state, status === "confirmed");
	if (status === "confirmed") return payment;
	throw conflict(
		status === "pending" ? "PAYMENT_REFUND_IN_PROGRESS" : "PAYMENT_REFUND_REVIEW_REQUIRED",
	);
}
