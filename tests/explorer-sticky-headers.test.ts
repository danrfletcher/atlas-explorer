import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stuckScrollTarget } from "../src/explorer-view";
import { makeSectionHarness, SectionHarness } from "./explorer-header-fixtures";
import { makeSourcesRig, SourcesRig, fixtureEntries } from "./sources-explorer-fixture";

// PR-1.B1: the JS pinning emulation (`computeStickyHeaders`, `updateStickyHeaders`, the scroll
// listener, the per-header `translateY` transforms and `scroll-padding-top`/`-bottom`) is gone, so
// the two `describe("computeStickyHeaders ...")` blocks and the three `*.style.transform` /
// `*.style.scrollPadding*` assertions from the old version of this file are removed — pinning is now
// a native CSS `position: sticky` rule read from the stylesheet below, not a value this test can
// compute. `stuckScrollTarget` (G5, G7) is unchanged and kept as-is.
//
// Geometry: 28px headers and rows, a 60-row bucket (so the inbox starts at 28 + 60*28 = 1708), a
// 25-row inbox, and a 300px viewport. Content ends at 2436, so the largest scrollTop is 2136.
const HEADER = 28;
const ROW = 28;
const VIEWPORT = 300;
const INBOX_TOP = HEADER + 60 * ROW; // 1708
const MAX_SCROLL = HEADER + 60 * ROW + HEADER + 25 * ROW - VIEWPORT; // 2136

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

describe("rendered headers: no JS transform or scroll-padding (GP2-GP5, E1)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("never sets a transform or scroll-padding on either label at any scroll position", async () => {
		h = makeSectionHarness();
		await h.render();
		for (const top of [0, 1, 1000, 1435, 1436, 1500, 1680, 1681, MAX_SCROLL]) {
			h.scrollTo(top);
			expect(h.bucketHeader().style.transform).toBe("");
			expect(h.inboxHeader().style.transform).toBe("");
			expect(h.body().style.scrollPaddingTop).toBe("");
			expect(h.body().style.scrollPaddingBottom).toBe("");
		}
	});

	it("adds no scroll listener or requestAnimationFrame beyond the inbox virtualisation's own (F5)", async () => {
		const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
		const rafSpy = vi.spyOn(window, "requestAnimationFrame");
		try {
			h = makeSectionHarness();
			await h.render();
			h.scrollTo(1000);
			// The inbox's row-virtualisation redraw keeps its own `scroll` listener (unrelated to sticky
			// headers, see `renderVirtualizedInboxRows`); the sticky-header code adds no listener of its own.
			const scrollListeners = addSpy.mock.calls.filter((call, i) => call[0] === "scroll" && addSpy.mock.contexts[i] === h!.body());
			expect(scrollListeners.length).toBe(1);
			expect(rafSpy).not.toHaveBeenCalled();
		} finally {
			// PR-1.B1 R2: both spies sit on shared prototypes (HTMLElement.prototype, window), not on an
			// instance, so they leak into every later test in the file unless restored here.
			addSpy.mockRestore();
			rafSpy.mockRestore();
		}
	});
});

describe("--atlas-bucket-label-h stays in sync with the bucket header (E5, F2)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("is set to the bucket header's height after render, and follows a header height change on resize", async () => {
		h = makeSectionHarness();
		await h.render();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(`${HEADER}px`);

		h.setHeaderHeight(40);
		h.fireResize();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe("40px");
	});
});

describe("short-panel guard (E2)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	// Fit threshold: bucket header + inbox header + one row = 84px. PR-1.B1 R1: the guard disables
	// sticky only strictly below this (84px itself stays sticky, matching origin/main's pre-existing
	// guard), so the three cases below are 83/84/85px — the boundary itself, one px short of it, and
	// one px past it — not a repeat of the same height twice.
	const minFit = HEADER + HEADER + ROW;

	it.each([
		["83px (one px short of the fit threshold): sticky is disabled", minFit - 1, true],
		["84px (exactly the fit threshold): sticky stays enabled", minFit, false],
		["85px (one px past the fit threshold): sticky stays enabled", minFit + 1, false],
	])("%s", async (_label, viewportHeight, expectDisabled) => {
		h = makeSectionHarness();
		await h.render();
		h.setViewportHeight(viewportHeight);
		h.fireResize();
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(expectDisabled);
	});

	it("re-enables without a reload: one guard toggles both directions on the same instance", async () => {
		h = makeSectionHarness();
		await h.render();

		h.setViewportHeight(minFit - 1);
		h.fireResize();
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(true);

		h.setViewportHeight(minFit);
		h.fireResize();
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(false);
	});
});

describe("structure: labels are siblings of a display:contents wrapper (F2, F3, F4)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("keeps the bucket and inbox headers as the first child of their (display:contents) section", async () => {
		h = makeSectionHarness();
		await h.render();
		expect(h.bucketHeader().parentElement?.classList.contains("atlas-bucket")).toBe(true);
		expect(h.inboxHeader().parentElement?.classList.contains("atlas-inbox")).toBe(true);
		expect(h.bucketHeader().nextElementSibling).toBe(h.bucketWrap());
		expect(h.inboxHeader().nextElementSibling).toBe(h.inboxWrap());
	});
});

