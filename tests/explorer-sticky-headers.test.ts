import { afterEach, describe, expect, it } from "vitest";
import { computeStickyHeaders, stuckScrollTarget, StickyHeaderInput } from "../src/explorer-view";
import { makeSectionHarness, SectionHarness } from "./explorer-header-fixtures";

// PR-1.F1: the stacking function at the spec's grid cells (G3, G4) and short-panel boundaries (E2).
// Geometry: 28px headers and rows, a 60-row bucket (so the inbox starts at 28 + 60*28 = 1708), a
// 25-row inbox, and a 300px viewport. Content ends at 2436, so the largest scrollTop is 2136.
const HEADER = 28;
const ROW = 28;
const VIEWPORT = 300;
const INBOX_TOP = HEADER + 60 * ROW; // 1708
const MAX_SCROLL = HEADER + 60 * ROW + HEADER + 25 * ROW - VIEWPORT; // 2136

const base: StickyHeaderInput = {
	scrollTop: 0,
	viewportHeight: VIEWPORT,
	bucketTop: 0,
	bucketHeaderHeight: HEADER,
	inboxTop: INBOX_TOP,
	inboxHeaderHeight: HEADER,
};

describe("computeStickyHeaders (G3, G4)", () => {
	it.each([
		// [label, scrollTop, inboxPosition, inboxY, bucketY]
		["top of panel: inbox pinned to the bottom edge", 0, "pinned", VIEWPORT - HEADER, 0],
		["bucket rows scrolling under the bucket header", 1000, "pinned", 1000 + VIEWPORT - HEADER, 1000],
		["last scrollTop with the inbox still pinned", 1435, "pinned", 1435 + VIEWPORT - HEADER, 1435],
		["inbox reaches the bottom edge: flows in place", 1436, "flow", INBOX_TOP, 1436],
		["inbox scrolled up into the view, still below the bucket header", 1500, "flow", INBOX_TOP, 1500],
		["inbox meets the bucket header: still flow", 1680, "flow", INBOX_TOP, 1680],
		["inbox passes under the bucket header: stacked", 1681, "stacked", 1681 + HEADER, 1681],
		["max scroll: inbox stays stacked through the end of the inbox", MAX_SCROLL, "stacked", MAX_SCROLL + HEADER, MAX_SCROLL],
	])("%s", (_label, scrollTop, position, inboxY, bucketY) => {
		const layout = computeStickyHeaders({ ...base, scrollTop });
		expect(layout.stuck).toBe(true);
		expect(layout.inboxPosition).toBe(position);
		expect(layout.bucketY).toBe(bucketY);
		expect(layout.inboxY).toBe(inboxY);
	});

	it("an empty bucket puts the inbox header directly under the bucket header", () => {
		const layout = computeStickyHeaders({ ...base, inboxTop: HEADER });
		expect(layout.inboxPosition).toBe("flow");
		expect(layout.inboxY).toBe(HEADER);
	});
});

describe("computeStickyHeaders (E2 short panel)", () => {
	const minFit = HEADER + HEADER + ROW; // bucket header + inbox header + one row = 84

	it("exactly fits: headers stick, the inbox is pinned", () => {
		const layout = computeStickyHeaders({ ...base, viewportHeight: minFit, scrollTop: 0 });
		expect(layout.stuck).toBe(true);
		expect(layout.inboxPosition).toBe("pinned");
		expect(layout.inboxY).toBe(minFit - HEADER);
	});

	it("one px short: both headers unstick together, bucket included, at any scroll", () => {
		const layout = computeStickyHeaders({ ...base, viewportHeight: minFit - 1, scrollTop: 1000 });
		expect(layout.stuck).toBe(false);
		expect(layout.inboxPosition).toBe("flow");
		expect(layout.bucketY).toBe(0);
		expect(layout.inboxY).toBe(INBOX_TOP);
	});

	it("re-sticks as soon as the panel is tall enough again", () => {
		const short = computeStickyHeaders({ ...base, viewportHeight: minFit - 1, scrollTop: 1000 });
		const tall = computeStickyHeaders({ ...base, viewportHeight: minFit, scrollTop: 1000 });
		expect(short.stuck).toBe(false);
		expect(tall.stuck).toBe(true);
		expect(tall.bucketY).toBe(1000);
	});
});

describe("stuckScrollTarget (G5, G7)", () => {
	it.each([
		// [label, headerTop, stackOffset, maxScrollTop, expected]
		["bucket at the top of the body", 0, 0, MAX_SCROLL, 0],
		["inbox header lands directly under the stacked bucket header", INBOX_TOP, HEADER, MAX_SCROLL, INBOX_TOP - HEADER],
		["target past the end is clamped to the maximum scroll", 2400, HEADER, MAX_SCROLL, MAX_SCROLL],
		["header above the top never yields a negative scroll", 10, HEADER, MAX_SCROLL, 0],
		["content shorter than the view scrolls nowhere", INBOX_TOP, HEADER, -50, 0],
	])("%s", (_label, headerTop, stackOffset, maxScrollTop, expected) => {
		expect(stuckScrollTarget(headerTop, stackOffset, maxScrollTop)).toBe(expected);
	});
});

describe("rendered headers follow the same rules (G3, E2)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("pins the inbox and stacks the bucket, then unsticks both on a short panel and re-sticks on resize", async () => {
		h = makeSectionHarness();
		await h.render();
		h.scrollTo(1000);
		expect(h.bucketHeader().style.transform).toBe("translateY(1000px)");
		expect(h.inboxHeader().style.transform).toBe(`translateY(${1000 + VIEWPORT - HEADER - INBOX_TOP}px)`);
		// PR-1.F1 R2: scrollTop 1000 is the "pinned" state (see the table above) — only the bucket
		// header is stuck over the top of the content, so the top padding is its height alone; the
		// pinned inbox header instead covers content at the bottom edge, so that's a bottom padding.
		expect(h.body().style.scrollPaddingTop).toBe(`${HEADER}px`);
		expect(h.body().style.scrollPaddingBottom).toBe(`${HEADER}px`);

		h.setViewportHeight(ROW + HEADER + HEADER - 1);
		h.fireResize();
		expect(h.bucketHeader().style.transform).toBe("");
		expect(h.inboxHeader().style.transform).toBe("");
		expect(h.body().style.scrollPaddingTop).toBe("0px");
		expect(h.body().style.scrollPaddingBottom).toBe("0px");

		h.setViewportHeight(ROW + HEADER + HEADER);
		h.fireResize();
		expect(h.bucketHeader().style.transform).toBe("translateY(1000px)");
	});

	it("stacks both header heights into the top padding only once the inbox header is itself stacked under the bucket header", async () => {
		h = makeSectionHarness();
		await h.render();
		// 1681 is "inbox passes under the bucket header: stacked" in the table above.
		h.scrollTo(1681);
		expect(h.body().style.scrollPaddingTop).toBe(`${HEADER + HEADER}px`);
		expect(h.body().style.scrollPaddingBottom).toBe("0px");
	});

	it("updates scroll-padding-top when a header's height changes, without a reload", async () => {
		h = makeSectionHarness();
		await h.render();
		h.scrollTo(1000);
		expect(h.body().style.scrollPaddingTop).toBe("28px");

		h.setHeaderHeight(40);
		h.fireResize();
		expect(h.body().style.scrollPaddingTop).toBe("40px");
	});
});
