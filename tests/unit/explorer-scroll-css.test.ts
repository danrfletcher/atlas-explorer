import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** PR-1.S1 (F1/F2): static checks on the panel's scroll rules. jsdom has no layout, so these read the
 * stylesheet itself: exactly one scrolling element in the panel, and no drag-to-resize handle. */

const css = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selectors { body }` rule in the stylesheet, comments already stripped. */
const rules = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g), (m) => ({ selectors: m[1].trim(), body: m[2] }));

/** Panel selectors: anything that renders inside the explorer panel (the bucket, the inbox, the
 * meta-children wrappers, the old viewport, the toolbar and the scroll body itself). */
const PANEL = /\.atlas-(explorer|section|inbox|bucket|node-list|meta-children|toolbar|filter|inbox-viewport)/;

describe("PR-1.S1 F2 — exactly one scrolling element in the panel", () => {
	it("gives overflow-y auto only to the single scroll body", () => {
		const scrolling = rules.filter((r) => PANEL.test(r.selectors) && /overflow-y\s*:\s*(auto|scroll)/.test(r.body));
		expect(scrolling.map((r) => r.selectors)).toEqual([".atlas-explorer-scroll"]);
	});

	it("does not let the panel container itself scroll", () => {
		const explorer = rules.find((r) => r.selectors === ".atlas-explorer");
		expect(explorer).toBeDefined();
		expect(explorer!.body).not.toMatch(/overflow(-y)?\s*:\s*(auto|scroll)/);
	});

	it("no longer ships the inner inbox viewport rule", () => {
		expect(rules.some((r) => /\.atlas-inbox-viewport\b/.test(r.selectors))).toBe(false);
	});
});

describe("PR-1.S1 F1 — no drag-to-resize divider between bucket and inbox", () => {
	it("has no resize or divider/handle selector anywhere in the stylesheet", () => {
		const offending = rules.filter((r) => /resize|divider|splitter|drag-handle|resize-handle/i.test(r.selectors));
		expect(offending.map((r) => r.selectors)).toEqual([]);
	});

	it("never sets the panel's resize property", () => {
		expect(css).not.toMatch(/\bresize\s*:\s*(vertical|both|horizontal|block|inline)/);
	});
});

describe("PR-1.S1 F3 — the toolbar is fixed and never shrinks into the scroll", () => {
	it("keeps the toolbar and filter row at their natural size in the panel's flex column", () => {
		const fixed = rules.find((r) => r.selectors.includes(".atlas-explorer > .atlas-toolbar"));
		expect(fixed).toBeDefined();
		expect(fixed!.body).toMatch(/flex\s*:\s*0 0 auto/);
	});
});
