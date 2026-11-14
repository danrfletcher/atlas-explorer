import { afterEach, describe, expect, it } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";

// PR-4 (G1, E12): the stacked header geometry for N Tephra sections, through the real `updateStickyLayout` and
// `sectionStuckTarget` with explicit boxes (jsdom has no layout).
type Proto = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as Proto;

function box(top: number, height: number): HTMLElement {
	const el = document.createElement("div");
	el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
	return el;
}

function build(sourceCount: number, viewport = 600) {
	const body = document.createElement("div");
	Object.defineProperty(body, "clientHeight", { value: viewport });
	Object.defineProperty(body, "scrollHeight", { value: 5000 });
	body.getBoundingClientRect = () => ({ top: 0, height: viewport, bottom: viewport, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
	const inboxSection = document.createElement("div");
	const inboxHeader = box(0, 30);
	inboxSection.appendChild(inboxHeader);
	body.appendChild(inboxSection);
	const sources = Array.from({ length: sourceCount }, (_, i) => {
		const section = document.createElement("div");
		const header = box(0, 20 + i);
		section.appendChild(header);
		body.appendChild(section);
		return { key: `source:s${i}`, section, header, wrap: box(1000 + i * 100, 50) };
	});
	document.body.appendChild(body); // the layout pass skips a detached pane
	const fake = { stickyEls: { body, bucketHeader: box(0, 40), bucketWrap: box(40, 100), inboxHeader, inboxWrap: box(500, 100), sources } };
	return { fake, body, inboxSection, sources };
}

afterEach(() => document.body.replaceChildren());

describe("updateStickyLayout with source sections", () => {
	it("stacks each source header under the ones above and pins it above the ones below", () => {
		const { fake, body, inboxSection, sources } = build(3);
		proto.updateStickyLayout.call(fake);
		// bucket 40 + inbox 30 = 70, then 20, 21, 22 (total 63)
		expect(sources.map((s) => s.section.style.getPropertyValue("--atlas-section-top"))).toEqual(["70px", "90px", "111px"]);
		expect(sources.map((s) => s.section.style.getPropertyValue("--atlas-section-bottom"))).toEqual(["43px", "22px", "0px"]);
		expect(inboxSection.style.getPropertyValue("--atlas-section-bottom")).toBe("63px");
		expect(body.style.getPropertyValue("--atlas-bucket-label-h")).toBe("40px");
		expect(body.classList.contains("atlas-sticky-disabled")).toBe(false);
	});

	it("turns sticky off when the headers alone leave no room for a row", () => {
		const { fake, body } = build(3, 150); // 40 + 30 + 63 = 133, room left 17 < one row
		proto.updateStickyLayout.call(fake);
		expect(body.classList.contains("atlas-sticky-disabled")).toBe(true);
	});

	it("with no source section writes no source variables at all", () => {
		const { fake, inboxSection } = build(0);
		proto.updateStickyLayout.call(fake);
		expect(inboxSection.style.getPropertyValue("--atlas-section-bottom")).toBe("");
	});
});

describe("sectionStuckTarget with source sections", () => {
	it("a source's stuck target leaves every header before it stacked above (clamped to the scroll range)", () => {
		const { fake } = build(3);
		// source 1: wrap top 1100, header 21 -> header top 1079; stack = bucket 40 + inbox 30 + source0 20 = 90
		expect(proto.sectionStuckTarget.call(fake, "source:s1")).toBe(1079 - 90);
	});

	it("every source's target leaves all the headers before it stacked above, one more header each time", () => {
		const { fake } = build(3);
		// header top = wrap top - header height; stack = bucket 40 + inbox 30 + the source headers before it (20, 21)
		const targets = [0, 1, 2].map((i) => proto.sectionStuckTarget.call(fake, `source:s${i}`));
		expect(targets).toEqual([1000 - 20 - 70, 1100 - 21 - 90, 1200 - 22 - 111]);
		expect(targets[0]).toBeLessThan(targets[1] as number);
		expect(targets[1]).toBeLessThan(targets[2] as number);
	});

	it("the Inbox's own target is unchanged by sources that come after it", () => {
		const withSources = proto.sectionStuckTarget.call(build(3).fake, "inbox");
		const alone = proto.sectionStuckTarget.call(build(0).fake, "inbox");
		expect(withSources).toBe(alone);
	});

	it("an unknown key is 0", () => {
		expect(proto.sectionStuckTarget.call(build(1).fake, "source:nope")).toBe(0);
	});
});
