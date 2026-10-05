import { describe, expect, it } from "vitest";
import { App, TFolder } from "obsidian";
import { candidateFilesForAdd, candidateFoldersForAdd } from "../../src/explorer-view";
import type { Unit, UnitRef } from "../../src/types";
import { unitRefKey } from "../../src/types";
import { seedRoot } from "../helpers";

/** One helper builds the mock vault for every case here: each path's ancestor folders are seeded
 * first, so `TFolder`/`TFile` objects always have a real parent in the vault tree. */
function vaultWith(folders: string[], files: string[] = []): App {
	const app = new App();
	const seeded = new Set<string>();
	for (const folder of folders) {
		const parts = folder.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i).join("/");
			if (!seeded.has(path)) {
				seeded.add(path);
				app.vault.seedFolder(path);
			}
		}
	}
	seedRoot(app, files);
	return app;
}

const SETTINGS = { poolFolder: "_pool", excludedFolders: [] as string[] };

function offered(app: App, units: Unit[] = [], placed: UnitRef[] = [], settings = SETTINGS): string[] {
	const placedKeys = new Set(placed.map(unitRefKey));
	return candidateFoldersForAdd(app.vault.getAllLoadedFiles(), units, placedKeys, settings)
		.map((folder) => folder.path)
		.sort();
}

const promotedFolder = (path: string): Unit => ({ type: "promoted-folder", path, topLevelFolder: path.split("/")[0] });
const addedFolder = (path: string): Unit => ({ type: "added-folder", path });
const addedFile = (path: string): Unit => ({ type: "added-file", path });
const folderRef = (path: string): UnitRef => ({ kind: "folder", path });

describe("candidateFoldersForAdd (G1 offer rule, F2, E9)", () => {
	// Every row is one clause of the offer rule. A row that breaks only its named clause is absent;
	// the control row breaks none and must be present.
	const FOLDERS = ["Jobs", "Jobs/Acme", "Jobs/Acme/Deep", "Archive/Old", "Archived/Thing", "_pool/Sub/Deeper", "Pool2/Thing", "Jobs/Placed", "Jobs/Promoted"];

	it.each([
		{ name: "control: a plain sub-folder breaks no clause", path: "Jobs/Acme", present: true },
		{ name: "vault-root folder (F2)", path: "Jobs", present: false },
		{ name: "already a promoted-folder unit (link, Module Contents or Folder source)", path: "Jobs/Promoted", units: [promotedFolder("Jobs/Promoted")], present: false },
		{ name: "already an added-folder unit", path: "Jobs/Acme", units: [addedFolder("Jobs/Acme")], present: false },
		{ name: "placed in a view (bucket or inbox)", path: "Jobs/Placed", placed: [folderRef("Jobs/Placed")], present: false },
		{ name: "the pool folder itself (F2)", path: "_pool", present: false },
		{ name: "a sub-folder of the pool, at depth (E9)", path: "_pool/Sub/Deeper", present: false },
		{ name: "a folder that only string-prefixes the pool name", path: "Pool2/Thing", settings: { poolFolder: "Pool", excludedFolders: [] }, present: true },
		{ name: "the excluded folder itself (F2)", path: "Archive", settings: { poolFolder: "_pool", excludedFolders: ["Archive"] }, present: false },
		{ name: "a folder inside an excluded folder (F2)", path: "Archive/Old", settings: { poolFolder: "_pool", excludedFolders: ["Archive"] }, present: false },
		{ name: "a folder that only string-prefixes an excluded name", path: "Archived/Thing", settings: { poolFolder: "_pool", excludedFolders: ["Archive"] }, present: true },
		{ name: "a folder inside an added folder is still offered (E2, G11)", path: "Jobs/Acme/Deep", units: [addedFolder("Jobs/Acme")], present: true },
	])("$name", ({ path, units = [], placed = [], settings = SETTINGS, present }) => {
		const app = vaultWith(FOLDERS);
		const result = offered(app, units, placed, settings);
		if (present) expect(result).toContain(path);
		else expect(result).not.toContain(path);
	});

	it("offers exactly the non-breaking sub-folders together", () => {
		const app = vaultWith(FOLDERS);
		const result = offered(app, [addedFolder("Jobs/Acme")], [folderRef("Jobs/Placed")]);
		// Vault-root folders (Jobs, Archive, Archived, Pool2, _pool) never; Jobs/Acme (added), Jobs/Placed (placed),
		// and _pool/Sub and below (pool) never. Everything else is offered.
		expect(result).toEqual(["Archive/Old", "Archived/Thing", "Jobs/Acme/Deep", "Jobs/Promoted", "Pool2/Thing"]);
	});

	it("returns real TFolder objects, not paths", () => {
		const app = vaultWith(["Jobs/Acme"]);
		const [folder] = candidateFoldersForAdd(app.vault.getAllLoadedFiles(), [], new Set(), SETTINGS);
		expect(folder).toBeInstanceOf(TFolder);
		expect(folder.path).toBe("Jobs/Acme");
	});

	it("empty vault and vault with no sub-folders: no crash, nothing offered", () => {
		expect(offered(new App())).toEqual([]);
		const app = vaultWith([], ["Loose.md"]);
		expect(offered(app)).toEqual([]);
	});

	it("ignores files entirely: only TFolder entries come back", () => {
		const app = vaultWith(["Jobs/Acme"], ["Jobs/Acme/brief.md"]);
		const result = candidateFoldersForAdd(app.vault.getAllLoadedFiles(), [], new Set(), SETTINGS);
		expect(result.every((f) => f instanceof TFolder)).toBe(true);
		expect(result.map((f) => f.path)).toEqual(["Jobs/Acme"]);
	});

	it("performance guard: a few thousand generated folders complete within a generous budget", () => {
		const folders: string[] = [];
		for (let parent = 0; parent < 40; parent++) {
			for (let child = 0; child < 100; child++) folders.push(`Big/P${parent}/F${child}`);
		}
		const app = vaultWith(folders);
		const units: Unit[] = [];
		for (let i = 0; i < 400; i++) units.push(addedFolder(`Big/P${i % 40}/F${i % 100}`));
		const placed = new Set(folders.filter((_, i) => i % 7 === 0).map((p) => unitRefKey(folderRef(p))));
		const started = performance.now();
		const result = candidateFoldersForAdd(app.vault.getAllLoadedFiles(), units, placed, SETTINGS);
		const elapsed = performance.now() - started;
		// 4,040 folders (parents included): the Set lookups keep this linear; 500ms is far above the real cost.
		expect(elapsed).toBeLessThan(500);
		expect(result.length).toBeGreaterThan(0);
		expect(result.length).toBeLessThan(folders.length);
	});
});

