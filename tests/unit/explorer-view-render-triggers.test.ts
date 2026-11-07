import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { AtlasExplorerView } from "../../src/explorer-view";
import { FakeResizeObserver, fileUnits } from "./explorer-view-scroll-helpers";
import { RenderLog } from "../../src/render-log";
import { Notice } from "obsidian";
import { noticeIfAddedRowHidden } from "../../src/add-under-hidden-notice";
import { bucketRows, drawBucketRows, flush, openExplorer, pointer, PressEnv } from "./explorer-view-press-helpers";

/** PR-1 polish (PR-2 R4/R5/R11): the real `onOpen` listeners and the real `render()` pipeline,
 * driven with real DOM events and fake timers (via the shared header harness). Covers the three
 * ways a render could previously go wrong around a refresh trigger:
 *  - R11: the focus-regain refresh must not run between a `pointerdown` and the `click` it starts;
 *  - R4: a render superseded mid-await must hand its pending Modified-sort refresh to its successor;
 *  - R5: every render during one native drag defers the refresh, not only the first. */

type Internals = {
	leaf: WorkspaceLeaf;
	render: () => Promise<void>;
	renderNodeList: (...args: unknown[]) => Promise<void>;
	sortRefreshAllowedForThisRender: boolean;
	registerDomEvent: (el: EventTarget, type: string, cb: (evt: Event) => void, opts?: boolean | AddEventListenerOptions) => void;
	registerEvent: (ref: unknown) => void;
	onOpen: () => Promise<void>;
};

let h: SectionHarness;
let ex: Internals;
let leafHandlers: ((leaf: unknown) => void)[];
let removers: (() => void)[];

function fireLeafChange(leaf: unknown): void {
	for (const cb of leafHandlers) cb(leaf);
}

/** Wires the explorer exactly as Obsidian would: real listeners attached to the real document/window. */
async function open(): Promise<void> {
	ex = h.explorer as unknown as Internals;
	ex.leaf = {} as WorkspaceLeaf;
	ex.registerEvent = vi.fn();
	ex.registerDomEvent = (el, type, cb, opts) => {
		el.addEventListener(type, cb, opts);
		removers.push(() => el.removeEventListener(type, cb, opts));
	};
	const on = (h.explorer as unknown as { plugin: { app: { workspace: { on: ReturnType<typeof vi.fn> } } } }).plugin.app.workspace.on;
	on.mockImplementation(((event: string, cb: (leaf: unknown) => void) => {
		if (event === "active-leaf-change") leafHandlers.push(cb);
		return {};
	}) as never);
	await ex.onOpen();
}

beforeEach(() => {
	vi.useFakeTimers();
	leafHandlers = [];
	removers = [];
	h = makeSectionHarness({ bucketRows: 1, inboxRows: 1 });
});

