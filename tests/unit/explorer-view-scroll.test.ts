import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { FakeResizeObserver, fileUnits, keyAt, makeHarness, otherView, stubLayout } from "./explorer-view-scroll-helpers";

/** PR-1.S1: the explorer's single scroll body, the inbox virtual window against it, and the
 * redraw/restore rules. Layout is stubbed (jsdom has none); see `explorer-view-scroll-helpers.ts`. */

const ROW = 28;
const OVER = 8;

let restoreLayout: (() => void) | null = null;
let cleanups: (() => void)[] = [];

afterEach(() => {
	for (const fn of cleanups) fn();
	cleanups = [];
	document.body.replaceChildren();
	restoreLayout?.();
	restoreLayout = null;
	vi.restoreAllMocks();
});

function setup(units = fileUnits(2000), layout = { viewportHeight: 280, bucketHeight: 0 }) {
	restoreLayout = stubLayout(layout);
	return makeHarness(units, layout);
}

async function render(explorer: AtlasExplorerView): Promise<void> {
	await (explorer as unknown as { render: () => Promise<void> }).render();
}

function scrollTo(h: ReturnType<typeof makeHarness>, top: number): void {
	h.scrollBody().scrollTop = top;
	h.scrollBody().dispatchEvent(new Event("scroll"));
}

describe("PR-1.S1 — DOM split: fixed toolbar and one scroll body", () => {
	it("puts the toolbar beside the scroll body, never inside it", async () => {
		const h = setup();
		await render(h.explorer);

		const [first, second] = Array.from(h.panel().children);
		expect(first.classList.contains("atlas-toolbar")).toBe(true);
		expect(second.classList.contains("atlas-explorer-scroll")).toBe(true);
		expect(h.scrollBody().querySelector(".atlas-toolbar")).toBeNull();
	});

	it("holds the bucket and the inbox in the scroll body, with no inner inbox viewport", async () => {
		const h = setup();
		await render(h.explorer);

		expect(h.scrollBody().querySelector(".atlas-section.atlas-bucket")).not.toBeNull();
		expect(h.scrollBody().querySelector(".atlas-section.atlas-inbox")).not.toBeNull();
		expect(h.panel().querySelector(".atlas-inbox-viewport")).toBeNull();
	});
});

describe("PR-1.S1 — G1/F8: both sections open on every load, nothing persisted", () => {
	it("starts with the bucket and the inbox both expanded", () => {
		const h = setup();
		const fields = h.explorer as unknown as { bucketCollapsed: boolean; inboxCollapsed: boolean };
		expect(fields.bucketCollapsed).toBe(false);
		expect(fields.inboxCollapsed).toBe(false);
	});
});

