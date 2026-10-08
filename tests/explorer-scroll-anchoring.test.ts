import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PR-1.F1 T1: browser scroll anchoring on the single scroll body moves scrollTop when a section
// expands above the viewport, which breaks the title and chevron scroll targets. The rule lives in
// styles.css, so this is a source scan of the rule block.
const root = resolve(__dirname, "..");
const stylesSrc = readFileSync(resolve(root, "styles.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(src: string, selector: string): string {
	const match = new RegExp(`(^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(src);
	expect(match, `${selector} rule exists`).not.toBeNull();
	return match![2];
}

describe("PR-1.F1 scroll anchoring", () => {
	it("T1: the scroll body opts out of browser scroll anchoring", () => {
		expect(ruleBody(stylesSrc, ".atlas-explorer-scroll")).toMatch(/overflow-anchor:\s*none\s*;/);
	});
});
