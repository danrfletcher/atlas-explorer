import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEPHRA_REFUSED_TOOLTIP, TephraStatusBar, tephraStatusLabel } from "../../src/tephra-status-bar";
import { TephraStarter } from "../../src/tephra-start";
import type { TephraSnapshot } from "../../src/tephra-connection";
import type { TephraSource } from "../../src/tephra-client";

const src = (name: string): TephraSource => ({ name, path: `/${name}`, status: "online" });
const online = (...names: string[]): TephraSnapshot => ({ state: "online", checked: true, sources: names.map(src), error: null });
const offline: TephraSnapshot = { state: "offline", checked: true, sources: [], error: { kind: "network", message: "Tephra is unreachable" } };
const refused: TephraSnapshot = { state: "offline", checked: true, sources: [], error: { kind: "unauthorized", message: "Tephra rejected the token", status: 401 } };
const unchecked: TephraSnapshot = { state: "offline", checked: false, sources: [], error: null };
const off: TephraSnapshot = { state: "off", checked: false, sources: [], error: null };

describe("the label rule (G13/E1)", () => {
	it("online with N sources: 'Tephra · N sources', vault included in the count", () => {
		expect(tephraStatusLabel(online("notes", "tephra", "whoop"), false)).toMatchObject({ kind: "online", text: "Tephra · 3 sources", showStart: false });
	});

	it("online with one source (the vault alone): singular, 'Tephra · 1 source'", () => {
		expect(tephraStatusLabel(online("notes"), false)?.text).toBe("Tephra · 1 source");
	});

	it("online with none listed: 'Tephra · 0 sources'", () => {
		expect(tephraStatusLabel(online(), false)?.text).toBe("Tephra · 0 sources");
	});

	it("offline: 'Tephra offline · Start', with the Start control", () => {
		expect(tephraStatusLabel(offline, false)).toMatchObject({ kind: "offline", text: "Tephra offline · Start", showStart: true });
		expect(tephraStatusLabel(offline, false)?.tooltip).toContain("tephractl daemon start");
	});

	it("a 401 is offline for display, with the tooltip 'Tephra refused the token'", () => {
		const label = tephraStatusLabel(refused, false);
		expect(label).toMatchObject({ kind: "offline", text: "Tephra offline · Start", tooltip: "Tephra refused the token" });
		expect(TEPHRA_REFUSED_TOOLTIP).toBe("Tephra refused the token");
	});

	it("starting: 'Tephra starting…' with no Start control; online still wins over starting", () => {
		expect(tephraStatusLabel(offline, true)).toMatchObject({ kind: "starting", text: "Tephra starting…", showStart: false });
		expect(tephraStatusLabel(refused, true)?.text).toBe("Tephra starting…");
		expect(tephraStatusLabel(online("notes", "a"), true)?.text).toBe("Tephra · 2 sources");
	});

	it("before the first answer it doesn't claim Tephra is offline, and offers no Start", () => {
		expect(tephraStatusLabel(unchecked, false)).toMatchObject({ kind: "checking", showStart: false });
	});

	it("off (toggle off): no item at all", () => {
		expect(tephraStatusLabel(off, false)).toBeNull();
		expect(tephraStatusLabel(off, true)).toBeNull();
	});
});

/** A connection stand-in the test drives by hand, and the real starter (its runner is a spy). */
function rig() {
	let snapshot: TephraSnapshot = off;
	const listeners = new Set<(s: TephraSnapshot) => void>();
	const connection = {
		getSnapshot: () => snapshot,
		onChange: (l: (s: TephraSnapshot) => void): (() => void) => {
			listeners.add(l);
			return () => void listeners.delete(l);
		},
	};
	const set = (next: TephraSnapshot) => {
		snapshot = next;
		for (const l of [...listeners]) l(next);
	};
	const runs: string[][] = [];
	const starter = new TephraStarter({
		check: async () => {},
		run: async (argv) => {
			runs.push(argv);
			return { ok: true, exitCode: 0 };
		},
	});
	const items: HTMLElement[] = [];
	const opened = vi.fn();
	const started = vi.fn();
	const bar = new TephraStatusBar({
		addItem: () => {
			const el = document.createElement("div");
			el.className = "status-bar-item";
			document.body.appendChild(el);
			items.push(el);
			return el;
		},
		openSettings: opened,
		start: started,
	});
	return { connection, set, starter, runs, items, opened, started, bar, listeners };
}

const live = () => [...document.querySelectorAll<HTMLElement>(".atlas-tephra-status")];

beforeEach(() => {
	document.body.innerHTML = "";
});
afterEach(() => {
	document.body.innerHTML = "";
});

