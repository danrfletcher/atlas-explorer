import { describe, expect, it } from "vitest";
import * as obsidianMock from "obsidian";
import { ATLAS_SORT_AZ_ICON_ID, ATLAS_SORT_AZ_ICON_SVG, compareSortKeys, currentSortMode, displayNameFor, isDirectSortMode, registerSortIcons, SORT_MODE_CHOICES, SORT_MODE_ICONS, sortedFolderNoticeText } from "../../src/sort";
import type { SortKey } from "../../src/sort";
import type { ViewNode } from "../../src/types";

const key = (over: Partial<SortKey> = {}): SortKey => ({ name: "", mtime: null, placedAt: null, ...over });

describe("PR-1 sort.ts — compareSortKeys", () => {
	describe("alphabetical", () => {
		it("is case-insensitive", () => {
			expect(compareSortKeys("alphabetical", false, key({ name: "apple" }), key({ name: "Banana" }))).toBeLessThan(0);
			expect(compareSortKeys("alphabetical", false, key({ name: "APPLE" }), key({ name: "apple" }))).toBe(0);
		});

		it("orders embedded numbers naturally, not lexicographically (G8)", () => {
			expect(compareSortKeys("alphabetical", false, key({ name: "Item 2" }), key({ name: "Item 10" }))).toBeLessThan(0);
		});

		it("reverse flips the direction", () => {
			expect(compareSortKeys("alphabetical", true, key({ name: "apple" }), key({ name: "Banana" }))).toBeGreaterThan(0);
		});
	});

	describe("modified", () => {
		it("sorts newest first", () => {
			expect(compareSortKeys("modified", false, key({ mtime: 200 }), key({ mtime: 100 }))).toBeLessThan(0);
		});

		it("reverse sorts oldest first", () => {
			expect(compareSortKeys("modified", true, key({ mtime: 200 }), key({ mtime: 100 }))).toBeGreaterThan(0);
		});

		it("a row with no time (null) always sorts last, including under Reverse (G9/G21)", () => {
			expect(compareSortKeys("modified", false, key({ mtime: null }), key({ mtime: 100 }))).toBeGreaterThan(0);
			expect(compareSortKeys("modified", true, key({ mtime: null }), key({ mtime: 100 }))).toBeGreaterThan(0);
			expect(compareSortKeys("modified", true, key({ mtime: 100 }), key({ mtime: null }))).toBeLessThan(0);
		});

		it("two rows both with no time tie (0) regardless of direction", () => {
			expect(compareSortKeys("modified", false, key({ mtime: null }), key({ mtime: null }))).toBe(0);
			expect(compareSortKeys("modified", true, key({ mtime: null }), key({ mtime: null }))).toBe(0);
		});
	});

	describe("time-added", () => {
		it("sorts newest placedAt first, and a null stamp always sorts last under either direction (G10/G21)", () => {
			expect(compareSortKeys("time-added", false, key({ placedAt: 200 }), key({ placedAt: 100 }))).toBeLessThan(0);
			expect(compareSortKeys("time-added", true, key({ placedAt: null }), key({ placedAt: 100 }))).toBeGreaterThan(0);
			expect(compareSortKeys("time-added", false, key({ placedAt: null }), key({ placedAt: 100 }))).toBeGreaterThan(0);
		});
	});

	it("manual/status (or any other value) never reorders — this comparator is only ever consulted for the three new modes", () => {
		expect(compareSortKeys("manual", false, key({ name: "b" }), key({ name: "a" }))).toBe(0);
		expect(compareSortKeys("status", false, key({ name: "b" }), key({ name: "a" }))).toBe(0);
	});
});

describe("PR-1 sort.ts — isDirectSortMode / currentSortMode", () => {
	it("isDirectSortMode is true only for the three new modes", () => {
		expect(isDirectSortMode("alphabetical")).toBe(true);
		expect(isDirectSortMode("modified")).toBe(true);
		expect(isDirectSortMode("time-added")).toBe(true);
		expect(isDirectSortMode("manual")).toBe(false);
		expect(isDirectSortMode("status")).toBe(false);
		expect(isDirectSortMode(undefined)).toBe(false);
	});

	it("currentSortMode defaults an absent/undefined sortMode to manual", () => {
		expect(currentSortMode({})).toBe("manual");
		expect(currentSortMode({ sortMode: "alphabetical" })).toBe("alphabetical");
	});
});

