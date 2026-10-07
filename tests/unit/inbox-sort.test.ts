import { describe, expect, it } from "vitest";
import { TAbstractFile, TFile } from "obsidian";
import { compareInboxRows } from "../../src/explorer-view";
import type { InboxSortRow } from "../../src/explorer-view";
import type { Unit } from "../../src/types";

/** Vault stub for `getAbstractFileByPath`: files carry a ctime; anything not listed is absent (so a
 * folder-kind unit, or a missing file, reads as non-TFile and its ctime is 0). */
function vaultWith(files: Record<string, number>): (path: string) => TAbstractFile | null {
	return (path) => {
		if (!(path in files)) return null;
		const file = new TFile();
		file.path = path;
		file.stat = { ctime: files[path], mtime: 0, size: 0 };
		return file;
	};
}

const row = (unit: Unit, text = unit.path.split("/").pop() ?? unit.path): InboxSortRow => ({ unit, text });

/** Sorts a list of rows the way the inbox does, then returns the row texts in order. */
function sorted(rows: InboxSortRow[], alphabetical: boolean, files: Record<string, number>): string[] {
	return [...rows].sort((a, b) => compareInboxRows(a, b, alphabetical, vaultWith(files))).map((r) => r.text);
}

const rootFile = (path: string): Unit => ({ type: "root-file", path });
const addedFile = (path: string): Unit => ({ type: "added-file", path });
const folderUnit = (path: string): Unit => ({ type: "folder-unit", path });
const promotedFolder = (path: string): Unit => ({ type: "promoted-folder", path, topLevelFolder: "" });
const addedFolder = (path: string): Unit => ({ type: "added-folder", path });

describe("G3 inbox sort — alphabetical mode is unchanged (modules and files interleave by name)", () => {
	it("mixes files and modules by name", () => {
		const rows = [row(rootFile("Zeta.md")), row(folderUnit("Alpha")), row(addedFile("Mike.md")), row(promotedFolder("Beta"))];
		expect(sorted(rows, true, { "Zeta.md": 1, "Mike.md": 2 })).toEqual(["Alpha", "Beta", "Mike.md", "Zeta.md"]);
	});

	it("ignores ctime entirely", () => {
		const rows = [row(rootFile("Old.md")), row(rootFile("New.md")), row(folderUnit("Middle"))];
		expect(sorted(rows, true, { "Old.md": 1, "New.md": 9999 })).toEqual(["Middle", "New.md", "Old.md"]);
	});
});

describe("G3 inbox sort — newest-first mode: files by ctime desc, then modules by name", () => {
	it("puts files first, newest first, then the module group ordered by name", () => {
		const rows = [
			row(folderUnit("Zeta")),
			row(rootFile("a.md")),
			row(folderUnit("Alpha")),
			row(rootFile("b.md")),
			row(promotedFolder("Mike")),
		];
		expect(sorted(rows, false, { "a.md": 100, "b.md": 300 })).toEqual(["b.md", "a.md", "Alpha", "Mike", "Zeta"]);
	});

	it("includes promoted folders, folder units and added folders alike in the module group", () => {
		const rows = [row(addedFolder("Acme")), row(folderUnit("Zeta")), row(promotedFolder("Mike"))];
		expect(sorted(rows, false, {})).toEqual(["Acme", "Mike", "Zeta"]);
	});

	it("an added folder sorts by name with the other modules, after files", () => {
		const rows = [row(addedFile("note.md")), row(addedFolder("Acme")), row(folderUnit("Zebra"))];
		expect(sorted(rows, false, { "note.md": 5 })).toEqual(["note.md", "Acme", "Zebra"]);
	});

	it("an empty module (E1) sorts like any other module", () => {
		const rows = [row(addedFolder("Empty")), row(folderUnit("Full"))];
		expect(sorted(rows, false, {})).toEqual(["Empty", "Full"]);
	});

	it("a file with ctime 0 is not mistaken for a module: it stays in the file group", () => {
		const rows = [row(folderUnit("Alpha")), row(rootFile("zero.md"))];
		expect(sorted(rows, false, { "zero.md": 0 })).toEqual(["zero.md", "Alpha"]);
	});

	it("files with equal ctime keep a deterministic order (by name, then path)", () => {
		const rows = [row(rootFile("b/x.md"), "x"), row(rootFile("a/x.md"), "x"), row(rootFile("c.md"), "c")];
		const files = { "b/x.md": 7, "a/x.md": 7, "c.md": 7 };
		const once = sorted(rows, false, files);
		const twice = sorted([...rows].reverse(), false, files);
		expect(once).toEqual(["c", "x", "x"]);
		expect(twice).toEqual(once);
		const paths = [...rows]
			.sort((a, b) => compareInboxRows(a, b, false, vaultWith(files)))
			.map((r) => r.unit.path);
		expect(paths).toEqual(["c.md", "a/x.md", "b/x.md"]);
	});

	it("a missing added file (no vault entry) is treated as a file, ctime 0, not a module", () => {
		const rows = [row(addedFile("gone.md")), row(folderUnit("Alpha"))];
		expect(sorted(rows, false, {})).toEqual(["gone.md", "Alpha"]);
	});
});