afterEach(() => {
	for (const remove of removers) remove();
	h.teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("PR-2 R11 — the focus-regain refresh waits for the pointer gesture", () => {
	it("a click that activates the leaf on pointerdown is not detached by a render before the click fires", async () => {
		await open();
		const render = vi.spyOn(ex, "render");
		fireLeafChange({}); // the editor was the active pane
		// The press is inside the Atlas pane: only presses there hold renders.
		const row = h.panel().appendChild(document.createElement("div"));
		const onClick = vi.fn();
		row.addEventListener("click", onClick);

		// What Obsidian does: pointerdown reaches the leaf's capture listener, which activates the leaf.
		row.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		fireLeafChange(ex.leaf);
		await vi.advanceTimersByTimeAsync(50);
		expect(render).not.toHaveBeenCalled(); // nothing may repaint under the held pointer

		row.dispatchEvent(new Event("pointerup", { bubbles: true }));
		row.dispatchEvent(new Event("click", { bubbles: true }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(render).not.toHaveBeenCalled(); // still none between pointerdown and click

		await vi.advanceTimersByTimeAsync(10);
		expect(render).toHaveBeenCalledTimes(1); // the refresh the trigger promised, after the gesture
	});

	it("holds when the leaf is activated by a capture-phase pointerdown listener on the leaf container, as Obsidian does", async () => {
		await open();
		const render = vi.spyOn(ex, "render");
		fireLeafChange({}); // the editor was the active pane

		// Obsidian: `leafContainer.addEventListener("pointerdown", () => setActiveLeaf(leaf), { capture: true })`.
		// The event really travels document-capture -> container-capture -> row, so this only passes if
		// Atlas's own listener is on the document in the capture phase (a bubble-phase or row-level
		// listener would run after the activation, when the render has already been queued).
		const container = h.panel().appendChild(document.createElement("div"));
		const row = container.appendChild(document.createElement("div"));
		const onClick = vi.fn();
		row.addEventListener("click", onClick);
		container.addEventListener("pointerdown", () => fireLeafChange(ex.leaf), { capture: true });

		row.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(50);
		expect(render).not.toHaveBeenCalled();
		expect(row.isConnected).toBe(true);

		row.dispatchEvent(new Event("pointerup", { bubbles: true }));
		row.dispatchEvent(new Event("click", { bubbles: true }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(render).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10);
		expect(render).toHaveBeenCalledTimes(1);
	});

	it("without a pointer gesture the focus-regain refresh still renders right away", async () => {
		await open();
		const render = vi.spyOn(ex, "render");
		fireLeafChange({});
		fireLeafChange(ex.leaf);
		await vi.advanceTimersByTimeAsync(10);
		expect(render).toHaveBeenCalledTimes(1);
	});

	it("a drag that starts on the row ends the gesture on dragend and releases the held refresh", async () => {
		await open();
		const render = vi.spyOn(ex, "render");
		fireLeafChange({});
		h.panel().dispatchEvent(new Event("pointerdown", { bubbles: true }));
		fireLeafChange(ex.leaf);
		document.body.dispatchEvent(new Event("dragstart", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(50);
		expect(render).not.toHaveBeenCalled();

		window.dispatchEvent(new Event("dragend"));
		await vi.advanceTimersByTimeAsync(10);
		expect(render).toHaveBeenCalledTimes(1); // the dragend backstop and the held refresh coalesce
	});

	it("a lost pointerup (released over a native menu) is recovered by the next pointermove with no button held", async () => {
		await open();
		const render = vi.spyOn(ex, "render");
		fireLeafChange({});
		h.panel().dispatchEvent(new Event("pointerdown", { bubbles: true }));
		fireLeafChange(ex.leaf);
		await vi.advanceTimersByTimeAsync(50);
		expect(render).not.toHaveBeenCalled();

		document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, buttons: 0 }));
		await vi.advanceTimersByTimeAsync(10);
		expect(render).toHaveBeenCalledTimes(1);
	});
});

describe("PR-2 R4 — a superseded render hands its pending Modified refresh to the render that replaces it", () => {
	/** Records the refresh allowance each `renderNodeList` call sees; the first call blocks on `gate`. */
	function recordAllowances(gate?: Promise<void>): boolean[] {
		const seen: boolean[] = [];
		let first = true;
		ex.renderNodeList = async () => {
			seen.push(ex.sortRefreshAllowedForThisRender);
			if (first && gate) {
				first = false;
				await gate;
			}
		};
		return seen;
	}

	it("baseline: sequential renders refresh once (the view-load trigger), then serve the cache", async () => {
		ex = h.explorer as unknown as Internals;
		const seen = recordAllowances();
		await ex.render();
		await ex.render();
		expect(seen).toEqual([true, false]);
	});

	it("the newer render inherits the refresh the superseded one had consumed, and the one after it does not", async () => {
		ex = h.explorer as unknown as Internals;
		let release!: () => void;
		const seen = recordAllowances(new Promise<void>((resolve) => (release = resolve)));

		const first = ex.render(); // consumes the view-load trigger, then blocks mid-render
		const second = ex.render(); // supersedes it before it reaches its remaining refs
		release();
		await Promise.all([first, second]);
		expect(seen).toEqual([true, true]);

		await ex.render();
		expect(seen).toEqual([true, true, false]); // the second landed as current, so nothing is left pending
	});

	it("a refresh held back by a drag is not handed on early by a superseded render", async () => {
		ex = h.explorer as unknown as Internals;
		(ex as unknown as { nativeDragActive: boolean }).nativeDragActive = true;
		let release!: () => void;
		const seen = recordAllowances(new Promise<void>((resolve) => (release = resolve)));

		const first = ex.render();
		const second = ex.render();
		release();
		await Promise.all([first, second]);
		expect(seen).toEqual([false, false]);

		(ex as unknown as { nativeDragActive: boolean }).nativeDragActive = false;
		await ex.render();
		expect(seen).toEqual([false, false, true]); // the gate stayed dirty until the drag was over
	});

	it("a drag that starts after the first render consumed the refresh keeps it for the first render after the drag", async () => {
		ex = h.explorer as unknown as Internals;
		const drag = ex as unknown as { nativeDragActive: boolean };
		let release!: () => void;
		const seen = recordAllowances(new Promise<void>((resolve) => (release = resolve)));

		const first = ex.render(); // no drag: consumes the view-load trigger, then blocks mid-render
		drag.nativeDragActive = true;
		const second = ex.render(); // supersedes it during the drag; must not refresh nor lose the refresh
		release();
		await Promise.all([first, second]);
		expect(seen).toEqual([true, false]);

		await ex.render(); // still dragging
		expect(seen).toEqual([true, false, false]);

		drag.nativeDragActive = false;
		await ex.render();
		expect(seen).toEqual([true, false, false, true]); // the refresh survived the drag
		await ex.render();
		expect(seen).toEqual([true, false, false, true, false]); // and is spent once taken
	});
});

describe("PR-2 R5 — every render during one native drag defers the refresh", () => {
	it("a second render during the same drag still sees a drag in progress, even though the first cleared the drag state", async () => {
		await open();
		(ex as unknown as { sortRefreshGate: { markDirty: () => void } }).sortRefreshGate.markDirty(); // onOpen's own render consumed the view-load one
		const seen: boolean[] = [];
		ex.renderNodeList = async () => {
			seen.push(ex.sortRefreshAllowedForThisRender);
		};

		window.dispatchEvent(new Event("dragstart"));
		await ex.render();
		await ex.render();
		await ex.render();
		expect(seen).toEqual([false, false, false]);

		window.dispatchEvent(new Event("dragend"));
		await vi.advanceTimersByTimeAsync(10); // the backstop's own queued render
		expect(seen).toEqual([false, false, false, true]); // the first render after the drag refreshes
	});

	it("a pointer event proves the drag is over even when dragend was lost with a detached source", async () => {
		await open();
		(ex as unknown as { sortRefreshGate: { markDirty: () => void } }).sortRefreshGate.markDirty(); // onOpen's own render consumed the view-load one
		const seen: boolean[] = [];
		ex.renderNodeList = async () => {
			seen.push(ex.sortRefreshAllowedForThisRender);
		};
		window.dispatchEvent(new Event("dragstart"));
		await ex.render();
		expect(seen).toEqual([false]);

		document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, buttons: 0 }));
		await ex.render();
		expect(seen).toEqual([false, true]);
	});
});

/** Atlas #16 PR-1: the hold sits at the render entry (`render()` / `queueRender()`), so every route
 * that ends in a render waits for a press inside an Atlas pane. These drive the real `onOpen`
 * listeners and the real render pipeline; only the bucket's row content is stubbed (by the harness). */
describe("Atlas #16 — a press inside an Atlas pane holds every render route until it ends", () => {
	let env: PressEnv;
	let rowCount: number;

	beforeEach(async () => {
		rowCount = 1;
		env = await openExplorer(h);
		drawBucketRows(env.ex, () => rowCount);
		await env.ex.render(); // draws the row a test presses
		env.renderNow.mockClear();
	});

	afterEach(() => env.teardown());

	/** One entry per route a render can be requested through. */
	const routes: [string, (e: PressEnv) => void][] = [
		["unitIndex.onChange", (e) => e.fireUnitIndexChange()],
		["viewsManager.onChange (persisted)", (e) => e.fireViewsChange(true)],
		["viewsManager.onChange (no change)", (e) => e.fireViewsChange(false)],
		["refresh()", (e) => e.ex.refresh()],
		[
			"active-leaf-change",
			(e) => {
				e.fireLeafChange({}); // the editor was active
				e.fireLeafChange(e.ex.leaf);
			},
		],
		["a direct render() call", (e) => void e.ex.render()],
	];

	for (const [name, request] of routes) {
		it(`${name}: nothing renders during the press, the pressed row stays attached, and the change shows once after release`, async () => {
			const row = bucketRows()[0];
			pointer("pointerdown", row, { buttons: 1 });
			rowCount = 3; // a change arrives mid-press
			request(env);
			await vi.advanceTimersByTimeAsync(50);
			expect(env.renderNow).not.toHaveBeenCalled();
			expect(row.isConnected).toBe(true);
			expect(bucketRows()).toHaveLength(1);

			pointer("pointerup", row);
			await flush(env);
			expect(env.renderNow).toHaveBeenCalledTimes(1);
			expect(bucketRows()).toHaveLength(3); // held, never dropped
		});

		it(`${name}: without a press it renders exactly as before`, async () => {
			rowCount = 3;
			request(env);
			await flush(env);
			expect(env.renderNow).toHaveBeenCalledTimes(1);
			expect(bucketRows()).toHaveLength(3);
		});
	}

	it("several renders requested in one press give exactly one render after it", async () => {
		const row = bucketRows()[0];
		pointer("pointerdown", row, { buttons: 1 });
		env.fireUnitIndexChange();
		env.fireViewsChange(true);
		env.ex.refresh();
		void env.ex.render();
		void env.ex.render();
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();

		pointer("pointerup", row);
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a press with no render requested gives no render, and a press that starts and ends in one tick leaves nothing stuck", async () => {
		const row = bucketRows()[0];
		pointer("pointerdown", row, { buttons: 1 });
		pointer("pointerup", row);
		await flush(env);
		expect(env.renderNow).not.toHaveBeenCalled();

		env.ex.refresh(); // not held: the next request renders as usual
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("Atlas already focused: a plain click costs no extra render and no delay", async () => {
		const row = bucketRows()[0];
		const onClick = vi.fn();
		row.addEventListener("click", onClick);
		pointer("pointerdown", row, { buttons: 1 });
		pointer("pointerup", row);
		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onClick).toHaveBeenCalledTimes(1);
		await flush(env);
		expect(env.renderNow).not.toHaveBeenCalled();
	});

	it("a render requested before the press is not held by it (the timer already queued it)", async () => {
		env.ex.refresh();
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a long press (several seconds) while vault events arrive renders nothing until release", async () => {
		const row = bucketRows()[0];
		pointer("pointerdown", row, { buttons: 1 });
		for (let second = 0; second < 6; second++) {
			rowCount++;
			env.fireUnitIndexChange();
			env.fireViewsChange(false);
			await vi.advanceTimersByTimeAsync(1000);
		}
		expect(env.renderNow).not.toHaveBeenCalled();
		expect(row.isConnected).toBe(true);

		pointer("pointerup", row);
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
		expect(bucketRows()).toHaveLength(7);
	});

	it("regression: editor active, press a row, Obsidian activates the leaf and the refresh-on-load callers rebuild — the row is still attached at pointerup and its click fires once", async () => {
		// Same wiring as `activateLeaf` in Obsidian: a capture listener on the leaf container.
		env.ex.refreshApiSourcesOnViewLoad = () => {
			// The folder-source, CSV, Markdown-table and API refreshes each end in `notifyChange()`.
			for (let i = 0; i < 4; i++) env.fireViewsChange(false);
		};
		h.panel().addEventListener(
			"pointerdown",
			() => {
				env.fireLeafChange(env.ex.leaf);
				env.fireUnitIndexChange();
			},
			{ capture: true }
		);
		env.fireLeafChange({}); // the editor is the active pane

		const row = bucketRows()[0];
		const onClick = vi.fn();
		row.addEventListener("click", onClick);
		let attachedAtPointerUp = false;
		let sameNodeAtPointerUp = false;
		row.addEventListener("pointerup", () => {
			attachedAtPointerUp = row.isConnected;
			sameNodeAtPointerUp = bucketRows()[0] === row;
		});

		pointer("pointerdown", row, { buttons: 1 });
		await vi.advanceTimersByTimeAsync(150); // about where the live probe saw the row gone
		pointer("pointerup", row);
		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(attachedAtPointerUp).toBe(true);
		expect(sameNodeAtPointerUp).toBe(true);
		expect(onClick).toHaveBeenCalledTimes(1);
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1); // the refreshes ran once, after the click
	});
});

describe("Atlas #16 — the same regression for a windowed inbox row", () => {
	let env: PressEnv;

	beforeEach(async () => {
		h.teardown();
		h = makeSectionHarness({ bucketRows: 1, inboxRows: 60 });
		env = await openExplorer(h);
		env.ex.openRef = vi.fn(async () => {});
		await env.ex.render();
		env.renderNow.mockClear();
	});

	afterEach(() => env.teardown());

	it("the pressed row is inside the virtualised window and opens on the first click", async () => {
		const inboxRows = Array.from(document.querySelectorAll<HTMLElement>(".atlas-inbox .atlas-row-unit"));
		expect(inboxRows.length).toBeGreaterThan(0);
		expect(inboxRows.length).toBeLessThan(60); // windowed: most inbox rows are not in the DOM
		const row = inboxRows[0];

		env.ex.refreshApiSourcesOnViewLoad = () => {
			for (let i = 0; i < 4; i++) env.fireViewsChange(false);
		};
		h.panel().addEventListener(
			"pointerdown",
			() => {
				env.fireLeafChange(env.ex.leaf);
				env.fireUnitIndexChange();
			},
			{ capture: true }
		);
		env.fireLeafChange({}); // the editor is the active pane

		let attachedAtPointerUp = false;
		row.addEventListener("pointerup", () => (attachedAtPointerUp = row.isConnected));

		pointer("pointerdown", row, { buttons: 1 });
		await vi.advanceTimersByTimeAsync(150);
		expect(row.isConnected).toBe(true);
		pointer("pointerup", row);
		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(attachedAtPointerUp).toBe(true);
		expect(env.ex.openRef).toHaveBeenCalledTimes(1); // the row's real click handler ran
		await flush(env);
		expect(env.renderNow).toHaveBeenCalled();
	});
});

describe("Atlas #16 (E7) — the add-under flows still finish when their render is held by a press", () => {
	let env: PressEnv;
	let withNewRow: boolean;
	const originalCSS = (globalThis as { CSS?: unknown }).CSS;

	beforeEach(async () => {
		Notice.reset();
		// jsdom has no `CSS`; the visibility check in `noticeIfAddedRowHidden` calls `CSS.escape`.
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v) => v };
		withNewRow = false;
		env = await openExplorer(h);
		env.ex.renderNodeList = async (_nodes, container) => {
			container.createDiv({ cls: "atlas-row atlas-row-unit" });
			if (withNewRow) container.createDiv({ cls: "atlas-row atlas-row-unit" }).dataset.selectKey = "new-node";
		};
		await env.ex.render();
	});

	afterEach(() => {
		env.teardown();
		(globalThis as { CSS?: unknown }).CSS = originalCSS;
	});

	/** What `runAddUnderFolder` and friends do: kick a render, then wait for it to settle. */
	function addUnderFlow(filterActive: boolean): Promise<void> {
		void env.ex.render();
		return noticeIfAddedRowHidden("new-node", "New folder", "Projects", {
			render: () => env.ex.awaitRenderSettled(),
			getBucketListEl: () => env.ex.bucketListEl,
			filterActive,
		});
	}

	it("the flow waits through the press, then finds the row drawn by the held render and shows no notice", async () => {
		pointer("pointerdown", bucketRows()[0], { buttons: 1 });
		withNewRow = true;
		let done = false;
		const flow = addUnderFlow(true).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(100);
		expect(done).toBe(false);
		expect(Notice.instances).toHaveLength(0);

		pointer("pointerup", bucketRows()[0]);
		await vi.advanceTimersByTimeAsync(50);
		await flow;
		expect(done).toBe(true);
		expect(Notice.instances).toHaveLength(0); // the row rendered: no "hidden" notice
	});

	it("a row the held render really leaves out still gets its 'added row hidden' notice, after release", async () => {
		pointer("pointerdown", bucketRows()[0], { buttons: 1 });
		let done = false;
		const flow = addUnderFlow(true).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(100);
		expect(done).toBe(false);

		pointer("pointerup", bucketRows()[0]);
		await vi.advanceTimersByTimeAsync(50);
		await flow;
		expect(Notice.instances.some((n) => n.message.includes("hidden by the current filter"))).toBe(true);
	});
});