describe("empty sections keep the remaining label sticky (E4)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("an empty bucket still renders the inbox header directly under the bucket header's slot", async () => {
		h = makeSectionHarness({ bucketRows: 0 });
		await h.render();
		expect(h.bucketHeader()).toBeTruthy();
		expect(h.inboxHeader()).toBeTruthy();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(`${HEADER}px`);
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(false);
	});

	it("an empty inbox still renders the bucket header, with no overlap or crash", async () => {
		h = makeSectionHarness({ inboxRows: 0 });
		await h.render();
		expect(h.bucketHeader()).toBeTruthy();
		expect(h.inboxHeader()).toBeTruthy();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(`${HEADER}px`);
	});
});

describe("collapse leaves the sticky state consistent (E3)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("collapsing a section while scrolled keeps --atlas-bucket-label-h and the disabled class stable", async () => {
		h = makeSectionHarness();
		await h.render();
		h.scrollTo(1000);
		const before = h.body().style.getPropertyValue("--atlas-bucket-label-h");
		const disabledBefore = h.body().classList.contains("atlas-sticky-disabled");

		h.bucketChevron().click();

		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(before);
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(disabledBefore);
	});

	// PR-1.B1 R4: the bucket case above exercises the chevron handler that fires
	// `updateStickyLayout()` on collapse; the inbox chevron runs the same handler and was untested.
	it("collapsing the inbox while scrolled keeps --atlas-bucket-label-h and the disabled class stable", async () => {
		h = makeSectionHarness();
		await h.render();
		h.scrollTo(1000);
		const before = h.body().style.getPropertyValue("--atlas-bucket-label-h");
		const disabledBefore = h.body().classList.contains("atlas-sticky-disabled");

		h.inboxChevron().click();

		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(before);
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(disabledBefore);
	});
});

describe("stylesheet: .atlas-section-header is a native sticky rule (F1, F2, F3, E6)", () => {
	const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g), (m) => ({ selectors: m[1].trim(), body: m[2] }));

	it(".atlas-section is display: contents, so a sticky header's containing block is the scroll body", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-section");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/display\s*:\s*contents/);
	});

	it(".atlas-section-header is position: sticky with an opaque background, and no leftover position: relative", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/position\s*:\s*sticky/);
		expect(rule!.body).toMatch(/background\s*:\s*var\(--background-primary\)/);
		expect(rule!.body).not.toMatch(/position\s*:\s*relative/);
	});

	it("the bucket label pins to the top", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-bucket > .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/top\s*:\s*0/);
	});

	it("the inbox label sets both top (stacked under the bucket) and bottom (pinned while below the fold)", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-inbox > .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/top\s*:\s*var\(--atlas-bucket-label-h/);
		expect(rule!.body).toMatch(/bottom\s*:\s*0/);
	});

	it("the short-panel guard class takes both labels out of position: sticky", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-explorer-scroll.atlas-sticky-disabled .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/position\s*:\s*static/);
	});

	// PR-1.B1 R3: diffs the live rule against the declarations it had on origin/main immediately
	// before PR-1.B1 (commit d8aec47) changed it, instead of re-asserting a handful of hard-coded
	// values that would pass trivially even if an unrelated property were added. Property-set
	// equality (not just value matches for the properties we expect) catches that case, and the
	// explicit margin/height checks cover the two properties the old version of this test didn't.
	it("only `position` changed on .atlas-section-header versus origin/main before PR-1.B1; no margin or height was added", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-section-header")!;
		const preStickyBody = `
			position: relative;
			z-index: 1;
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 4px 8px;
			background: var(--background-primary);
			font-weight: 600;
			color: var(--text-muted);
			text-transform: uppercase;
			font-size: var(--font-ui-smaller);
		`;
		const parseDecls = (body: string) =>
			new Map(Array.from(body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g), (m) => [m[1].trim(), m[2].trim()]));
		const before = parseDecls(preStickyBody);
		const after = parseDecls(rule.body);

		expect(Array.from(after.keys()).sort()).toEqual(Array.from(before.keys()).sort());
		for (const [prop, beforeValue] of before) {
			expect(after.get(prop)).toBe(prop === "position" ? "sticky" : beforeValue);
		}
		expect(after.has("margin")).toBe(false);
		expect(after.has("height")).toBe(false);
	});
});