describe("PR-1.S1 — G9/E3: restore before the first inbox draw", () => {
	it("draws the window for the restored scrollTop on the first paint", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		await render(h.explorer);

		scrollTo(h, ROW * 500);
		await render(h.explorer);

		const keys = h.inboxRowKeys();
		expect(keys[0]).toBe(keyAt(units, 500 - OVER));
		expect(keys).toContain(keyAt(units, 500));
		expect(keys).not.toContain(keyAt(units, 0));
		expect(h.scrollBody().scrollTop).toBe(ROW * 500);
	});

	it("keeps scrollTop stable across three rapid re-renders", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		await render(h.explorer);
		scrollTo(h, 1400);

		const first = h.inboxRowKeys();
		for (let i = 0; i < 3; i++) {
			await render(h.explorer);
			expect(h.scrollBody().scrollTop).toBe(1400);
		}
		expect(h.inboxRowKeys()).toEqual(first);
	});

	it("keeps scrollTop when renders overlap (started while an earlier one is still awaiting)", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		await render(h.explorer);
		scrollTo(h, 1400);

		// Each render empties the container and builds a fresh body before its first await, so the
		// later renders must take the target from the in-flight render, not from the new body's 0.
		await Promise.all([render(h.explorer), render(h.explorer), render(h.explorer)]);

		expect(h.scrollBody().scrollTop).toBe(1400);
		expect(h.inboxRowKeys()).toContain(keyAt(units, 1400 / ROW));
		expect(h.inboxRowKeys()).not.toContain(keyAt(units, 0));
	});

	it("redraws the inbox from the newest overlapping render's body, not a superseded one", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		await render(h.explorer);
		scrollTo(h, 1400);

		await Promise.all([render(h.explorer), render(h.explorer)]);
		expect(h.panel().querySelectorAll(".atlas-explorer-scroll")).toHaveLength(1);

		scrollTo(h, ROW * 900);
		expect(h.inboxRowKeys()).toContain(keyAt(units, 900));
		expect(h.inboxRowKeys()).not.toContain(keyAt(units, 1400 / ROW));
	});

	it("restores scrollTop right after the bucket renders, not only once the inbox section runs (R2)", async () => {
		const units = fileUnits(2000);
		// A tall stubbed bucket (bigger than the target scrollTop) so the restore right after the
		// bucket renders isn't itself clamped to 0 for lack of a scrollHeight yet — the inbox spacer
		// that would normally supply the rest of it doesn't exist until the inbox section runs.
		const h = setup(units, { viewportHeight: 280, bucketHeight: 2000 });
		await render(h.explorer);
		scrollTo(h, 1400);
		await render(h.explorer);

		const explorer = h.explorer as unknown as {
			renderInboxSection: (...args: unknown[]) => Promise<void>;
		};
		const realRenderInboxSection = explorer.renderInboxSection.bind(explorer);
		let scrollTopAtInboxStart = -1;
		explorer.renderInboxSection = (...args: unknown[]) => {
			scrollTopAtInboxStart = h.scrollBody().scrollTop;
			return realRenderInboxSection(...args);
		};

		await render(h.explorer);
		// The bucket section has already resolved by this point, so the restore must have already
		// happened — the inbox section's own resolveRef calls should never see the fresh body at 0.
		expect(scrollTopAtInboxStart).toBe(1400);
	});

	it("clears pendingScrollTop even when a render throws, so a later render restores the live scroll position (R6)", async () => {
		const units = fileUnits(2000);
		// A tall stubbed bucket so a manual scroll right after the failed render (before the inbox
		// section — and its spacer — ever runs again) isn't itself clamped to 0.
		const h = setup(units, { viewportHeight: 280, bucketHeight: 3000 });
		await render(h.explorer);
		scrollTo(h, 1000);
		await render(h.explorer);
		expect(h.scrollBody().scrollTop).toBe(1000);

		const explorer = h.explorer as unknown as {
			renderBucketSection: (...args: unknown[]) => Promise<void>;
		};
		const realRenderBucketSection = explorer.renderBucketSection.bind(explorer);
		explorer.renderBucketSection = async (...args: unknown[]) => {
			await realRenderBucketSection(...args);
			throw new Error("boom");
		};

		await expect(render(h.explorer)).rejects.toThrow("boom");

		// No render is in flight now; the user scrolls to a new position on their own.
		scrollTo(h, 2000);

		explorer.renderBucketSection = realRenderBucketSection;
		await render(h.explorer);
		// A stale pendingScrollTop left over from the throw would override this with the old 1000.
		expect(h.scrollBody().scrollTop).toBe(2000);
	});
});

