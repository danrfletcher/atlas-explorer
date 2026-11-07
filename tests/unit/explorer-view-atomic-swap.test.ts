import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, fileUnits, makeHarness, stubLayout } from "./explorer-view-scroll-helpers";

/** PR-3 (S4): when a render's output differs from what is on screen, the staged pane replaces the live
 * one in a single `replaceChildren`. These drive the real `render()` with a `MutationObserver` on the live
 * pane; only the bucket's content and the unit lookups are stubbed (see `makeHarness`). The toolbar is the
 * real `renderToolbar` (so the real filter input and its listeners are under test). */

type Internals = {
	render: () => Promise<void>;
	renderSeq: number;
	pendingScrollTop: number | null;
	sortRefreshUnfinished: boolean;
	lastRenderPainted: boolean | null;
	stickyEls: { body: HTMLElement } | null;
	filterInputEl: HTMLInputElement | null;
	filterText: string;
	pointerGestureActive: boolean;
	inboxLayoutObserver: unknown;
	renderBucketSection: (...args: unknown[]) => Promise<void>;
	resolveRef: (ref: { path: string }) => Promise<{ text: string; icon: string }>;
	renderInboxSection: (...args: unknown[]) => Promise<void>;
	syncRefreshTimers: ReturnType<typeof vi.fn>;
	updateActiveHighlight: ReturnType<typeof vi.fn>;
	onClose: () => Promise<void>;
};

type Harness = ReturnType<typeof makeHarness>;

let restoreLayout: (() => void) | null = null;
let h: Harness;
let ex: Internals;

function setup(unitCount = 30, realToolbar = false): void {
	const layout = { viewportHeight: 280, bucketHeight: 0 };
	restoreLayout = stubLayout(layout);
	h = makeHarness(fileUnits(unitCount), layout);
	ex = h.explorer as unknown as Internals;
	if (realToolbar) delete (h.explorer as unknown as Record<string, unknown>).renderToolbar;
	// The harness's bucket stub draws no section header; the swap hands over the real section shape.
	ex.renderBucketSection = async (el: unknown) => {
		const bucket = el as HTMLElement;
		bucket.createDiv({ cls: "atlas-section-header" });
		bucket.createDiv({ cls: "atlas-meta-children" }).createDiv({ cls: "atlas-node-list" });
	};
}

afterEach(() => {
	document.body.replaceChildren();
	restoreLayout?.();
	restoreLayout = null;
	vi.restoreAllMocks();
});

/** Collects every mutation under the live pane (the whole subtree) until `stop()`. */
function watch(pane: HTMLElement): { records: () => MutationRecord[]; stop: () => MutationRecord[] } {
	const seen: MutationRecord[] = [];
	const observer = new MutationObserver((batch) => seen.push(...batch));
	observer.observe(pane, { subtree: true, childList: true, attributes: true, characterData: true });
	return {
		records: () => [...seen, ...observer.takeRecords()],
		stop: () => {
			seen.push(...observer.takeRecords());
			observer.disconnect();
			return seen;
		},
	};
}

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