describe("PR-1 sort.ts — SORT_MODE_CHOICES", () => {
	it("is exactly Manual, A-Z, Modified, Time added, in that order (G6/F4)", () => {
		expect(SORT_MODE_CHOICES.map((c) => c.mode)).toEqual(["manual", "alphabetical", "modified", "time-added"]);
		expect(SORT_MODE_CHOICES.map((c) => c.label)).toEqual(["Manual", "A-Z", "Modified", "Time added"]);
	});
});

describe("PR-2 sort.ts — displayNameFor", () => {
	it("uses a meta folder's own label", () => {
		const node: ViewNode = { id: "f", type: "meta", label: "My Folder", children: [] };
		expect(displayNameFor(node, "ignored")).toBe("My Folder");
	});

	it("uses the caller-resolved text for a unit (including a missing ref's fallback name)", () => {
		const node: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "X.md" }, children: [] };
		expect(displayNameFor(node, "X")).toBe("X");
		expect(displayNameFor(node, undefined)).toBe("");
	});
});

// PR-2 (T12): registerSortIcons() registers Atlas's own A-Z icon id via addIcon() — see
// ATLAS_SORT_AZ_ICON_ID's doc comment for why a Lucide id string alone never resolved through
// setIcon()/MenuItem.setIcon() for this icon across three straight fix rounds (T1/T5/T9).
describe("PR-2 sort.ts — registerSortIcons", () => {
	it("calls addIcon with ATLAS_SORT_AZ_ICON_ID and real, non-empty SVG path data", () => {
		const before = obsidianMock.addIconCalls.length;
		registerSortIcons();
		const calls = obsidianMock.addIconCalls.slice(before);
		expect(calls).toEqual([{ iconId: ATLAS_SORT_AZ_ICON_ID, svgContent: ATLAS_SORT_AZ_ICON_SVG }]);
		expect(ATLAS_SORT_AZ_ICON_SVG).toContain("<path");
		expect(ATLAS_SORT_AZ_ICON_SVG.length).toBeGreaterThan(0);
	});

	it("SORT_MODE_ICONS.alphabetical points at the registered id, not a bare or lucide-prefixed Lucide string", () => {
		expect(SORT_MODE_ICONS.alphabetical).toBe(ATLAS_SORT_AZ_ICON_ID);
		expect(SORT_MODE_ICONS.alphabetical).not.toBe("arrow-down-az");
		expect(SORT_MODE_ICONS.alphabetical).not.toBe("lucide-arrow-down-az");
	});
});

// PR-4 (G4/E13/E14): sortedFolderNoticeText — exact wording for every mode, both directions, the
// Bucket root, and a folder name with punctuation (GP4 uses "Projects", a plain name; the spec's
// own exact-string test also wants a name with punctuation covered).
describe("PR-4 sort.ts — sortedFolderNoticeText", () => {
	it("A-Z / Z-A", () => {
		expect(sortedFolderNoticeText("Projects", "alphabetical", false)).toBe("Projects is sorted A-Z. Set it to Manual to reorder.");
		expect(sortedFolderNoticeText("Projects", "alphabetical", true)).toBe("Projects is sorted Z-A. Set it to Manual to reorder.");
	});

	it("Modified, newest/oldest first", () => {
		expect(sortedFolderNoticeText("Projects", "modified", false)).toBe("Projects is sorted Modified, newest first. Set it to Manual to reorder.");
		expect(sortedFolderNoticeText("Projects", "modified", true)).toBe("Projects is sorted Modified, oldest first. Set it to Manual to reorder.");
	});

	it("Time added, newest/oldest first", () => {
		expect(sortedFolderNoticeText("Projects", "time-added", false)).toBe("Projects is sorted Time added, newest first. Set it to Manual to reorder.");
		expect(sortedFolderNoticeText("Projects", "time-added", true)).toBe("Projects is sorted Time added, oldest first. Set it to Manual to reorder.");
	});

	it("Status, and reversed (E14)", () => {
		expect(sortedFolderNoticeText("Projects", "status", false)).toBe("Projects is sorted Status. Set it to Manual to reorder.");
		expect(sortedFolderNoticeText("Projects", "status", true)).toBe("Projects is sorted Status, reversed. Set it to Manual to reorder.");
	});

	it("the view root reads \"View is sorted ...\"", () => {
		expect(sortedFolderNoticeText("View", "alphabetical", false)).toBe("View is sorted A-Z. Set it to Manual to reorder.");
	});

	it("a folder name with punctuation is carried through verbatim, not escaped or altered", () => {
		expect(sortedFolderNoticeText("Q3 Plans (draft)", "modified", false)).toBe(
			"Q3 Plans (draft) is sorted Modified, newest first. Set it to Manual to reorder."
		);
	});
});
