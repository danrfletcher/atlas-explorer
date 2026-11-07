import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { FakeResizeObserver, fileUnits, keyAt, makeHarness, otherView, stubLayout } from "./explorer-view-scroll-helpers";

/** PR-2 (S2): `render()` builds the next pane in a hidden, same-size staging sibling, compares it with the
 * pane on screen and throws it away when the output is identical. These drive the real `render()`; only the
 * toolbar, the bucket's row content and the unit lookups are stubbed (see the two harnesses). */

type Internals = {
	render: () => Promise<void>;
	renderNodeList: (...args: unknown[]) => Promise<void>;
	pendingScrollTop: number | null;
	inboxLayoutObserver: unknown;
	inboxRedraw: (() => void) | null;
	lastRenderPainted: boolean | null;
	sortRefreshAllowedForThisRender: boolean;
	sortRefreshGate: { markDirty: () => void; consume: (dragging: boolean) => boolean };
	selectedInboxRefKeys: Set<string>;
};

let h: SectionHarness;
let ex: Internals;

beforeEach(() => {
	h = makeSectionHarness({ bucketRows: 2, inboxRows: 6 });
	ex = h.explorer as unknown as Internals;
});

afterEach(() => {
	h.teardown();
	vi.restoreAllMocks();
});

/** Records every mutation under `pane` from now until `stop()`. Records are delivered in a microtask, so
 * they are collected by the observer's own callback; `takeRecords()` picks up any not yet delivered. */
function watch(pane: HTMLElement): { stop: () => MutationRecord[] } {
	const records: MutationRecord[] = [];
	const observer = new MutationObserver((batch) => records.push(...batch));
	observer.observe(pane, { subtree: true, childList: true, attributes: true, characterData: true });
	return {
		stop: () => {
			records.push(...observer.takeRecords());
			observer.disconnect();
			return records;
		},
	};
}

/** Renders and returns how many mutations the live pane saw. */
async function renderCountingMutations(): Promise<number> {
	const watcher = watch(h.panel());
	await h.render();
	return watcher.stop().length;
}

describe("PR-2 (S2): an identical render leaves the pane on screen alone", () => {
	it("the first render paints", async () => {
		expect(h.panel().childElementCount).toBe(0);
		await h.render();
		expect(h.panel().querySelector(".atlas-explorer-scroll")).not.toBeNull();
		expect(ex.lastRenderPainted).toBe(true);
	});

	it("a second render straight after a real one causes zero mutations and keeps the same nodes", async () => {
		await h.render();
		const body = h.body();
		const firstRow = h.panel().querySelector(".atlas-inbox .atlas-row-virtual");

		expect(await renderCountingMutations()).toBe(0);

		expect(ex.lastRenderPainted).toBe(false);
		expect(h.body()).toBe(body);
		expect(h.panel().querySelector(".atlas-inbox .atlas-row-virtual")).toBe(firstRow);
	});

	it("builds in a sibling of the pane, never inside it, and leaves no staging node behind", async () => {
		await h.render();
		const seen: number[] = [];
		const original = (h.explorer as unknown as { renderBucketSection: (...a: unknown[]) => Promise<void> }).renderBucketSection;
		(h.explorer as unknown as { renderBucketSection: unknown }).renderBucketSection = async (...a: unknown[]) => {
			seen.push(h.host.querySelectorAll(".atlas-explorer-staging").length);
			expect(h.panel().querySelector(".atlas-explorer-staging")).toBeNull();
			return original.apply(h.explorer, a);
		};
		await h.render();
		expect(seen).toEqual([1]); // exactly one staging pane while it was being built
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
		expect(h.host.children).toHaveLength(2);
	});

	it("a discarded staging pane leaves no observer behind and keeps the live pane's redraw and observer", async () => {
		await h.render();
		const observer = ex.inboxLayoutObserver;
		const redraw = ex.inboxRedraw;
		const live = FakeResizeObserver.instances.filter((o) => o.observed.size > 0);
		expect(live).toHaveLength(1);

		await h.render();
		await h.render();

		expect(ex.inboxLayoutObserver).toBe(observer);
		expect(ex.inboxRedraw).toBe(redraw);
		expect(FakeResizeObserver.instances.filter((o) => o.observed.size > 0)).toHaveLength(1);
		expect(FakeResizeObserver.instances).toHaveLength(1);
	});

	it("transient state added after a render (focus, selection, open-note highlight) does not make identical output look changed", async () => {
		await h.render();
		const row = h.panel().querySelector<HTMLElement>(".atlas-inbox .atlas-row-virtual")!;
		row.focus();
		expect(document.activeElement).toBe(row);

		expect(await renderCountingMutations()).toBe(0);
		expect(document.activeElement).toBe(row); // the focused row is still the one on screen
	});
});