/** PR-2 (S2/S3): the render triggers that used to flash the list now end in no change on screen when the
 * output is identical, and a pane that is not shown waits to be shown. Real `onOpen` listeners, real
 * `render()`; the harness records what the pane's mutation observer sees. */
describe("PR-2 (S3) — leaf activation and a metadata resolve do not repaint an unchanged list", () => {
	type Plugin = { unitIndex: { onChange: ReturnType<typeof vi.fn> }; renderLog?: RenderLog };
	const plugin = () => (h.explorer as unknown as { plugin: Plugin }).plugin;
	const fireUnitIndexChange = () => (plugin().unitIndex.onChange.mock.calls[0][0] as () => void)();

	function watchPane(): { stop: () => MutationRecord[] } {
		const records: MutationRecord[] = [];
		const observer = new MutationObserver((batch) => records.push(...batch));
		observer.observe(h.panel(), { subtree: true, childList: true, attributes: true, characterData: true });
		return {
			stop: () => {
				records.push(...observer.takeRecords());
				observer.disconnect();
				return records;
			},
		};
	}

	it("a leaf activation plus a resolve in one burst gives one render and no mutation when the output is identical", async () => {
		await open();
		const render = vi.spyOn(ex, "render");
		const watcher = watchPane();

		fireLeafChange({}); // the editor was the active pane
		fireLeafChange(ex.leaf); // focus regained: source refresh + the render it promised
		fireUnitIndexChange(); // the metadata resolve / index change in the same burst
		await vi.advanceTimersByTimeAsync(50);

		expect(render).toHaveBeenCalledTimes(1); // coalesced by queueRender
		expect((ex as unknown as { lastRenderPainted: boolean }).lastRenderPainted).toBe(false);
		expect(watcher.stop()).toHaveLength(0);
	});

	it("the same burst gives exactly one repaint when a visible row changed", async () => {
		await open();
		const watcher = watchPane();
		h.state.labels.set(h.state.units[0].path, "Renamed in the burst");

		fireLeafChange({});
		fireLeafChange(ex.leaf);
		fireUnitIndexChange();
		await vi.advanceTimersByTimeAsync(50);

		const records = watcher.stop();
		// One replacement of the pane's children: `replaceChildren` is a single `childList` record on the pane itself.
		expect(records.filter((r) => r.target === h.panel() && r.type === "childList")).toHaveLength(1);
		expect(h.panel().textContent).toContain("Renamed in the burst");
	});
});