describe("G3 inbox sort — names, unicode and digits order the same as alphabetical mode", () => {
	const names = ["beta", "Alpha", "alpha", "Émile", "zoë", "10 Things", "2 Things", "Ärger"];
	it("modules order by localeCompare, deterministically", () => {
		const rows = names.map((n) => row(folderUnit(n), n));
		const expected = [...names].sort((a, b) => a.localeCompare(b));
		expect(sorted(rows, false, {})).toEqual(expected);
		expect(sorted(rows, true, {})).toEqual(expected);
	});

	it("modules with identical names (different paths) keep a stable order regardless of input order", () => {
		const a = row(folderUnit("one/Same"), "Same");
		const b = row(folderUnit("two/Same"), "Same");
		expect(sorted([a, b], false, {}).length).toBe(2);
		const forward = [...[a, b]].sort((x, y) => compareInboxRows(x, y, false, vaultWith({})));
		const backward = [...[b, a]].sort((x, y) => compareInboxRows(x, y, false, vaultWith({})));
		expect(forward.map((r) => r.unit.path)).toEqual(["one/Same", "two/Same"]);
		expect(backward.map((r) => r.unit.path)).toEqual(["one/Same", "two/Same"]);
	});
});

describe("G3 inbox sort — edge inboxes render without error", () => {
	it("an empty inbox", () => {
		expect(sorted([], false, {})).toEqual([]);
		expect(sorted([], true, {})).toEqual([]);
	});

	it("a modules-only inbox", () => {
		const rows = [row(addedFolder("B")), row(folderUnit("A"))];
		expect(sorted(rows, false, {})).toEqual(["A", "B"]);
	});

	it("a files-only inbox", () => {
		const rows = [row(rootFile("old.md")), row(rootFile("new.md"))];
		expect(sorted(rows, false, { "old.md": 1, "new.md": 2 })).toEqual(["new.md", "old.md"]);
	});
});

describe("G3 inbox sort — switching modes back and forth leaves no stale order", () => {
	it("the comparator is pure: each mode gives its own order on the same input, in any sequence", () => {
		const rows = [row(rootFile("f.md")), row(folderUnit("Zed")), row(folderUnit("Ann"))];
		const files = { "f.md": 1 };
		const newest = sorted(rows, false, files);
		const alpha = sorted(rows, true, files);
		const newestAgain = sorted(rows, false, files);
		expect(newest).toEqual(["f.md", "Ann", "Zed"]);
		expect(alpha).toEqual(["Ann", "f.md", "Zed"]);
		expect(newestAgain).toEqual(newest);
	});
});
