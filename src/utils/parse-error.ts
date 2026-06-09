import { readEnvelope, readSdkErrorFields, readValidationDetails } from "./error-envelope";

export interface StreamPayValidationIssue {
	loc: (string | number)[];
	message: string;
	type: string;
}

export interface ParsedStreamPayError {
	status: number | undefined;
	code: string | undefined;
	requestId: string | undefined;
	message: string;
	additionalInfo: string | undefined;
	validationErrors: StreamPayValidationIssue[];
}

export function parseStreamPayError(err: unknown): ParsedStreamPayError {
	const { status, requestId, body, message: fallbackMessage } = readSdkErrorFields(err);
	const envelope = readEnvelope(body);

	if (envelope && (envelope.code !== undefined || envelope.message !== undefined)) {
		return {
			status,
			code: envelope.code,
			requestId,
			message: envelope.message ?? fallbackMessage,
			additionalInfo: envelope.additionalInfo,
			validationErrors: [],
		};
	}

	const validationErrors = readValidationDetails(body).map((entry) => ({
		loc: entry.loc,
		message: entry.msg,
		type: entry.type,
	}));

	return {
		status,
		code: undefined,
		requestId,
		message: fallbackMessage,
		additionalInfo: undefined,
		validationErrors,
	};
}