describe("PR-2 (S3/E6) — a pane that is not shown records the request and renders when shown", () => {
	type Plugin = { unitIndex: { onChange: ReturnType<typeof vi.fn> }; renderLog?: RenderLog };
	const plugin = () => (h.explorer as unknown as { plugin: Plugin }).plugin;
	const fireUnitIndexChange = () => (plugin().unitIndex.onChange.mock.calls[0][0] as () => void)();
	const adapter = { read: async () => "[]", write: async () => {}, exists: async () => false };

	beforeEach(() => {
		plugin().renderLog = new RenderLog(adapter, "render-log.json");
	});

	it("defers while hidden, logs the request with its trigger kind, and paints once when shown", async () => {
		await open();
		const render = vi.spyOn(ex as unknown as { renderNodeList: () => Promise<void> }, "renderNodeList");
		const logged = plugin().renderLog!;
		const before = logged.entries().length;

		h.setShown(false);
		h.state.labels.set(h.state.units[0].path, "Changed while hidden");
		fireUnitIndexChange();
		await vi.advanceTimersByTimeAsync(50);

		expect(render).not.toHaveBeenCalled(); // nothing was built
		expect(h.panel().textContent).not.toContain("Changed while hidden");
		expect(logged.entries().slice(before)).toEqual([expect.objectContaining({ kind: "unit-index", changed: false, durationMs: 0 })]);

		// A second request while hidden is still just recorded, and only one wait is armed.
		fireUnitIndexChange();
		await vi.advanceTimersByTimeAsync(50);
		expect(render).not.toHaveBeenCalled();
		expect(FakeResizeObserver.instances.filter((o) => o.observed.has(h.host))).toHaveLength(1);

		h.setShown(true);
		h.fireResize();
		await vi.advanceTimersByTimeAsync(50);

		expect(h.panel().textContent).toContain("Changed while hidden");
		const after = logged.entries().slice(before);
		expect(after[after.length - 1]).toEqual(expect.objectContaining({ kind: "unit-index", changed: true }));
		expect(FakeResizeObserver.instances.filter((o) => o.observed.has(h.host))).toHaveLength(0); // the wait is over

		// Nothing else is armed: showing again renders nothing new.
		const count = logged.entries().length;
		h.fireResize();
		await vi.advanceTimersByTimeAsync(50);
		expect(logged.entries()).toHaveLength(count);
	});

	it("a resize while still hidden does not render", async () => {
		await open();
		h.setShown(false);
		h.state.labels.set(h.state.units[0].path, "Still hidden");
		fireUnitIndexChange();
		await vi.advanceTimersByTimeAsync(50);

		h.fireResize();
		await vi.advanceTimersByTimeAsync(50);

		expect(h.panel().textContent).not.toContain("Still hidden");
	});

	it("closing a view that is waiting to be shown disconnects the wait", async () => {
		await open();
		h.setShown(false);
		fireUnitIndexChange();
		await vi.advanceTimersByTimeAsync(50);
		const watcher = FakeResizeObserver.instances.find((o) => o.observed.has(h.host))!;

		await (ex as unknown as { onClose: () => Promise<void> }).onClose();

		expect(watcher.disconnect).toHaveBeenCalled();
	});

	it("two Atlas leaves, one hidden: a change repaints the visible one now and the hidden one when shown", async () => {
		await open();
		const second = new AtlasExplorerView({} as WorkspaceLeaf, (h.explorer as unknown as { plugin: never }).plugin);
		const secondHost = document.createElement("div");
		secondHost.append(document.createElement("div"), document.createElement("div"));
		document.body.appendChild(secondHost);
		Object.assign(second, {
			containerEl: secondHost,
			renderToolbar: (container: HTMLElement) => container.createDiv({ cls: "atlas-toolbar" }),
			renderNodeList: async () => {},
			resolveRef: async (ref: { path: string }) => ({ text: h.state.labels.get(ref.path) ?? ref.path, icon: "file" }),
			matchesFilter: () => true,
			setPlacementTooltip: vi.fn(),
			updateActiveHighlight: vi.fn(),
			syncRefreshTimers: vi.fn(),
			refreshApiSourcesOnViewLoad: vi.fn(),
		});
		const secondPanel = () => secondHost.children[1] as HTMLElement;
		await (second as unknown as { render: () => Promise<void> }).render();
		secondHost.setAttribute("data-test-hidden", "");

		h.state.labels.set(h.state.units[0].path, "Seen by both");
		fireUnitIndexChange(); // the visible leaf's own listener (only it called onOpen in this harness)
		await (second as unknown as { render: () => Promise<void> }).render(); // what the hidden leaf's own listener would ask for
		await vi.advanceTimersByTimeAsync(50);

		expect(h.panel().textContent).toContain("Seen by both"); // the visible one repainted now
		expect(secondPanel().textContent).not.toContain("Seen by both"); // the hidden one did not

		secondHost.removeAttribute("data-test-hidden");
		for (const observer of FakeResizeObserver.instances) observer.fire();
		await vi.advanceTimersByTimeAsync(50);

		expect(secondPanel().textContent).toContain("Seen by both");
	});
});