describe("PR-2 (S2): a visible change counts as a change", () => {
	/** Renders after `change()` and returns the mutation count and whether the pane was replaced. */
	async function changeThenRender(change: () => void): Promise<{ mutations: number; painted: boolean | null }> {
		await h.render();
		change();
		const mutations = await renderCountingMutations();
		return { mutations, painted: ex.lastRenderPainted };
	}

	it("an edited inbox label repaints with the new text, once", async () => {
		const result = await changeThenRender(() => h.state.labels.set(h.state.units[0].path, "Edited label"));
		expect(result.painted).toBe(true);
		expect(result.mutations).toBeGreaterThan(0);
		expect(h.panel().textContent).toContain("Edited label");

		expect(await renderCountingMutations()).toBe(0); // and then nothing more
	});

	it("a changed status repaints", async () => {
		const result = await changeThenRender(() => (h.state.bucketStatus = "done"));
		expect(result.painted).toBe(true);
		expect(h.panel().querySelector('.atlas-row-unit[data-status="done"]')).not.toBeNull();
	});

	it("a new row repaints, and so does a removed one", async () => {
		const added = await changeThenRender(() => (h.state.units = fileUnits(7)));
		expect(added.painted).toBe(true);
		expect(h.panel().querySelectorAll(".atlas-inbox .atlas-row-virtual")).toHaveLength(7);

		h.state.units = fileUnits(5);
		await h.render();
		expect(ex.lastRenderPainted).toBe(true);
		expect(h.panel().querySelectorAll(".atlas-inbox .atlas-row-virtual")).toHaveLength(5);
	});

	it("a bucket row set change repaints", async () => {
		const result = await changeThenRender(() => (h.state.bucketRows = 3));
		expect(result.painted).toBe(true);
		expect(h.panel().querySelectorAll(".atlas-bucket .atlas-row-unit")).toHaveLength(3);
	});

	it("a changed order repaints", async () => {
		await h.render();
		const order = () => Array.from(h.panel().querySelectorAll<HTMLElement>(".atlas-inbox .atlas-row-virtual")).map((el) => el.dataset.refKey);
		const before = order();
		// The inbox sorts by label, so relabelling the first unit last moves its row.
		h.state.labels.set(h.state.units[0].path, "zzz last");
		await h.render();
		expect(ex.lastRenderPainted).toBe(true);
		expect(order()).not.toEqual(before);
	});

	it("a selection change repaints, then settles", async () => {
		await h.render();
		ex.selectedInboxRefKeys.add(keyAt(h.state.units, 1));
		expect(await renderCountingMutations()).toBeGreaterThan(0);
		expect(await renderCountingMutations()).toBe(0);
	});
});

describe("PR-2 (S2): the Modified-sort gate is consumed whether or not the render is skipped (F2)", () => {
	it("a skipped render still uses up the refresh it was given", async () => {
		const allowed: boolean[] = [];
		ex.renderNodeList = async () => {
			allowed.push(ex.sortRefreshAllowedForThisRender);
		};
		await h.render(); // view load: allowed
		ex.sortRefreshGate.markDirty(); // e.g. a save
		await h.render(); // identical output, so skipped; the gate is spent here
		expect(ex.lastRenderPainted).toBe(false);
		await h.render();
		expect(allowed).toEqual([true, true, false]);
		// Nothing is left pending on the gate either: the skipped render took the refresh, it did not defer it.
		expect(ex.sortRefreshGate.consume(false)).toBe(false);
	});
});

describe("PR-2 (S2): a staging build that throws", () => {
	it("leaves no staging node and no stuck pendingScrollTop, and the live pane stays", async () => {
		await h.render();
		const body = h.body();
		const html = h.panel().innerHTML;
		ex.renderNodeList = async () => {
			throw new Error("boom");
		};

		await expect(h.render()).rejects.toThrow("boom");

		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
		expect(h.host.children).toHaveLength(2);
		expect(ex.pendingScrollTop).toBeNull();
		expect(h.body()).toBe(body);
		expect(h.panel().innerHTML).toBe(html);
		expect(FakeResizeObserver.instances.filter((o) => o.observed.size > 0)).toHaveLength(1);
	});
});

describe("PR-2 (E8): a render with nothing to compare against always paints", () => {
	let restore: (() => void) | null = null;
	afterEach(() => {
		restore?.();
		restore = null;
		document.body.replaceChildren();
	});

	it("a view switch repaints even when both views render identical output", async () => {
		const layout = { viewportHeight: 280, bucketHeight: 0 };
		restore = stubLayout(layout);
		const v = makeHarness(fileUnits(5), layout);
		await (v.explorer as unknown as Internals).render();
		const body = v.scrollBody();

		v.setActiveView(otherView);
		await (v.explorer as unknown as Internals).render();

		expect((v.explorer as unknown as Internals).lastRenderPainted).toBe(true);
		expect(v.scrollBody()).not.toBe(body);
	});

	it("an emptied pane repaints", async () => {
		await h.render();
		h.panel().replaceChildren();
		await h.render();
		expect(h.panel().querySelector(".atlas-explorer-scroll")).not.toBeNull();
		expect(ex.lastRenderPainted).toBe(true);
	});
});