/** Lets pending microtasks run (promise continuations of an awaited stub). */
async function tick(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Stalls the render whose `renderSeq` is `seq` at `point`, until the returned `release()`. */
type StallPoint = "bucket" | "inbox-resolve";
function stallRender(seq: number, point: StallPoint): { release: () => void } {
	const gate = deferred();
	if (point === "bucket") {
		const original = ex.renderBucketSection;
		ex.renderBucketSection = async function (this: unknown, ...args: unknown[]) {
			if (ex.renderSeq === seq) await gate.promise;
			return original.apply(h.explorer, args);
		};
	} else {
		const original = ex.resolveRef;
		ex.resolveRef = async (ref) => {
			if (ex.renderSeq === seq) await gate.promise;
			return original.call(h.explorer, ref);
		};
	}
	return { release: gate.release };
}

function rowCount(): number {
	return Number(h.panel().querySelector(".atlas-inbox .atlas-count-badge")?.textContent ?? -1);
}

describe("PR-3 (S4): one replaceChildren puts the changed pane on screen", () => {
	beforeEach(() => setup());

	it("replaces the live children with a single replaceChildren call and never calls empty()", async () => {
		await ex.render();
		const replace = vi.spyOn(h.panel(), "replaceChildren");
		const empty = vi.spyOn(h.panel() as unknown as { empty: () => void }, "empty");

		h.setUnits(fileUnits(31));
		await ex.render();

		expect(ex.lastRenderPainted).toBe(true);
		expect(replace).toHaveBeenCalledTimes(1);
		expect(empty).not.toHaveBeenCalled();
		expect(rowCount()).toBe(31);
	});

	it("the live pane records zero mutations until the swap, then exactly one childList record", async () => {
		await ex.render();
		const toolbar = h.panel().querySelector(".atlas-toolbar");
		const body = h.scrollBody();
		const bucket = h.panel().querySelector(".atlas-bucket");
		const inbox = h.panel().querySelector(".atlas-inbox");
		const html = h.panel().innerHTML;

		const bucketStall = stallRender(ex.renderSeq + 1, "bucket");
		const watcher = watch(h.panel());
		h.setUnits(fileUnits(31));
		const rendering = ex.render();
		await tick();
		expect(watcher.records()).toHaveLength(0); // staged, bucket still awaiting
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(1);

		bucketStall.release();
		await tick();
		expect(watcher.records()).toHaveLength(0); // inbox built in staging too

		await rendering;
		const records = watcher.stop();
		// The nodes were intact right up to the swap.
		expect(toolbar?.isConnected).toBe(false);
		expect(body.isConnected).toBe(false);
		expect(bucket?.isConnected).toBe(false);
		expect(inbox?.isConnected).toBe(false);
		expect(html).not.toBe(h.panel().innerHTML);
		// One batch: the pane's children replaced in one record; nothing else touched on the live pane.
		expect(records.filter((r) => r.target === h.panel() && r.type === "childList")).toHaveLength(1);
		expect(records.filter((r) => r.target !== h.panel())).toHaveLength(0);
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
	});

	// A class or style write that changes nothing still records an attribute mutation in a browser, so
	// the sticky layout (run for real here, not stubbed) must not write after the swap when the staged
	// pane already carries the right values. The write is counted at the DOM calls the layout makes.
	describe("the sticky layout adds no write of its own on the swapped-in pane", () => {
		function countStickyWrites(): { classWritesOnLive: () => number; labelWrites: () => number } {
			const onLive: boolean[] = [];
			const toggle = (HTMLElement.prototype as unknown as { toggleClass: (cls: string, on: boolean) => void }).toggleClass;
			vi.spyOn(HTMLElement.prototype as unknown as { toggleClass: (cls: string, on: boolean) => void }, "toggleClass").mockImplementation(function (this: HTMLElement, cls: string, on: boolean) {
				if (cls === "atlas-sticky-disabled") onLive.push(h.panel().contains(this));
				toggle.call(this, cls, on);
			});
			const labelWrite = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
			return {
				classWritesOnLive: () => onLive.filter(Boolean).length,
				labelWrites: () => labelWrite.mock.calls.filter((c) => c[0] === "--atlas-bucket-label-h").length,
			};
		}

		// `makeHarness` does not stub `updateStickyLayout`: it runs for real, against the stubbed layout reads.
		it("a panel that fits writes the label height once (while staged) and never touches the class", async () => {
			await ex.render();
			const writes = countStickyWrites();
			h.setUnits(fileUnits(31));
			await ex.render();

			expect(ex.lastRenderPainted).toBe(true);
			expect(h.scrollBody().classList.contains("atlas-sticky-disabled")).toBe(false);
			expect(writes.classWritesOnLive()).toBe(0);
			// One write, on the staged body (the new body starts without the variable). The old code wrote
			// it a second time on the same body after the swap.
			expect(writes.labelWrites()).toBe(1);
		});

		it("a panel too short for both headers is flagged while staged and not written again after the swap", async () => {
			h.layout.viewportHeight = 10; // less than a row
			await ex.render();
			expect(h.scrollBody().classList.contains("atlas-sticky-disabled")).toBe(true);
			const writes = countStickyWrites();
			h.setUnits(fileUnits(31));
			const watcher = watch(h.panel());
			await ex.render();
			const records = watcher.stop();

			expect(ex.lastRenderPainted).toBe(true);
			expect(h.scrollBody().classList.contains("atlas-sticky-disabled")).toBe(true); // carried in by the swap
			expect(writes.classWritesOnLive()).toBe(0);
			expect(records.filter((r) => r.target !== h.panel())).toHaveLength(0);
		});
	});

	it("while the inbox is awaiting real I/O the live nodes are untouched and the staged pane is not on screen", async () => {
		await ex.render();
		const html = h.panel().innerHTML;
		const nodes = Array.from(h.panel().querySelectorAll("*"));
		const stall = stallRender(ex.renderSeq + 1, "inbox-resolve");
		const watcher = watch(h.panel());

		h.setUnits(fileUnits(31));
		const rendering = ex.render();
		await tick();

		expect(watcher.records()).toHaveLength(0);
		expect(h.panel().innerHTML).toBe(html);
		expect(nodes.every((n) => n.isConnected)).toBe(true);

		stall.release();
		await rendering;
		expect(rowCount()).toBe(31);
	});

	it("the toolbar, bucket and inbox are all in the pane handed to replaceChildren", async () => {
		await ex.render();
		const replace = vi.spyOn(h.panel(), "replaceChildren");
		const stall = stallRender(ex.renderSeq + 1, "inbox-resolve");

		h.setUnits(fileUnits(31));
		const rendering = ex.render();
		await tick();
		stall.release();
		await rendering;

		expect(replace).toHaveBeenCalledTimes(1);
		const nodes = replace.mock.calls[0] as unknown as HTMLElement[];
		expect(nodes[0].classList.contains("atlas-toolbar")).toBe(true);
		const scroll = nodes.find((n) => n.classList.contains("atlas-explorer-scroll"))!;
		expect(scroll.querySelector(":scope > .atlas-bucket > .atlas-section-header")).not.toBeNull();
		expect(scroll.querySelector(":scope > .atlas-inbox > .atlas-section-header")).not.toBeNull();
		expect(scroll.querySelectorAll(".atlas-inbox .atlas-row-virtual").length).toBeGreaterThan(0);
	});

	it("the restores still happen against the swapped-in pane", async () => {
		await ex.render();
		ex.syncRefreshTimers.mockClear();
		ex.updateActiveHighlight.mockClear();
		const before = FakeResizeObserver.instances.length;

		h.setUnits(fileUnits(31));
		await ex.render();

		expect(ex.stickyEls?.body).toBe(h.scrollBody()); // stickyEls
		expect(ex.stickyEls?.body.isConnected).toBe(true);
		const observers = FakeResizeObserver.instances;
		expect(observers.length).toBe(before + 1); // observeInboxLayout
		expect(observers.at(-1)!.observed.has(h.scrollBody())).toBe(true);
		expect(ex.updateActiveHighlight).toHaveBeenCalled();
		expect(ex.syncRefreshTimers).toHaveBeenCalledTimes(1);
		expect(ex.pendingScrollTop).toBeNull();
		expect(ex.sortRefreshUnfinished).toBe(false);
	});

	it("an empty bucket and an empty inbox swap in a valid pane without throwing", async () => {
		await ex.render();
		h.setUnits([]);
		await expect(ex.render()).resolves.toBeUndefined();

		expect(ex.lastRenderPainted).toBe(true);
		expect(h.panel().querySelector(".atlas-toolbar")).not.toBeNull();
		expect(h.panel().querySelector(".atlas-bucket > .atlas-section-header")).not.toBeNull();
		expect(h.panel().querySelector(".atlas-inbox > .atlas-section-header")).not.toBeNull();
		expect(h.inboxRowKeys()).toEqual([]);
	});
});

describe("PR-3 (S4): a build step that throws leaves the live pane as it was", () => {
	beforeEach(() => setup());

	const failures: [string, (message: string) => void][] = [
		[
			"the bucket",
			(message) => {
				ex.renderBucketSection = async () => {
					throw new Error(message);
				};
			},
		],
		[
			"the inbox",
			(message) => {
				ex.resolveRef = async () => {
					throw new Error(message);
				};
			},
		],
		[
			"the toolbar",
			(message) => {
				(h.explorer as unknown as { renderToolbar: () => void }).renderToolbar = () => {
					throw new Error(message);
				};
			},
		],
	];

	it.each(failures)("%s throwing: zero live mutations, no staging pane, pendingScrollTop cleared", async (_name, fail) => {
		await ex.render();
		const html = h.panel().innerHTML;
		const body = h.scrollBody();
		const observer = ex.inboxLayoutObserver;
		const watcher = watch(h.panel());

		fail("boom");
		h.setUnits(fileUnits(31));
		await expect(ex.render()).rejects.toThrow("boom");

		expect(watcher.stop()).toHaveLength(0);
		expect(h.panel().innerHTML).toBe(html);
		expect(h.scrollBody()).toBe(body);
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
		expect(h.host.children).toHaveLength(2);
		expect(ex.pendingScrollTop).toBeNull();
		expect(ex.inboxLayoutObserver).toBe(observer);
		expect(FakeResizeObserver.instances.filter((o) => o.observed.size > 0)).toHaveLength(1);
	});
});

describe("PR-3 (S4): a render still in flight when the view closes swaps nothing", () => {
	beforeEach(() => setup());

	const points: StallPoint[] = ["bucket", "inbox-resolve"];
	it.each(points)("closing while the render awaits the %s", async (point) => {
		await ex.render();
		const html = h.panel().innerHTML;
		const stall = stallRender(ex.renderSeq + 1, point);
		const replace = vi.spyOn(h.panel(), "replaceChildren");

		h.setUnits(fileUnits(31));
		const rendering = ex.render();
		await tick();
		await ex.onClose();
		stall.release();
		await rendering;

		expect(replace).not.toHaveBeenCalled();
		expect(h.panel().innerHTML).toBe(html);
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
		expect(ex.pendingScrollTop).toBeNull();
		// Every ResizeObserver is disconnected: the closed render registered none of its own.
		expect(FakeResizeObserver.instances.filter((o) => o.observed.size > 0)).toHaveLength(0);
		expect(ex.inboxLayoutObserver).toBeNull();
	});
});

describe("PR-3 (E7): a superseded render never swaps its stale pane in", () => {
	beforeEach(() => setup());

	const points: StallPoint[] = ["bucket", "inbox-resolve"];

	it.each(points)("render A stalled at %s, render B runs to the end: only B swaps", async (point) => {
		await ex.render();
		const replace = vi.spyOn(h.panel(), "replaceChildren");
		const seqA = ex.renderSeq + 1;
		const stall = stallRender(seqA, point);

		h.setUnits(fileUnits(31));
		const a = ex.render();
		await tick();
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(1);

		h.setUnits(fileUnits(32));
		const b = ex.render();
		await b;
		expect(rowCount()).toBe(32);
		expect(replace).toHaveBeenCalledTimes(1);

		const observersBefore = FakeResizeObserver.instances.length;
		stall.release();
		await a;

		expect(replace).toHaveBeenCalledTimes(1); // A's swap never happened
		expect(rowCount()).toBe(32); // the newest render's content, not A's snapshot
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
		expect(FakeResizeObserver.instances.length).toBe(observersBefore); // A registered no observer
		expect(FakeResizeObserver.instances.filter((o) => o.observed.size > 0)).toHaveLength(1);
	});

	const orders: [string, StallPoint, StallPoint, number[]][] = [
		["bucket / bucket, released oldest first", "bucket", "bucket", [0, 1]],
		["bucket / bucket, released newest first", "bucket", "bucket", [1, 0]],
		["resolve / resolve, released oldest first", "inbox-resolve", "inbox-resolve", [0, 1]],
		["resolve / resolve, released newest first", "inbox-resolve", "inbox-resolve", [1, 0]],
		["bucket / resolve, released oldest first", "bucket", "inbox-resolve", [0, 1]],
		["bucket / resolve, released newest first", "bucket", "inbox-resolve", [1, 0]],
	];
	it.each(orders)("three overlapping renders, A and B stalled (%s): one swap with C's content", async (_name, pointA, pointB, order) => {
		await ex.render();
		const replace = vi.spyOn(h.panel(), "replaceChildren");
		const base = ex.renderSeq;
		const stalls = [stallRender(base + 1, pointA), stallRender(base + 2, pointB)];

		h.setUnits(fileUnits(31));
		const a = ex.render();
		await tick();
		h.setUnits(fileUnits(32));
		const b = ex.render();
		await tick();
		h.setUnits(fileUnits(33));
		const c = ex.render(); // runs to the end while A and B wait
		await c;
		expect(replace).toHaveBeenCalledTimes(1);

		for (const i of order) {
			stalls[i].release();
			await tick();
		}
		await Promise.all([a, b]);

		expect(replace).toHaveBeenCalledTimes(1);
		expect(rowCount()).toBe(33);
		expect(h.host.querySelectorAll(".atlas-explorer-staging")).toHaveLength(0);
		expect(FakeResizeObserver.instances.filter((o) => o.observed.size > 0)).toHaveLength(1);
	});

	it("three overlapping renders started together produce one swap, carrying the newest content", async () => {
		await ex.render();
		const replace = vi.spyOn(h.panel(), "replaceChildren");
		h.setUnits(fileUnits(31));
		const a = ex.render();
		h.setUnits(fileUnits(32));
		const b = ex.render();
		h.setUnits(fileUnits(33));
		const c = ex.render();
		await Promise.all([a, b, c]);

		expect(replace).toHaveBeenCalledTimes(1);
		expect(rowCount()).toBe(33);
	});

	it.each(points)("a superseded render's finally (stalled at %s) leaves the newer render's pendingScrollTop and the pending refresh alone", async (point) => {
		await ex.render();
		h.scrollBody().scrollTop = 140;
		const base = ex.renderSeq;
		const stallA = stallRender(base + 1, point);
		const stallB = stallRender(base + 2, "bucket");

		h.setUnits(fileUnits(31));
		const a = ex.render();
		await tick();
		h.setUnits(fileUnits(32));
		const b = ex.render(); // supersedes A; stalls at the bucket
		await tick();
		expect(ex.pendingScrollTop).toBe(140);
		const unfinished = ex.sortRefreshUnfinished;

		stallA.release();
		await a; // A's finally runs while B is still in flight
		expect(ex.pendingScrollTop).toBe(140);
		expect(ex.sortRefreshUnfinished).toBe(unfinished);

		stallB.release();
		await b;
		expect(ex.pendingScrollTop).toBeNull();
		expect(h.scrollBody().scrollTop).toBe(140);
		expect(rowCount()).toBe(32);
	});

	it("a superseded render hands its pending Modified-sort refresh to the render that replaces it", async () => {
		const allowed: boolean[] = [];
		const original = ex.renderBucketSection;
		const gate = deferred();
		let first = true;
		ex.renderBucketSection = async (...args: unknown[]) => {
			allowed.push((ex as unknown as { sortRefreshAllowedForThisRender: boolean }).sortRefreshAllowedForThisRender);
			if (first) {
				first = false;
				await gate.promise;
			}
			return original.apply(h.explorer, args);
		};
		const a = ex.render(); // consumes the view-load refresh, stalls
		await tick();
		h.setUnits(fileUnits(31));
		const b = ex.render();
		gate.release();
		await Promise.all([a, b]);

		expect(allowed).toEqual([true, true]); // B inherited what A had consumed
		expect(ex.sortRefreshUnfinished).toBe(false);
	});
});

describe("PR-3 (E2): the filter keeps focus, caret and text across a swap", () => {
	beforeEach(() => setup(30, true));

	const TEXT = "hello world";
	const cases: [string, boolean, number, number][] = [
		["focused, caret at start", true, 0, 0],
		["focused, caret in the middle", true, 5, 5],
		["focused, caret at the end", true, TEXT.length, TEXT.length],
		["focused, a selection range", true, 2, 8],
		["not focused", false, 3, 3],
	];

	it.each(cases)("%s", async (_name, focused, start, end) => {
		ex.filterText = TEXT;
		await ex.render();
		const oldInput = ex.filterInputEl!;
		expect(oldInput.value).toBe(TEXT);
		oldInput.setSelectionRange(start, end);
		if (focused) oldInput.focus();
		else (document.activeElement as HTMLElement | null)?.blur();

		// Focus in the same task as the swap: the first microtask after the render's synchronous tail
		// already sees the new input focused.
		let focusAtFirstMutationBatch: Element | null = null;
		const observer = new MutationObserver(() => (focusAtFirstMutationBatch ??= document.activeElement));
		observer.observe(h.panel(), { childList: true });

		h.setUnits(fileUnits(31));
		await ex.render();
		observer.disconnect();

		const input = ex.filterInputEl!;
		expect(input).not.toBe(oldInput);
		expect(input.isConnected).toBe(true);
		expect(input.value).toBe(TEXT);
		if (focused) {
			expect(document.activeElement).toBe(input);
			expect(focusAtFirstMutationBatch).toBe(input);
			expect(input.selectionStart).toBe(start);
			expect(input.selectionEnd).toBe(end);
		} else {
			expect(document.activeElement).not.toBe(input);
		}
	});

	it("a keystroke while a render is building, then a real change: no character is dropped", async () => {
		await ex.render();
		const stall = stallRender(ex.renderSeq + 1, "bucket");
		h.setUnits(fileUnits(31));
		const a = ex.render(); // started before the keystroke, staged with an empty filter
		await tick();

		// The input on screen: `filterInputEl` already points into the staged pane while it builds.
		const live = h.panel().querySelector<HTMLInputElement>(".atlas-filter")!;
		live.focus();
		live.value = "ab";
		live.setSelectionRange(2, 2);
		live.dispatchEvent(new Event("input")); // the real listener: sets filterText, queues the newer render
		await tick();
		stall.release();
		await Promise.all([a]);
		await tick();

		const input = ex.filterInputEl!;
		expect(ex.filterText).toBe("ab");
		expect(input.value).toBe("ab");
		expect(input.selectionStart).toBe(2);
		expect(document.activeElement).toBe(input);
	});

	it("a keystroke whose render is held by a press is carried over by the swap that is already building", async () => {
		await ex.render();
		const stall = stallRender(ex.renderSeq + 1, "bucket");
		h.setUnits(fileUnits(31));
		const a = ex.render();
		await tick();

		// The input on screen: `filterInputEl` already points into the staged pane while it builds.
		const live = h.panel().querySelector<HTMLInputElement>(".atlas-filter")!;
		live.focus();
		live.value = "abc";
		live.setSelectionRange(3, 3);
		ex.pointerGestureActive = true; // the keystroke's own render is held, so nothing supersedes `a`
		live.dispatchEvent(new Event("input"));
		stall.release();
		await a;

		const input = ex.filterInputEl!;
		expect(input).not.toBe(live);
		expect(input.value).toBe("abc");
		expect(input.selectionStart).toBe(3);
		expect(document.activeElement).toBe(input);
		ex.pointerGestureActive = false;
	});
});
