import { StreamSDKError } from "@streamsdk/typescript";

export async function listSubscriptionFreezes(subscriptionId, { page, limit }) {
	const url = new URL(
		`/api/v2/subscriptions/${encodeURIComponent(subscriptionId)}/freeze`,
		process.env.STREAMPAY_BASE_URL,
	);
	url.search = new URLSearchParams({
		page: String(page),
		limit: String(limit),
		sort_field: "created_at",
		sort_direction: "asc",
	});
	const response = await fetch(url, {
		headers: { "x-api-key": process.env.STREAMPAY_API_KEY },
		signal: AbortSignal.timeout(15000),
	});
	const body = await response.json();
	if (!response.ok)
		throw new StreamSDKError(`Freeze history API failed: HTTP ${response.status}`, {
			status: response.status,
			body,
		});
	return body;
}