describe("PR-1.S1 — G2/E9: the inbox redraws on scroll and on offset change", () => {
	it("redraws the window when the body scrolls", async () => {
		const units = fileUnits(2000);
		const h = setup(units, { viewportHeight: 280, bucketHeight: 1120 });
		await render(h.explorer);
		expect(h.inboxRowKeys()[0]).toBe(keyAt(units, 0));

		scrollTo(h, 1120); // inbox top now at the top of the viewport
		expect(h.inboxRowKeys()).toContain(keyAt(units, 17));
		expect(h.inboxRowKeys()).not.toContain(keyAt(units, 40));
	});

	it("redraws when the bucket collapses or grows without any scroll (ResizeObserver)", async () => {
		const units = fileUnits(2000);
		const layout = { viewportHeight: 280, bucketHeight: 1120 };
		const h = setup(units, layout);
		await render(h.explorer);
		scrollTo(h, 1120);
		expect(h.inboxRowKeys()).toContain(keyAt(units, 17));

		// The bucket grows by 280px with nothing scrolled: the inbox moves down under the viewport.
		layout.bucketHeight = 1400;
		const observer = FakeResizeObserver.instances.at(-1)!;
		observer.fire();

		const keys = h.inboxRowKeys();
		expect(keys).toEqual(Array.from({ length: OVER }, (_, i) => keyAt(units, i)));
	});

	it("observes the scroll body, the bucket and the fixed panel parts", async () => {
		const h = setup();
		await render(h.explorer);
		const observer = FakeResizeObserver.instances.at(-1)!;
		expect(observer.observed.has(h.scrollBody())).toBe(true);
		expect(observer.observed.has(h.panel().querySelector(".atlas-section.atlas-bucket") as Element)).toBe(true);
		expect(observer.observed.has(h.panel().querySelector(".atlas-toolbar") as Element)).toBe(true);
	});

	it("draws only the overscan rows while the body has no height (hidden leaf), then fills on the real height", async () => {
		const units = fileUnits(2000);
		const layout = { viewportHeight: 0, bucketHeight: 0 };
		const h = setup(units, layout);
		await render(h.explorer);
		expect(h.inboxRowKeys()).toEqual(Array.from({ length: OVER }, (_, i) => keyAt(units, i)));

		layout.viewportHeight = 280;
		FakeResizeObserver.instances.at(-1)!.fire();
		expect(h.inboxRowKeys()).toHaveLength(Math.ceil(280 / ROW) + OVER);
	});
});

describe("PR-1.S1 — G8/E7: a view switch resets scroll to the top", () => {
	it("sets scrollTop to 0 when the active view changes, but keeps it on a plain re-render", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		await render(h.explorer);
		scrollTo(h, 2800);

		await render(h.explorer);
		expect(h.scrollBody().scrollTop).toBe(2800);

		h.setActiveView(otherView);
		await render(h.explorer);
		expect(h.scrollBody().scrollTop).toBe(0);
		expect(h.inboxRowKeys()[0]).toBe(keyAt(units, 0));
	});
});

describe("PR-1.S1 — E1: only the visible window is in the DOM", () => {
	it("keeps a 5,000-row inbox to the visible window at top, middle and end", async () => {
		const units = fileUnits(5000);
		const bound = Math.ceil(280 / ROW) + OVER * 2 + 1;
		const h = setup(units);
		await render(h.explorer);
		expect(h.inboxRowKeys().length).toBeLessThanOrEqual(bound);

		scrollTo(h, ROW * 2500);
		expect(h.inboxRowKeys().length).toBeLessThanOrEqual(bound);
		expect(h.inboxRowKeys()).toContain(keyAt(units, 2500));

		scrollTo(h, ROW * 5000);
		expect(h.inboxRowKeys().length).toBeLessThanOrEqual(bound);
		expect(h.inboxRowKeys()).toContain(keyAt(units, 4999));
	});
});

describe("PR-1.S1 — edge cases", () => {
	it("empty inbox and empty bucket: no rows, a zero-height spacer, no errors", async () => {
		const h = setup([]);
		await render(h.explorer);
		expect(h.inboxRowKeys()).toEqual([]);
		expect(h.panel().querySelector<HTMLElement>(".atlas-inbox-spacer")!.style.height).toBe("0px");
	});

	it("both sections collapsed: no errors and no NaN window", async () => {
		const h = setup(fileUnits(30));
		const fields = h.explorer as unknown as { bucketCollapsed: boolean; inboxCollapsed: boolean };
		fields.bucketCollapsed = true;
		fields.inboxCollapsed = true;
		await render(h.explorer);
		// Collapse flags only change classes; the window still follows the (top) scroll position.
		expect(h.inboxRowKeys()).toHaveLength(Math.min(30, Math.ceil(280 / ROW) + OVER));
		expect(h.panel().querySelector(".atlas-section.atlas-inbox.is-collapsed")).not.toBeNull();
	});

	it("the inbox shrinks while scrolled past its end: scrollTop clamps and rows redraw", async () => {
		const h = setup(fileUnits(2000));
		await render(h.explorer);
		scrollTo(h, ROW * 1500);

		h.setUnits(fileUnits(20));
		await render(h.explorer);
		expect(h.scrollBody().scrollTop).toBe(20 * ROW - 280);
		const keys = h.inboxRowKeys();
		expect(keys.length).toBeGreaterThan(0);
		expect(keys).toContain(keyAt(fileUnits(20), 19));
	});

	it("onClose disconnects the ResizeObserver and stops any redraw after close", async () => {
		const units = fileUnits(2000);
		const layout = { viewportHeight: 280, bucketHeight: 0 };
		const h = setup(units, layout);
		await render(h.explorer);
		const observer = FakeResizeObserver.instances.at(-1)!;
		const before = h.inboxRowKeys();

		await h.explorer.onClose();
		expect(observer.disconnect).toHaveBeenCalled();

		layout.bucketHeight = 1120;
		observer.fire();
		expect(h.inboxRowKeys()).toEqual(before);
	});
});