describe("interface-note exclusion from the '+' file list (G12, E6)", () => {
	it("an added folder's interface note leaves the file list; its other files stay offered", () => {
		const app = vaultWith(["Jobs/Acme"], ["Jobs/Acme/Acme.md", "Jobs/Acme/brief.md"]);
		const result = candidateFilesForAdd(app.vault.getFiles(), [addedFolder("Jobs/Acme")], () => false).map((f) => f.path);
		expect(result).toEqual(["Jobs/Acme/brief.md"]);
	});

	it("a promoted folder's interface note is unchanged and still offered", () => {
		const app = vaultWith(["Jobs/Acme"], ["Jobs/Acme/Acme.md"]);
		const result = candidateFilesForAdd(app.vault.getFiles(), [promotedFolder("Jobs/Acme")], () => false).map((f) => f.path);
		expect(result).toEqual(["Jobs/Acme/Acme.md"]);
	});

	it("E6: a note added first is already a unit, and its folder is still offered, so both rows stay", () => {
		const app = vaultWith(["Jobs/Acme"], ["Jobs/Acme/Acme.md"]);
		const units = [addedFile("Jobs/Acme/Acme.md")];
		expect(candidateFilesForAdd(app.vault.getFiles(), units, () => false)).toEqual([]);
		expect(offered(app, units)).toContain("Jobs/Acme");
	});

	it("the note is offered again once the added folder is removed", () => {
		const app = vaultWith(["Jobs/Acme"], ["Jobs/Acme/Acme.md"]);
		expect(candidateFilesForAdd(app.vault.getFiles(), [addedFolder("Jobs/Acme")], () => false)).toEqual([]);
		const afterRemoval = candidateFilesForAdd(app.vault.getFiles(), [], () => false).map((f) => f.path);
		expect(afterRemoval).toEqual(["Jobs/Acme/Acme.md"]);
	});

	it("a note in a different folder whose name only shares a prefix is not excluded", () => {
		const app = vaultWith(["Jobs/Acme", "Jobs/Acme2"], ["Jobs/Acme2/Acme2.md"]);
		const result = candidateFilesForAdd(app.vault.getFiles(), [addedFolder("Jobs/Acme")], () => false).map((f) => f.path);
		expect(result).toEqual(["Jobs/Acme2/Acme2.md"]);
	});
});

describe("a folder and a file with the same basename", () => {
	it("are separate candidates, distinguishable by path/ versus path.md", () => {
		const app = vaultWith(["Jobs/Acme"], ["Jobs/Acme.md"]);
		const folders = candidateFoldersForAdd(app.vault.getAllLoadedFiles(), [], new Set(), SETTINGS);
		const files = candidateFilesForAdd(app.vault.getFiles(), [], () => false);
		expect(folders.map((f) => `${f.path}/`)).toEqual(["Jobs/Acme/"]);
		expect(files.map((f) => f.path)).toEqual(["Jobs/Acme.md"]);
	});
});
