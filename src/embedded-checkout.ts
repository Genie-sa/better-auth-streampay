const SDK_URL = "https://stream-embed.streampay.sa/sdk/embed.min.js";
const SDK_TIMEOUT_MS = 15_000;

export interface EmbeddedCheckoutOptions {
	paymentLink: string;
	container: Element;
	/** Cancels a pending mount while the SDK loads. */
	signal?: AbortSignal;
	minHeightPx?: number;
	maxHeightPx?: number;
	vhCapPx?: number;
	vhFraction?: number;
}

type StreamCheckout = (options: Omit<EmbeddedCheckoutOptions, "signal">) => { destroy(): void };

let loading: Promise<StreamCheckout> | undefined;
const mountedContainers = new WeakMap<Element, Element>();

function getCheckout() {
	const stream = (window as Window & { Stream?: { Checkout?: StreamCheckout } }).Stream;
	return typeof stream?.Checkout === "function" ? stream.Checkout.bind(stream) : undefined;
}

function loadCheckout(): Promise<StreamCheckout> {
	const available = getCheckout();
	if (available) return Promise.resolve(available);
	loading ??= new Promise<StreamCheckout>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SDK_URL;
		script.async = true;
		const timeout = window.setTimeout(() => {
			finish(undefined);
		}, SDK_TIMEOUT_MS);
		function finish(checkout: StreamCheckout | undefined) {
			window.clearTimeout(timeout);
			script.onload = null;
			script.onerror = null;
			if (checkout) resolve(checkout);
			else {
				script.remove();
				reject(new Error("Could not load the StreamPay checkout SDK."));
			}
		}
		script.onload = () => finish(getCheckout());
		script.onerror = () => finish(undefined);
		document.head.append(script);
	}).finally(() => {
		loading = undefined;
	});
	return loading;
}

/**
 * Mount an official StreamPay payment link returned by your server.
 * Call destroy when the container is no longer in use.
 */
export async function mountStreamPayCheckout(options: EmbeddedCheckoutOptions) {
	if (typeof window === "undefined" || typeof document === "undefined") {
		throw new Error("StreamPay embedded checkout requires a browser.");
	}
	const paymentLink = new URL(options.paymentLink);
	if (
		paymentLink.protocol !== "https:" ||
		paymentLink.username ||
		paymentLink.password ||
		paymentLink.port ||
		(paymentLink.hostname !== "streampay.sa" && !paymentLink.hostname.endsWith(".streampay.sa"))
	) {
		throw new Error("Expected an HTTPS StreamPay payment link.");
	}

	const { container, signal, ...settings } = options;
	signal?.throwIfAborted();
	if (container.ownerDocument !== document || !container.isConnected) {
		throw new Error("The checkout container must be attached to this page.");
	}
	if (mountedContainers.has(container))
		throw new Error("Checkout is already using this container.");
	const mount = document.createElement("div");
	mountedContainers.set(container, mount);
	const release = () => {
		mount.remove();
		if (mountedContainers.get(container) === mount) mountedContainers.delete(container);
	};
	let onAbort: (() => void) | undefined;
	try {
		const ready = loadCheckout();
		const checkout = signal
			? await Promise.race([
					ready,
					new Promise<never>((_, reject) => {
						onAbort = () => {
							release();
							reject(signal.reason);
						};
						signal.addEventListener("abort", onAbort, { once: true });
					}),
				])
			: await ready;
		signal?.throwIfAborted();
		if (!container.isConnected) throw new Error("The checkout container was removed.");
		container.append(mount);
		const handle = checkout({ ...settings, container: mount, paymentLink: paymentLink.href });
		let destroyed = false;
		return {
			destroy() {
				if (destroyed) return;
				destroyed = true;
				try {
					handle.destroy();
				} finally {
					release();
				}
			},
		};
	} catch (error) {
		release();
		throw error;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
