import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { isRefPresent, presentEntryLabel, presentRefEntry } from "../../src/ref-presence";
import type { UnitRef } from "../../src/types";

/** The shared presence rule that decides whether a placed ref is "missing". The mocked `Vault` is the
 * fixture, so every case reads a real `TFile`/`TFolder` through `getAbstractFileByPath`. */

function vaultWith(files: string[], folders: string[]) {
	const app = new App();
	for (const f of folders) app.vault.seedFolder(f);
	for (const f of files) app.vault.seedFile(f);
	return app.vault;
}

const vault = vaultWith(["Notes/Plain.md", "Notes/scan.pdf", "Notes/pic.png", "Root.md", "Archive.d/odd.md"], ["Notes", "Archive.d", "Empty"]);

const file = (path: string): UnitRef => ({ kind: "file", path });
const folder = (path: string): UnitRef => ({ kind: "folder", path });
const block = (path: string, subpath = "^abc"): UnitRef => ({ kind: "block", path, subpath });

describe("isRefPresent — kind × what the vault holds at the path", () => {
	const table: { name: string; ref: UnitRef; expected: boolean }[] = [
		{ name: "E1 file ref, TFile at path (not a unit)", ref: file("Notes/Plain.md"), expected: true },
		{ name: "file ref, TFile at the vault root", ref: file("Root.md"), expected: true },
		{ name: "E11 file ref, PDF TFile", ref: file("Notes/scan.pdf"), expected: true },
		{ name: "E11 file ref, image TFile", ref: file("Notes/pic.png"), expected: true },
		{ name: "file ref, nothing at path", ref: file("Notes/Gone.md"), expected: false },
		{ name: "E9 file ref, but a TFolder is at the path", ref: file("Notes"), expected: false },
		{ name: "E2 folder ref, TFolder at path", ref: folder("Notes"), expected: true },
		{ name: "folder ref, empty TFolder (no interface note) is still present", ref: folder("Empty"), expected: true },
		{ name: "folder ref, dotted folder name", ref: folder("Archive.d"), expected: true },
		{ name: "folder ref, nothing at path", ref: folder("Nope"), expected: false },
		{ name: "E9 folder ref, but a TFile is at the path", ref: folder("Notes/Plain.md"), expected: false },
		{ name: "block ref, file exists: not covered by the predicate", ref: block("Notes/Plain.md"), expected: false },
		{ name: "block ref, nothing at path", ref: block("Notes/Gone.md"), expected: false },
		{ name: "file ref, empty path", ref: file(""), expected: false },
		{ name: "folder ref, empty path (would be the vault root)", ref: folder(""), expected: false },
		{ name: "folder ref, '/' (the vault root)", ref: folder("/"), expected: false },
		{ name: "file ref, unknown absolute path", ref: file("/Users/someone/else.md"), expected: false },
	];

	it.each(table)("$name -> $expected", ({ ref, expected }) => {
		expect(isRefPresent(vault, ref)).toBe(expected);
	});

	it("is live: the answer follows the vault with no caching", async () => {
		const v = vaultWith(["A.md"], []);
		expect(isRefPresent(v, file("A.md"))).toBe(true);
		await v.delete(v.getAbstractFileByPath("A.md")!);
		expect(isRefPresent(v, file("A.md"))).toBe(false);
		await v.create("A.md", "");
		expect(isRefPresent(v, file("A.md"))).toBe(true);
	});

	it("reads only: it never records a vault call", () => {
		const v = vaultWith(["A.md"], ["F"]);
		isRefPresent(v, file("A.md"));
		isRefPresent(v, folder("F"));
		expect(v.calls).toEqual([]);
	});
});

describe("presentRefEntry / presentEntryLabel", () => {
	it("returns the TFile / TFolder itself, or null", () => {
		expect(presentRefEntry(vault, file("Notes/Plain.md"))?.path).toBe("Notes/Plain.md");
		expect(presentRefEntry(vault, folder("Notes"))?.path).toBe("Notes");
		expect(presentRefEntry(vault, file("Notes"))).toBeNull();
	});

	it("E8 labels a file by its name without the extension, a folder by its name", () => {
		expect(presentEntryLabel(presentRefEntry(vault, file("Notes/Plain.md"))!)).toBe("Plain");
		expect(presentEntryLabel(presentRefEntry(vault, file("Notes/scan.pdf"))!)).toBe("scan");
		expect(presentEntryLabel(presentRefEntry(vault, folder("Notes"))!)).toBe("Notes");
		expect(presentEntryLabel(presentRefEntry(vault, folder("Archive.d"))!)).toBe("Archive.d");
	});

	it("keeps dots inside a file's name and only strips the final extension", () => {
		const v = vaultWith(["Notes/v1.2 plan.md"], ["Notes"]);
		expect(presentEntryLabel(presentRefEntry(v, file("Notes/v1.2 plan.md"))!)).toBe("v1.2 plan");
	});
});
