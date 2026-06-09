import type { InvoiceDetailed, PaymentResponse } from "@streamsdk/typescript";

export type StreamPayPaymentStatus = NonNullable<PaymentResponse["current_status"]>;
export type InvoiceStatus = NonNullable<InvoiceDetailed["status"]>;
export type PaymentMethod = NonNullable<PaymentResponse["payment_method"]>;
export type RefundReason = NonNullable<PaymentResponse["refund_reason"]>;
export type Language = "AR" | "EN";