describe("PR-2 (S2): after a skipped render the live pane still works", () => {
	let restore: (() => void) | null = null;
	afterEach(() => {
		restore?.();
		restore = null;
		document.body.replaceChildren();
	});

	it("scrolling the live body still redraws the inbox window", async () => {
		const layout = { viewportHeight: 280, bucketHeight: 0 };
		restore = stubLayout(layout);
		const v = makeHarness(fileUnits(2000), layout);
		const explorer = v.explorer as unknown as Internals;
		await explorer.render();
		await explorer.render();
		expect(explorer.lastRenderPainted).toBe(false);

		v.scrollBody().scrollTop = 28 * 500;
		v.scrollBody().dispatchEvent(new Event("scroll"));

		expect(v.inboxRowKeys()).toContain(keyAt(fileUnits(2000), 500));
	});

	it("the open-note highlight set after a render does not make the next identical render repaint", async () => {
		const layout = { viewportHeight: 280, bucketHeight: 0 };
		restore = stubLayout(layout);
		const units = fileUnits(20);
		const v = makeHarness(units, layout, { useRealHighlight: true });
		const explorer = v.explorer as unknown as Internals;
		await explorer.render();

		v.setActiveFile(units[3].path);
		(v.explorer as unknown as { updateActiveHighlight: () => void }).updateActiveHighlight();
		expect(v.panel().querySelectorAll(".atlas-row.is-active")).toHaveLength(1);

		const watcher = watch(v.panel());
		await explorer.render();
		const records = watcher.stop();

		expect(explorer.lastRenderPainted).toBe(false);
		expect(records).toHaveLength(0);
		expect(v.panel().querySelectorAll(".atlas-row.is-active")).toHaveLength(1);
	});
});

describe("PR-2 (R4): a change to inbox rows outside the drawn window is a change", () => {
	let restore: (() => void) | null = null;
	afterEach(() => {
		restore?.();
		restore = null;
		document.body.replaceChildren();
	});

	/** 2000 inbox rows, a 280px viewport (so only the top rows are in the DOM), labels taken from a map. */
	async function setup(alphabetical = false) {
		const layout = { viewportHeight: 280, bucketHeight: 0 };
		restore = stubLayout(layout);
		const units = fileUnits(2000);
		const v = makeHarness(units, layout);
		const labels = new Map<string, string>();
		(v.explorer as unknown as { resolveRef: unknown }).resolveRef = async (ref: { path: string }) => ({
			text: labels.get(ref.path) ?? ref.path,
			icon: "file",
		});
		if (alphabetical) (v.explorer as unknown as { sortMode: string }).sortMode = "alphabetical";
		const explorer = v.explorer as unknown as Internals;
		await explorer.render();
		expect(v.inboxRowKeys()).not.toContain(keyAt(units, 500));
		return { v, units, labels, explorer };
	}

	function scrollTo(v: ReturnType<typeof makeHarness>, row: number): void {
		v.scrollBody().scrollTop = 28 * row;
		v.scrollBody().dispatchEvent(new Event("scroll"));
	}

	function rowText(v: ReturnType<typeof makeHarness>, key: string): string | undefined {
		const row = Array.from(v.panel().querySelectorAll<HTMLElement>(".atlas-row-virtual")).find((r) => r.dataset.refKey === key);
		return row?.querySelector(".atlas-row-text")?.textContent ?? undefined;
	}

	it("an off-window label edit repaints, and the row shows the new label when scrolled to", async () => {
		const { v, units, labels, explorer } = await setup();
		labels.set(units[500].path, units[500].path); // same text: nothing changed, skipped
		await explorer.render();
		expect(explorer.lastRenderPainted).toBe(false);

		labels.set(units[500].path, `${units[500].path} EDITED`);
		await explorer.render();
		expect(explorer.lastRenderPainted).toBe(true);

		scrollTo(v, 500);
		expect(rowText(v, keyAt(units, 500))).toBe(`${units[500].path} EDITED`);
	});

	it("an off-window reorder repaints, and the window shows the new order", async () => {
		const { v, units, labels, explorer } = await setup(true);
		await explorer.render();
		expect(explorer.lastRenderPainted).toBe(false);

		// Rows 500 and 501 swap places far below the window: same row count, same markup in the window.
		labels.set(units[500].path, `${units[501].path}-after`);
		await explorer.render();
		expect(explorer.lastRenderPainted).toBe(true);

		scrollTo(v, 500);
		const keysInOrder = Array.from(v.panel().querySelectorAll<HTMLElement>(".atlas-row-virtual")).map((r) => r.dataset.refKey);
		const at500 = keysInOrder.indexOf(keyAt(units, 500));
		const at501 = keysInOrder.indexOf(keyAt(units, 501));
		expect(at501).toBeGreaterThanOrEqual(0);
		expect(at501).toBeLessThan(at500);
	});

	it("a row replaced by another with the row count unchanged repaints", async () => {
		const { v, units, explorer } = await setup();
		const replaced = units.slice();
		replaced[500] = { ...units[500], path: "inbox/zz-replacement.md" } as (typeof units)[number];
		v.setUnits(replaced);
		await explorer.render();
		expect(explorer.lastRenderPainted).toBe(true);
	});
});