describe("PR-1.S1 — G11/E8: a dragged inbox row survives virtual redraws", () => {
	it("keeps the drag source connected through a redraw, and clears drag state on dragend", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const registered: (() => void)[] = [];
		const explorer = h.explorer as unknown as {
			registerEvent: (ref: unknown) => void;
			registerDomEvent: (el: Element | Window, type: string, cb: () => void) => void;
			dragPayload: unknown;
			cancelActiveDwell: (() => void) | null;
			activeDwellRow: HTMLElement | null;
			queueRender: () => void;
			onOpen: () => Promise<void>;
		};
		explorer.registerEvent = vi.fn();
		explorer.registerDomEvent = (el, type, cb) => {
			el.addEventListener(type, cb);
			registered.push(() => el.removeEventListener(type, cb));
		};
		cleanups.push(() => registered.forEach((fn) => fn()));
		await explorer.onOpen();

		const row = h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${keyAt(units, 5)}"]`)!;
		row.dispatchEvent(new Event("dragstart"));
		expect(explorer.dragPayload).not.toBeNull();

		const dwell = vi.fn();
		explorer.cancelActiveDwell = dwell;
		// PR-1.S1 R3: the dwell under test here belongs to another inbox row (one that's about to be
		// swapped out by the redraw below), not the dragged row itself — see the dedicated test further
		// down for a dwell on a bucket row, which a redraw like this one must leave alone.
		explorer.activeDwellRow = h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${keyAt(units, 0)}"]`)!;
		const setCssStyles = vi.spyOn(row, "setCssStyles");
		scrollTo(h, ROW * 1000); // auto-scroll far away from the dragged row
		expect(dwell).toHaveBeenCalled();
		expect(row.isConnected).toBe(true);
		expect(setCssStyles).toHaveBeenLastCalledWith({ display: "none" });
		expect(row.style.display).toBe("none");

		scrollTo(h, 0); // back in view: the same element is reused, not a second copy
		expect(setCssStyles).toHaveBeenLastCalledWith({ display: "" });
		expect(row.style.display).toBe("");
		expect(h.panel().querySelectorAll(`[data-ref-key="${keyAt(units, 5)}"]`)).toHaveLength(1);

		const queueRender = explorer.queueRender as unknown as ReturnType<typeof vi.fn>;
		window.dispatchEvent(new Event("dragend"));
		expect(explorer.dragPayload).toBeNull();
		expect(queueRender).toHaveBeenCalled();

		scrollTo(h, ROW * 1000); // with no drag left, the stale row is removed on redraw
		expect(row.isConnected).toBe(false);
	});

	it("has the dragged row and the bucket in the one scroll body, so native edge auto-scroll moves both", async () => {
		// Edge auto-scroll is the browser's own drag behaviour (not in src/), so it can't run under jsdom.
		// What it needs from us is structural: the body that scrolls is the body the inbox redraws from,
		// and the bucket and the inbox both live inside it, with no inner scroller in between.
		const units = fileUnits(2000);
		const h = setup(units);
		const registered: (() => void)[] = [];
		const explorer = h.explorer as unknown as {
			registerEvent: (ref: unknown) => void;
			registerDomEvent: (el: Element | Window, type: string, cb: () => void) => void;
			dragPayload: unknown;
			onOpen: () => Promise<void>;
		};
		explorer.registerEvent = vi.fn();
		explorer.registerDomEvent = (el, type, cb) => {
			el.addEventListener(type, cb);
			registered.push(() => el.removeEventListener(type, cb));
		};
		cleanups.push(() => registered.forEach((fn) => fn()));
		await explorer.onOpen();

		const body = h.scrollBody();
		expect(body.querySelector(".atlas-section.atlas-bucket")).not.toBeNull();
		const row = body.querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${keyAt(units, 5)}"]`)!;
		expect(row.closest(".atlas-explorer-scroll")).toBe(body);

		row.dispatchEvent(new Event("dragstart"));
		// Native auto-scroll scrolls the body element itself and fires its scroll event.
		scrollTo(h, ROW * 1000);
		scrollTo(h, ROW * 400);
		expect(row.closest(".atlas-explorer-scroll")).toBe(body);
		expect(explorer.dragPayload).not.toBeNull();
		expect(h.inboxRowKeys()).toContain(keyAt(units, 400));
	});

	it("leaves a dwell on a bucket row alone when the inbox window redraws (R3)", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const registered: (() => void)[] = [];
		const explorer = h.explorer as unknown as {
			registerEvent: (ref: unknown) => void;
			registerDomEvent: (el: Element | Window, type: string, cb: () => void) => void;
			cancelActiveDwell: (() => void) | null;
			activeDwellRow: HTMLElement | null;
			onOpen: () => Promise<void>;
		};
		explorer.registerEvent = vi.fn();
		explorer.registerDomEvent = (el, type, cb) => {
			el.addEventListener(type, cb);
			registered.push(() => el.removeEventListener(type, cb));
		};
		cleanups.push(() => registered.forEach((fn) => fn()));
		await explorer.onOpen();

		// A dwell target in the bucket section (stubbed as `.atlas-node-list`), not in the inbox
		// spacer at all, so an inbox window redraw must never cancel it.
		const bucketEl = h.panel().querySelector<HTMLElement>(".atlas-node-list")!;
		const dwell = vi.fn();
		explorer.cancelActiveDwell = dwell;
		explorer.activeDwellRow = bucketEl;

		scrollTo(h, ROW * 1000); // the inbox window changes; the bucket is untouched
		expect(dwell).not.toHaveBeenCalled();
		expect(explorer.activeDwellRow).toBe(bucketEl);
	});

	it("clears dragPayload when a render tears down the dragged row mid-drag (R4 hardening)", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const registered: (() => void)[] = [];
		const explorer = h.explorer as unknown as {
			registerEvent: (ref: unknown) => void;
			registerDomEvent: (el: Element | Window, type: string, cb: () => void) => void;
			dragPayload: unknown;
			onOpen: () => Promise<void>;
		};
		explorer.registerEvent = vi.fn();
		explorer.registerDomEvent = (el, type, cb) => {
			el.addEventListener(type, cb);
			registered.push(() => el.removeEventListener(type, cb));
		};
		cleanups.push(() => registered.forEach((fn) => fn()));
		await explorer.onOpen();

		const row = h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${keyAt(units, 5)}"]`)!;
		row.dispatchEvent(new Event("dragstart"));
		expect(explorer.dragPayload).not.toBeNull();

		// A render while the drag is still active (an index refresh, say) tears the source row out
		// from under the drag; the window `dragend` backstop may never fire for it, so render() must
		// clear the stale drag state itself instead of leaving it to dangle.
		await render(h.explorer);
		expect(explorer.dragPayload).toBeNull();
	});

	it("removes a hidden dragged row immediately on dragend, instead of waiting for the next redraw (R5)", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const registered: (() => void)[] = [];
		const explorer = h.explorer as unknown as {
			registerEvent: (ref: unknown) => void;
			registerDomEvent: (el: Element | Window, type: string, cb: () => void) => void;
			onOpen: () => Promise<void>;
		};
		explorer.registerEvent = vi.fn();
		explorer.registerDomEvent = (el, type, cb) => {
			el.addEventListener(type, cb);
			registered.push(() => el.removeEventListener(type, cb));
		};
		cleanups.push(() => registered.forEach((fn) => fn()));
		await explorer.onOpen();

		const row = h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${keyAt(units, 5)}"]`)!;
		row.dispatchEvent(new Event("dragstart"));
		scrollTo(h, ROW * 1000); // scrolls the dragged row out of the window: hidden, not removed
		expect(row.style.display).toBe("none");
		expect(row.isConnected).toBe(true);

		window.dispatchEvent(new Event("dragend"));
		expect(row.isConnected).toBe(false);
	});
});
