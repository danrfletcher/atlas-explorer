import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSectionHarness, SectionHarness } from "./explorer-header-fixtures";

// PR-1.F1: header click behaviour on the rendered panel. Geometry as in explorer-sticky-headers.test.ts:
// bucket 60 rows (inbox at 1708), inbox 25 rows, 300px viewport, max scroll 2136.
// Must match COLLAPSE_TRANSITION_MS in src/explorer-view.ts (the title waits this long after expanding).
const WAIT = 160;
const INBOX_TOP = 28 + 60 * 28;
const INBOX_TARGET = INBOX_TOP - 28; // inbox header directly under the stacked bucket header
const MAX_SCROLL = 2136;

let h: SectionHarness;

beforeEach(async () => {
	vi.useFakeTimers();
	h = makeSectionHarness();
	await h.render();
});

afterEach(() => {
	h.teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const isCollapsed = (wrap: HTMLElement) => wrap.classList.contains("is-collapsed");

describe("chevron (G6, G7)", () => {
	it("collapses only its own section and never scrolls when at the top", () => {
		h.bucketChevron().click();
		expect(isCollapsed(h.bucketWrap())).toBe(true);
		expect(isCollapsed(h.inboxWrap())).toBe(false);
		expect(h.scrollCalls).toEqual([]);
	});

	it("expanding does not scroll", () => {
		h.bucketChevron().click();
		h.bucketChevron().click();
		expect(isCollapsed(h.bucketWrap())).toBe(false);
		expect(h.scrollCalls).toEqual([]);
	});

	it("collapsing the inbox at the top leaves the panel where it is (no scroll down)", () => {
		h.inboxChevron().click();
		expect(isCollapsed(h.inboxWrap())).toBe(true);
		expect(h.scrollCalls).toEqual([]);
	});

	it("collapsing the bucket while deep settles smoothly with the bucket at the top and the inbox right under it (G7, E5)", () => {
		h.scrollTo(1500);
		h.scrollCalls.length = 0;
		h.bucketChevron().click();
		// Collapsed content is 28 + 700 rows tall, so the settle target is the top of the body.
		expect(h.scrollCalls).toEqual([{ top: 0, behavior: "smooth" }]);
		expect(h.body().scrollTop).toBe(0);
		expect(h.inboxHeader().style.transform).toBe("");
	});

	it("a chevron collapse never lands mid-inbox: the scroll is capped at the collapsed content's maximum", () => {
		h.scrollTo(1800);
		h.scrollCalls.length = 0;
		h.bucketChevron().click();
		expect(h.body().scrollTop).toBeLessThanOrEqual(0 + 1);
		expect(h.scrollCalls.every((c) => c.top <= 0)).toBe(true);
	});
});

describe("title (G5)", () => {
	it("title click on an open section scrolls to the stuck target and does not collapse it", () => {
		h.scrollTo(1000);
		h.scrollCalls.length = 0;
		h.inboxTitle().click();
		expect(h.scrollCalls).toEqual([{ top: INBOX_TARGET, behavior: "smooth" }]);
		expect(isCollapsed(h.inboxWrap())).toBe(false);
	});

	it("bucket title click scrolls back to the top and does not collapse the bucket", () => {
		h.scrollTo(1800);
		h.scrollCalls.length = 0;
		h.bucketTitle().click();
		expect(h.scrollCalls).toEqual([{ top: 0, behavior: "smooth" }]);
		expect(isCollapsed(h.bucketWrap())).toBe(false);
	});

	it("is a no-op when the panel is already at the target", () => {
		h.bucketTitle().click();
		h.inboxTitle().click();
		h.scrollTo(INBOX_TARGET);
		h.scrollCalls.length = 0;
		h.inboxTitle().click();
		expect(h.scrollCalls).toEqual([]);
	});

	it("the inbox target clamps to the scrollable range", () => {
		h.inboxTitle().click();
		expect(h.scrollCalls).toEqual([{ top: Math.min(INBOX_TARGET, MAX_SCROLL), behavior: "smooth" }]);
	});

	it("a collapsed title expands first, then scrolls to the post-expansion target (GP7)", () => {
		h.scrollTo(1000);
		h.bucketChevron().click(); // collapses the bucket, settling the panel at the top
		h.scrollTo(300); // the collapsed panel is shorter, so this is inside its range
		h.scrollCalls.length = 0;

		h.bucketTitle().click();
		expect(isCollapsed(h.bucketWrap())).toBe(false);
		expect(h.scrollCalls).toEqual([]); // not yet: the expansion has to play first
		vi.advanceTimersByTime(WAIT);
		expect(h.scrollCalls).toEqual([{ top: 0, behavior: "smooth" }]);
	});

	it("a collapsed title already at its target expands without scrolling", () => {
		h.bucketChevron().click(); // at the top, so no scroll
		h.bucketTitle().click();
		vi.advanceTimersByTime(WAIT);
		expect(isCollapsed(h.bucketWrap())).toBe(false);
		expect(h.scrollCalls).toEqual([]);
	});

	it("a second title click supersedes the first: no stale scroll finishes after it (E4)", () => {
		h.scrollTo(300);
		h.bucketChevron().click(); // collapse
		h.scrollCalls.length = 0;

		h.bucketTitle().click(); // expand, waiting to scroll to the bucket top
		h.inboxTitle().click(); // a newer click takes over before the wait ends
		vi.advanceTimersByTime(WAIT * 2);

		const tops = h.scrollCalls.map((c) => c.top);
		expect(tops).not.toContain(0); // the bucket's stale target never ran
		expect(h.scrollCalls.at(-1)).toEqual({ top: Math.min(INBOX_TARGET, MAX_SCROLL), behavior: "smooth" });
	});

	it("rapid chevron then title clicks end expanded, scrolled, with no double toggle", () => {
		h.scrollTo(300);
		h.bucketChevron().click();
		h.bucketTitle().click();
		h.bucketTitle().click();
		vi.advanceTimersByTime(WAIT * 2);
		expect(isCollapsed(h.bucketWrap())).toBe(false);
		expect(h.body().scrollTop).toBe(0);
	});
});

describe("header controls (G10)", () => {
	it("the mode toggle, the + button and the title's right-click menu do not scroll or collapse", () => {
		h.scrollTo(1000);
		h.scrollCalls.length = 0;
		h.inboxHeader().querySelector<HTMLElement>(".atlas-inbox-mode-btn")!.click();
		h.inboxHeader().querySelector<HTMLElement>(".atlas-inbox-add-btn")!.click();
		h.inboxTitle().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		vi.advanceTimersByTime(WAIT * 2);
		expect(h.scrollCalls).toEqual([]);
		expect(isCollapsed(h.inboxWrap())).toBe(false);
	});

	it("a click on the header's empty area does nothing", () => {
		h.scrollTo(1000);
		h.scrollCalls.length = 0;
		h.inboxHeader().click();
		h.bucketHeader().click();
		expect(h.scrollCalls).toEqual([]);
		expect(isCollapsed(h.bucketWrap())).toBe(false);
		expect(isCollapsed(h.inboxWrap())).toBe(false);
	});
});

describe("reduced motion (E10)", () => {
	beforeEach(() => {
		(window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(
			() => ({ matches: true }) as MediaQueryList,
		);
	});

	it("title clicks scroll with behavior 'auto'", () => {
		h.scrollTo(1000);
		h.scrollCalls.length = 0;
		h.inboxTitle().click();
		expect(h.scrollCalls).toEqual([{ top: INBOX_TARGET, behavior: "auto" }]);
	});

	it("the collapse animation is skipped", () => {
		h.bucketChevron().click();
		expect(h.bucketWrap().classList.contains("is-instant")).toBe(true);
	});

	it("a collapsed title expands and scrolls immediately, with no wait", () => {
		h.bucketChevron().click();
		h.scrollTo(300); // away from the top of the collapsed panel, so there is somewhere to scroll
		h.scrollCalls.length = 0;
		h.bucketTitle().click();
		expect(isCollapsed(h.bucketWrap())).toBe(false);
		expect(h.scrollCalls).toEqual([{ top: 0, behavior: "auto" }]);
	});

	it("the collapse settle is instant too", () => {
		h.scrollTo(1500);
		h.scrollCalls.length = 0;
		h.bucketChevron().click();
		expect(h.scrollCalls).toEqual([{ top: 0, behavior: "auto" }]);
	});
});
