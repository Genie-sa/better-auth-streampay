import { afterEach, describe, expect, it, vi } from "vitest";
import { mountStreamPayCheckout } from "../src/client";

const paymentLink = "https://streampay.sa/ds/checkout-id";

function fakeBrowser() {
	const script = {
		src: "",
		onload: null as (() => void) | null,
		onerror: null as (() => void) | null,
		remove: vi.fn(),
	};
	const mount = { remove: vi.fn() };
	const destroy = vi.fn();
	const Checkout = vi.fn(() => ({ destroy }));
	const browser = {
		setTimeout,
		clearTimeout,
		Stream: undefined as { Checkout: typeof Checkout } | undefined,
	};
	const document = {
		createElement: vi.fn((tag: string) => (tag === "script" ? script : mount)),
		head: { append: vi.fn() },
	};
	const container = { ownerDocument: document, isConnected: true, append: vi.fn() };
	vi.stubGlobal("window", browser);
	vi.stubGlobal("document", document);
	return {
		document,
		container,
		script,
		mount,
		Checkout,
		destroy,
		mountCheckout: (url = paymentLink) =>
			mountStreamPayCheckout({ paymentLink: url, container: container as unknown as Element }),
		load: () => {
			browser.Stream = { Checkout };
			script.onload?.();
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("mountStreamPayCheckout", () => {
	it("can be imported on a server", async () => {
		await expect(mountStreamPayCheckout({ paymentLink, container: {} as Element })).rejects.toThrow(
			"requires a browser",
		);
	});

	it.each([
		"http://streampay.sa/ds/link",
		"https://streampay.sa.example/ds/link",
		"https://streampay.sa@checkout.example/ds/link",
		"https://checkout.example@streampay.sa/ds/link",
		"https://streampay.sa:444/ds/link",
		"https://streampay.sa/other",
	])("rejects unsupported payment URLs before loading a script (%s)", async (url) => {
		const h = fakeBrowser();
		await expect(h.mountCheckout(url)).rejects.toThrow("Expected an HTTPS StreamPay payment link");
		expect(h.document.head.append).not.toHaveBeenCalled();
	});

	it("mounts the official SDK once and disposes the checkout exactly once", async () => {
		const h = fakeBrowser();
		const checkout = h.mountCheckout();
		await expect(h.mountCheckout()).rejects.toThrow("already using this container");
		expect(h.script.src).toBe("https://stream-embed.streampay.sa/sdk/embed.min.js");
		h.load();
		const handle = await checkout;
		expect(h.Checkout).toHaveBeenCalledWith({ paymentLink, container: h.mount });
		handle.destroy();
		handle.destroy();
		expect(h.destroy).toHaveBeenCalledTimes(1);
		expect(h.mount.remove).toHaveBeenCalledTimes(1);

		(await h.mountCheckout()).destroy();
		expect(h.document.head.append).toHaveBeenCalledTimes(1);
	});

	it("allows a fresh attempt when the SDK fails to load", async () => {
		const h = fakeBrowser();
		const failed = h.mountCheckout();
		h.script.onerror?.();
		await expect(failed).rejects.toThrow("Could not load");
		expect(h.script.remove).toHaveBeenCalledTimes(1);
		const retry = h.mountCheckout();
		h.load();
		(await retry).destroy();
		expect(h.document.head.append).toHaveBeenCalledTimes(2);
	});

	it("does not mount a checkout after navigation removed the container", async () => {
		const h = fakeBrowser();
		const checkout = h.mountCheckout();
		h.container.isConnected = false;
		h.load();
		await expect(checkout).rejects.toThrow("checkout container was removed");
		expect(h.Checkout).not.toHaveBeenCalled();
	});
});