describe("the status-bar item", () => {
	it("is absent while the connection is off, appears when it starts, and goes when it stops", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		expect(live()).toHaveLength(0);
		r.set(unchecked);
		expect(live()).toHaveLength(1);
		r.set(online("notes", "whoop"));
		expect(live()[0].textContent).toBe("Tephra · 2 sources");
		r.set(off);
		expect(live()).toHaveLength(0);
	});

	it("hide() removes the item and the subscriptions in the same tick; later changes draw nothing", () => {
		const r = rig();
		r.set(online("notes"));
		r.bar.attach(r.connection, r.starter);
		expect(live()).toHaveLength(1);
		r.bar.hide();
		expect(live()).toHaveLength(0);
		expect(r.listeners.size).toBe(0);
		r.set(offline);
		expect(live()).toHaveLength(0);
		expect(r.items).toHaveLength(1);
	});

	it("attach() again (the toggle back on) adds one item; a second attach to a new connection drops the old subscription", () => {
		const r = rig();
		r.set(online("notes"));
		r.bar.attach(r.connection, r.starter);
		r.bar.hide();
		r.bar.attach(r.connection, r.starter);
		r.bar.attach(r.connection, r.starter);
		expect(live()).toHaveLength(1);
		expect(r.listeners.size).toBe(1);
	});

	it("flapping online/offline many times updates one item, never adds a second, and the text matches the last result", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(unchecked);
		for (let i = 0; i < 8; i++) {
			r.set(i % 2 === 0 ? online("notes", "whoop", "tephra") : offline);
			expect(live()).toHaveLength(1);
			expect(live()[0].textContent).toBe(i % 2 === 0 ? "Tephra · 3 sources" : "Tephra offline · Start");
		}
		expect(r.items).toHaveLength(1);
		expect(live()[0].querySelector(".atlas-tephra-start")).not.toBeNull();
	});

	it("shows 'Tephra starting…' while the starter runs, and 'Tephra offline · Start' again once a failed start ends", async () => {
		const r = rig();
		let finish: (ok: boolean) => void = () => {};
		const starter = new TephraStarter({
			check: async () => {},
			run: () => new Promise((resolve) => (finish = (ok) => resolve(ok ? { ok: true, exitCode: 0 } : { ok: false, error: "x" }))),
		});
		r.bar.attach(r.connection, starter);
		r.set(offline);
		const pending = starter.start();
		expect(live()[0].textContent).toBe("Tephra starting…");
		expect(live()[0].querySelector(".atlas-tephra-start")).toBeNull();
		finish(false);
		await pending;
		expect(live()[0].textContent).toBe("Tephra offline · Start");
		expect(live()[0].querySelector(".atlas-tephra-start")).not.toBeNull();
	});

	it("click on the online label opens the Tephra tab; it never calls the start runner", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(online("notes", "whoop", "tephra"));
		live()[0].click();
		expect(r.opened).toHaveBeenCalledTimes(1);
		expect(r.started).not.toHaveBeenCalled();
	});

	it("click on Start calls the injected runner once and doesn't also open settings", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(offline);
		live()[0].querySelector<HTMLElement>(".atlas-tephra-start")!.click();
		expect(r.started).toHaveBeenCalledTimes(1);
		expect(r.opened).not.toHaveBeenCalled();
	});

	it("click on the 'Tephra offline' text opens the settings (where the G16 message is), not Start", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(offline);
		live()[0].querySelector<HTMLElement>(".atlas-tephra-status-text")!.click();
		expect(r.opened).toHaveBeenCalledTimes(1);
		expect(r.started).not.toHaveBeenCalled();
	});

	it("Enter on Start (keyboard) starts; Enter on an online item opens the settings", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(offline);
		live()[0].querySelector<HTMLElement>(".atlas-tephra-start")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(r.started).toHaveBeenCalledTimes(1);
		r.set(online("notes"));
		live()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(r.opened).toHaveBeenCalledTimes(1);
	});

	it("while starting there is no Start to click: a click opens the settings and starts nothing", () => {
		const r = rig();
		const starter = new TephraStarter({ check: async () => {}, run: () => new Promise(() => {}) });
		r.bar.attach(r.connection, starter);
		r.set(offline);
		void starter.start();
		live()[0].click();
		expect(r.started).not.toHaveBeenCalled();
		expect(r.opened).toHaveBeenCalledTimes(1);
	});
});

describe("the hover text is an Atlas-owned element, shown on hover and keyboard focus (never aria-label)", () => {
	const tooltip = () => document.querySelector<HTMLElement>(".atlas-tephra-tooltip");

	it("mouseenter shows the tooltip element with the state's text; mouseleave removes it", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(refused);
		const item = live()[0];
		expect(tooltip()).toBeNull();
		item.dispatchEvent(new MouseEvent("mouseenter"));
		expect(tooltip()?.textContent).toBe("Tephra refused the token");
		expect(tooltip()?.parentElement).toBe(document.body);
		item.dispatchEvent(new MouseEvent("mouseleave"));
		expect(tooltip()).toBeNull();
	});

	it("keyboard focus shows it and blur removes it", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(offline);
		const item = live()[0];
		item.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(tooltip()?.textContent).toContain("Tephra isn't running");
		item.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		expect(tooltip()).toBeNull();
	});

	it("the text follows the state while it is showing (offline becomes online under the pointer)", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(offline);
		live()[0].dispatchEvent(new MouseEvent("mouseenter"));
		r.set(refused);
		expect(tooltip()?.textContent).toBe("Tephra refused the token");
		r.set(online("notes", "a"));
		expect(tooltip()?.textContent).toContain("Tephra is running");
	});

	it("the item carries no aria-label and no title: the tooltip is not Obsidian's or the browser's", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(refused);
		const item = live()[0];
		expect(item.hasAttribute("aria-label")).toBe(false);
		expect(item.hasAttribute("title")).toBe(false);
		expect(item.hasAttribute("data-tooltip-position")).toBe(false);
	});

	it("hide() and a vanishing item take the open tooltip with them", () => {
		const r = rig();
		r.bar.attach(r.connection, r.starter);
		r.set(offline);
		live()[0].dispatchEvent(new MouseEvent("mouseenter"));
		expect(tooltip()).not.toBeNull();
		r.set(off);
		expect(tooltip()).toBeNull();
		r.set(offline);
		live()[0].dispatchEvent(new MouseEvent("mouseenter"));
		r.bar.hide();
		expect(tooltip()).toBeNull();
	});
});
