import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

/** jsdom can't compute the real cascade, so this pins the selector the visual check depends on. */
describe("File filters key-invalid styles", () => {
	it("outlines an empty-key rule with more specificity than Obsidian's input[type=text] rule", () => {
		// Obsidian: input[type=text] { outline: none } is (0,1,1); ours must beat it and its hover/focus rules.
		expect(css).toMatch(/input\.atlas-yaml-key-invalid\[type="text"\]:not\(:disabled\)\s*\{[^}]*outline:\s*1px solid var\(--text-error/);
		expect(css).not.toMatch(/(^|[\s,}])\.atlas-yaml-key-invalid\s*\{/);
	});
});
