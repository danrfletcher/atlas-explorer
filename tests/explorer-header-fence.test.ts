import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PR-1.F1 fence checks (F4, F5, F9), as a source scan. The sticky-header and section-header code must
// not persist scroll position, add a setting, or add keyboard handling to the headers.
const root = resolve(__dirname, "..");
const explorerSrc = readFileSync(resolve(root, "src/explorer-view.ts"), "utf8");
const settingsSrc = readFileSync(resolve(root, "src/settings.ts"), "utf8");

/** Text from `start` up to (not including) the next class member after it. */
function methodBody(src: string, start: string): string {
	const from = src.indexOf(start);
	expect(from, `${start} exists`).toBeGreaterThan(-1);
	const next = src.indexOf("\n\tprivate ", from + start.length);
	return src.slice(from, next === -1 ? undefined : next);
}

/** Text from the sticky-header block to the toolbar section, which holds the header positioning and click code. */
function stickyBlock(src: string): string {
	const from = src.indexOf("private observeInboxLayout(");
	const to = src.indexOf("// --- toolbar");
	expect(from).toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return src.slice(from, to);
}

describe("PR-1.F1 fence", () => {
	it("F4: the header and sticky code never write scroll position to storage", () => {
		const block = stickyBlock(explorerSrc);
		expect(block).not.toMatch(/localStorage/);
		expect(block).not.toMatch(/saveData|savePluginData|persist/);
		expect(methodBody(explorerSrc, "private async renderBucketSection(")).not.toMatch(/localStorage|saveData/);
		expect(methodBody(explorerSrc, "private async renderInboxSection(")).not.toMatch(/localStorage|saveData/);
	});

	it("F5: no setting is added for sticky headers or scroll", () => {
		expect(settingsSrc).not.toMatch(/sticky|scrollPadding|stickyHeader|pinHeader/i);
	});

	it("F9: the section headers add no keydown handler", () => {
		expect(stickyBlock(explorerSrc)).not.toMatch(/keydown/);
		expect(methodBody(explorerSrc, "private async renderBucketSection(")).not.toMatch(/keydown/);
		expect(methodBody(explorerSrc, "private async renderInboxSection(")).not.toMatch(/keydown/);
	});
});
