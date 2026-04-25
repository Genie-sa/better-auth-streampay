import type { InvoiceDetailed, PaymentResponse } from "@streamsdk/typescript";

/**
 * Re-exports of the string-literal enums the StreamPay SDK uses
 * internally. The SDK does not surface these as top-level names, so
 * we derive them from exported shapes where possible. This keeps them
 * tied to the SDK's `components["schemas"]` graph — when the upstream
 * enum widens or tightens, our types track automatically.
 *
 * `Language` is the one exception: `ConsumerCreate.preferred_language`
 * is typed as plain `string` on the exported `ConsumerCreate`, so we
 * mirror the internal `Language` schema by hand.
 */

export type StreamPayPaymentStatus = NonNullable<PaymentResponse["current_status"]>;
export type InvoiceStatus = NonNullable<InvoiceDetailed["status"]>;
export type PaymentMethod = NonNullable<PaymentResponse["payment_method"]>;
export type RefundReason = NonNullable<PaymentResponse["refund_reason"]>;
export type Language = "AR" | "EN";