// PR-4 (G1, E12): N Tephra source headers. The real explorer over a vault and three sources big enough to scroll
// (the sources-vault fixture's layout, each source with 20 more files), through the real connection. jsdom has no
// layout, so the section harness lays the sections out from the DOM (header 28 px, 28 px rows, a 300 px viewport)
// and the expected numbers below are worked out from that DOM here, not by the code under test.
describe("N source headers stack and stick in order, and a title click lands each on stuckScrollTarget (G1, E12)", () => {
	let rig: SourcesRig | null = null;
	afterEach(async () => {
		await rig?.teardown();
		rig = null;
	});

	const SOURCES = ["alpha", "tephra", "whoop"];
	const vaultPaths = [
		...Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, "0")}.md`),
		...SOURCES.flatMap((name) => Array.from({ length: 20 }, (_, i) => `Sources/${name}/file-${String(i).padStart(2, "0")}.md`)),
	];
	const open = async () => {
		const made = await makeSourcesRig({
			vaultPaths,
			sources: SOURCES.map((name) => ({ name, path: `/${name}`, status: "online" as const })),
			units: Object.fromEntries(SOURCES.map((name) => [name, fixtureEntries(name, vaultPaths)])),
		});
		made.h.setViewportHeight(VIEWPORT);
		await made.h.render();
		await made.settle();
		return made;
	};
	const sections = (r: SourcesRig) => [...r.h.panel().querySelectorAll<HTMLElement>(".atlas-explorer-scroll > .atlas-section")];
	/** Where each section's header sits in the content (the heights of everything before it), from the DOM. */
	const expectedTops = (r: SourcesRig) => {
		let top = 0;
		const tops = sections(r).map((section) => {
			const here = top;
			const content = section.querySelector(":scope > .atlas-meta-children")!.classList.contains("is-collapsed")
				? 0
				: section.classList.contains("atlas-bucket")
				? section.querySelectorAll(".atlas-row").length * ROW
				: parseFloat(section.querySelector<HTMLElement>(".atlas-inbox-spacer")!.style.height);
			top += HEADER + content;
			return here;
		});
		return { tops, max: top - VIEWPORT };
	};

	it("lays out bucket, Inbox and the three sources in order, each header stacked under the ones above and pinned above the ones below", async () => {
		rig = await open();
		const all = sections(rig);
		expect(all.map((el) => el.querySelector(".atlas-section-title")!.textContent)).toEqual(["Bucket", "Inbox", "[alpha]", "[tephra]", "[whoop]"]);
		const sourceSections = all.slice(2);
		expect(sourceSections.map((el) => el.style.getPropertyValue("--atlas-section-top"))).toEqual(["56px", "84px", "112px"]);
		expect(sourceSections.map((el) => el.style.getPropertyValue("--atlas-section-bottom"))).toEqual(["56px", "28px", "0px"]);
		expect(all[1].style.getPropertyValue("--atlas-section-bottom")).toBe("84px");
		expect(rig.h.body().classList.contains("atlas-sticky-disabled")).toBe(false);
	});

	it("each source header is a sticky rule fed by those variables, in the stylesheet", () => {
		const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		const rule = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g)).find((m) => m[1].trim() === ".atlas-inbox.atlas-inbox-source > .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule![2]).toMatch(/top\s*:\s*var\(--atlas-section-top/);
		expect(rule![2]).toMatch(/bottom\s*:\s*var\(--atlas-section-bottom/);
	});

	it("a title click on each header, in turn, scrolls to that header's stuckScrollTarget with every header before it stacked above", async () => {
		rig = await open();
		const all = sections(rig);
		const { tops, max } = expectedTops(rig);
		const wanted = all.map((_, i) => stuckScrollTarget(tops[i], HEADER * i, max));
		// The Inbox header already sits directly under the bucket's at the top (target 0); each source header's target
		// is further down than the one before, and none is clamped to the end.
		expect(wanted[1]).toBe(0);
		expect(wanted.slice(2).every((top) => top > 0 && top < max)).toBe(true);
		expect(wanted.slice(2)).toEqual([...wanted.slice(2)].sort((a, b) => a - b));
		expect(new Set(wanted.slice(2)).size).toBe(3);

		for (let i = 1; i < all.length; i++) {
			rig.h.scrollTo(wanted[i] === 0 ? 500 : 0); // away from the target, so the click has a scroll to make
			rig.h.scrollCalls.length = 0;
			all[i].querySelector<HTMLElement>(".atlas-section-title")!.click();
			expect(rig.h.scrollCalls.map((call) => call.top), `header ${i}`).toEqual([wanted[i]]);
			expect(rig.h.body().scrollTop, `header ${i}`).toBe(wanted[i]);
			// Stuck: this header sits directly under the i headers before it, and each of those is stacked at the top.
			expect(all[i].querySelector<HTMLElement>(":scope > .atlas-section-header")!.getBoundingClientRect().top, `header ${i}`).toBe(HEADER * i);
		}
	});

	it("the same holds after a collapse and a Tephra-driven re-render: the targets follow the new heights", async () => {
		rig = await open();
		sections(rig)[2].querySelector<HTMLElement>(":scope > .atlas-section-header > .atlas-chevron")!.click(); // collapse [alpha]
		await rig.settle();
		await rig.check();
		const { tops, max } = expectedTops(rig);
		const all = sections(rig);
		expect(tops[3] - tops[2]).toBe(HEADER); // a collapsed section is its header alone
		rig.h.scrollTo(0);
		rig.h.scrollCalls.length = 0;
		all[4].querySelector<HTMLElement>(".atlas-section-title")!.click(); // [whoop]
		expect(rig.h.scrollCalls.map((call) => call.top)).toEqual([stuckScrollTarget(tops[4], HEADER * 4, max)]);
	});
});