describe("PR-3 (E3) — the atomic swap and a drag in progress", () => {
	type DragState = {
		nativeDragActive: boolean;
		dragPayload: unknown;
		inboxDragRowEl: HTMLElement | null;
		bucketDragRowEl: HTMLElement | null;
		cancelActiveDwell: (() => void) | null;
	};
	const drag = () => h.explorer as unknown as DragState;

	/** Starts a native drag from an inbox row and a bucket row, the state the row `dragstart` handlers leave. */
	async function startDrag(): Promise<{ inboxRow: HTMLElement; bucketRow: HTMLElement; dwell: ReturnType<typeof vi.fn>; payload: object }> {
		await open();
		const inboxRow = h.panel().querySelector<HTMLElement>(".atlas-inbox .atlas-row-virtual")!;
		const bucketRow = h.panel().querySelector<HTMLElement>(".atlas-bucket .atlas-row-unit")!;
		window.dispatchEvent(new Event("dragstart")); // nativeDragActive
		const payload = { kind: "node", nodeId: "n1", viewId: "v1" };
		drag().dragPayload = payload;
		drag().inboxDragRowEl = inboxRow;
		drag().bucketDragRowEl = bucketRow;
		const dwell = vi.fn();
		drag().cancelActiveDwell = dwell;
		return { inboxRow, bucketRow, dwell, payload };
	}

	it("a real change during a drag clears the payload and the drag rows and cancels the dwell, in one swap", async () => {
		const { inboxRow, dwell } = await startDrag();
		const replace = vi.spyOn(h.panel(), "replaceChildren");

		h.state.units = fileUnits(3);
		await ex.render();

		expect(replace).toHaveBeenCalledTimes(1);
		expect(inboxRow.isConnected).toBe(false);
		expect(drag().dragPayload).toBeNull();
		expect(drag().inboxDragRowEl).toBeNull();
		expect(drag().bucketDragRowEl).toBeNull();
		expect(dwell).toHaveBeenCalledTimes(1);
		expect(drag().nativeDragActive).toBe(true); // only dragend / drop / a pointer event ends the native drag
	});

	it("an identical render during a drag is skipped and touches no part of the drag", async () => {
		const { inboxRow, bucketRow, dwell, payload } = await startDrag();
		const replace = vi.spyOn(h.panel(), "replaceChildren");
		const watcher = new MutationObserver(() => {});
		watcher.observe(h.panel(), { subtree: true, childList: true, attributes: true, characterData: true });

		await ex.render();

		expect(watcher.takeRecords()).toHaveLength(0);
		watcher.disconnect();
		expect(replace).not.toHaveBeenCalled();
		expect(drag().dragPayload).toBe(payload);
		expect(drag().inboxDragRowEl).toBe(inboxRow);
		expect(drag().bucketDragRowEl).toBe(bucketRow);
		expect(inboxRow.isConnected).toBe(true);
		expect(dwell).not.toHaveBeenCalled();
		expect(drag().nativeDragActive).toBe(true);
	});

	it("the sort-refresh deferral during a drag is unchanged: a swapped render does not refresh, the first one after the drag does", async () => {
		await startDrag();
		(ex as unknown as { sortRefreshGate: { markDirty: () => void } }).sortRefreshGate.markDirty();
		const seen: boolean[] = [];
		ex.renderNodeList = async () => {
			seen.push(ex.sortRefreshAllowedForThisRender);
		};

		h.state.units = fileUnits(3);
		await ex.render(); // a real change: swapped in, the refresh still waits
		await ex.render(); // identical: skipped, still waiting
		expect(seen).toEqual([false, false]);

		window.dispatchEvent(new Event("dragend"));
		await vi.advanceTimersByTimeAsync(10);
		expect(seen).toEqual([false, false, true]);
	});
});
