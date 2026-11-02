import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";

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
		const row = document.body.appendChild(document.createElement("div"));
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
		const container = document.body.appendChild(document.createElement("div"));
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
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
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
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
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
