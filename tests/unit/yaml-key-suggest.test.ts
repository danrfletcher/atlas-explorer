import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { collectFrontmatterKeys, filterYamlKeySuggestions } from "../../src/yaml-key-suggest";

/** A mock `App` whose vault lists `files`, each with the frontmatter `metadataCache` reports for it.
 * `null` frontmatter models a note with no YAML block, which `getFileCache` reports as no
 * frontmatter at all. */
function mockApp(files: { path: string; frontmatter: Record<string, unknown> | null }[]): App {
	const byFile = new Map(files.map((f) => [f.path, f]));
	return {
		vault: { getFiles: () => files.map((f) => ({ path: f.path })) },
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const entry = byFile.get(file.path);
				return entry?.frontmatter ? { frontmatter: entry.frontmatter } : {};
			},
		},
	} as unknown as App;
}

describe("collectFrontmatterKeys", () => {
	it("returns the keys across the vault, de-duplicated case-insensitively and sorted", () => {
		const app = mockApp([
			{ path: "a.md", frontmatter: { Status: "active", company: "x" } },
			{ path: "b.md", frontmatter: { status: "done", Tags: ["a"] } },
		]);
		expect(collectFrontmatterKeys(app)).toEqual(["company", "status", "Tags"]);
	});

	it("shows a mixed-case key once, preferring the all-lowercase spelling regardless of file order", () => {
		const forward = mockApp([
			{ path: "a.md", frontmatter: { Status: "x" } },
			{ path: "b.md", frontmatter: { status: "y" } },
		]);
		const reversed = mockApp([
			{ path: "b.md", frontmatter: { status: "y" } },
			{ path: "a.md", frontmatter: { Status: "x" } },
		]);
		expect(collectFrontmatterKeys(forward)).toEqual(["status"]);
		expect(collectFrontmatterKeys(reversed)).toEqual(["status"]);
	});

	it("ignores files without frontmatter", () => {
		const app = mockApp([
			{ path: "plain.md", frontmatter: null },
			{ path: "tagged.md", frontmatter: { type: "job" } },
		]);
		expect(collectFrontmatterKeys(app)).toEqual(["type"]);
	});

	it("returns an empty list for an empty vault", () => {
		expect(collectFrontmatterKeys(mockApp([]))).toEqual([]);
	});

	it("returns an empty list when no note has frontmatter", () => {
		expect(collectFrontmatterKeys(mockApp([{ path: "plain.md", frontmatter: null }]))).toEqual([]);
	});
});

describe("filterYamlKeySuggestions", () => {
	const keys = ["company", "status", "Status-date", "tags"];

	it("matches the typed text case-insensitively", () => {
		expect(filterYamlKeySuggestions(keys, "ST")).toEqual(["status", "Status-date"]);
	});

	it("lists prefix matches before substring matches", () => {
		expect(filterYamlKeySuggestions(["mystatus", "status"], "stat")).toEqual(["status", "mystatus"]);
	});

	it("suggests nothing for text that matches no key, so free text is still accepted by the field", () => {
		expect(filterYamlKeySuggestions(keys, "zzz custom")).toEqual([]);
	});

	it("suggests every key for empty text", () => {
		expect(filterYamlKeySuggestions(keys, "")).toEqual(keys);
	});
});
