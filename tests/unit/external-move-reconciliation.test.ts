import { describe, expect, it, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { seedRoot } from "../helpers";
import type { AddedItem, UnitRef, View, ViewNode } from "../../src/types";
import { EXTERNAL_MOVE_WINDOW_MS, ExternalMoveDetector } from "../../src/external-move";

const folder = (path: string): UnitRef => ({ kind: "folder", path });

function makeTFolder(path: string, name: string): TFolder {
	const f = new TFolder();
	f.path = path;
	f.name = name;
	return f;
}

function makeTFile(path: string, name: string): TFile {
	const f = new TFile();
	f.path = path;
	f.name = name;
	return f;
}

describe("ExternalMoveDetector (PR-1.S1 T1)", () => {
	it("pairs a delete with a later create of the same name and kind at a different path", () => {
		vi.useFakeTimers();
		try {
			const detector = new ExternalMoveDetector();
			detector.onDelete(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"));
			vi.advanceTimersByTime(EXTERNAL_MOVE_WINDOW_MS - 1);
			expect(detector.matchCreate(makeTFolder("Archive/Acme Ltd", "Acme Ltd"))).toBe("Jobs/Acme Ltd");
		} finally {
			vi.useRealTimers();
		}
	});

	it("never matches a create with a different name", () => {
		const detector = new ExternalMoveDetector();
		detector.onDelete(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"));
		expect(detector.matchCreate(makeTFolder("Archive/Other", "Other"))).toBeNull();
	});

	it("never matches a create of a different kind, even with the same name", () => {
		const detector = new ExternalMoveDetector();
		detector.onDelete(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"));
		expect(detector.matchCreate(makeTFile("Archive/Acme Ltd", "Acme Ltd"))).toBeNull();
	});

	it("never matches a create at the exact same path (not a move)", () => {
		const detector = new ExternalMoveDetector();
		detector.onDelete(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"));
		expect(detector.matchCreate(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"))).toBeNull();
	});

	it("forgets the pending delete once the window elapses", () => {
		vi.useFakeTimers();
		try {
			const detector = new ExternalMoveDetector();
			detector.onDelete(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"));
			vi.advanceTimersByTime(EXTERNAL_MOVE_WINDOW_MS + 1);
			expect(detector.matchCreate(makeTFolder("Archive/Acme Ltd", "Acme Ltd"))).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("consumes a match so a second create cannot re-pair with the same delete", () => {
		const detector = new ExternalMoveDetector();
		detector.onDelete(makeTFolder("Jobs/Acme Ltd", "Acme Ltd"));
		expect(detector.matchCreate(makeTFolder("Archive/Acme Ltd", "Acme Ltd"))).toBe("Jobs/Acme Ltd");
		expect(detector.matchCreate(makeTFolder("Other/Acme Ltd", "Acme Ltd"))).toBeNull();
	});
});

/** Bypasses `AtlasPlugin`'s constructor (needs a real Obsidian `app`/`manifest`), same as
 * `main-persistence.test.ts` — wires only the collaborators `onVaultDeleteEvent`/`onVaultCreateEvent`
 * actually touch. */
function makePlugin(unitIndex: UnitIndex, viewsManager: ViewsManager): AtlasPlugin {
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
	Object.assign(plugin, {
		settings: { ...DEFAULT_SETTINGS, noAutoPromoteFolders: [] },
		unitIndex,
		viewsManager,
		graduation: { handleDelete: () => {}, handleRename: () => undefined, handleModify: () => {} },
		persistDebounced: () => {},
		saveSettings: async () => {},
		expandedModuleFolders: new Set<string>(),
		externalMoveDetector: new ExternalMoveDetector(),
	});
	return plugin;
}

function unitNode(id: string, ref: UnitRef): ViewNode {
	return { id, type: "unit", ref, children: [] };
}

/** PR-1.S1 (T1): `main.ts:167-169` used to rewrite refs only on Obsidian's own `rename` event. A move
 * made outside Obsidian (a shell `mv`) arrives instead as a `delete` for the old path followed by a
 * `create` for the new one — these drive `AtlasPlugin.onVaultDeleteEvent`/`onVaultCreateEvent`
 * directly, exactly as `main.ts`'s registered vault listeners would, without going through the real
 * event-registration machinery. */
describe("AtlasPlugin: external move reconciliation (PR-1.S1 T1)", () => {
	it("rewrites a bucket-placed ref and an added-folder entry when a folder is moved outside Obsidian (nested destination)", async () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme Ltd/x.md"], ["Jobs", "Jobs/Acme Ltd", "Archive"]);

		const addedItems: AddedItem[] = [{ ref: folder("Jobs/Acme Ltd"), tag: "added" }];
		const unitIndex = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], addedItems);
		unitIndex.rebuild();

		const views: View[] = [{ id: "v1", name: "Default", root: [unitNode("n1", folder("Jobs/Acme Ltd"))], inboxMode: "view" }];
		const viewsManager = new ViewsManager(app, views, "v1", () => {});

		const plugin = makePlugin(unitIndex, viewsManager);

		// Real vault mutations, exactly as an external `shell mv Jobs/Acme Ltd Archive/Acme Ltd`
		// would leave the vault — `delete`+`createFolder` fire the same shape of events a real
		// filesystem watcher reports for a move it never sees as one `rename`.
		const movedFolder = app.vault.getAbstractFileByPath("Jobs/Acme Ltd") as TFolder;
		await app.vault.delete(movedFolder, true);
		plugin.onVaultDeleteEvent(movedFolder);

		const recreated = await app.vault.createFolder("Archive/Acme Ltd");
		plugin.onVaultCreateEvent(recreated);

		expect(unitIndex.getAddedItems()).toEqual([{ ref: folder("Archive/Acme Ltd"), tag: "added" }]);
		expect(viewsManager.getViews()[0].root[0].ref).toEqual(folder("Archive/Acme Ltd"));
	});

	it("drops the added-folder entry and surfaces a plain folder-unit when the move lands at the vault root (E7)", async () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme Ltd/x.md"], ["Jobs", "Jobs/Acme Ltd"]);

		const addedItems: AddedItem[] = [{ ref: folder("Jobs/Acme Ltd"), tag: "added" }];
		const unitIndex = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], addedItems);
		unitIndex.rebuild();

		const viewsManager = new ViewsManager(app, [], "default", () => {});
		const plugin = makePlugin(unitIndex, viewsManager);

		const movedFolder = app.vault.getAbstractFileByPath("Jobs/Acme Ltd") as TFolder;
		await app.vault.delete(movedFolder, true);
		plugin.onVaultDeleteEvent(movedFolder);

		const recreated = await app.vault.createFolder("Acme Ltd");
		plugin.onVaultCreateEvent(recreated);

		expect(unitIndex.getAddedItems()).toEqual([]);
		expect(unitIndex.getUnits()).toContainEqual({ type: "folder-unit", path: "Acme Ltd" });
		expect(unitIndex.getUnits()).not.toContainEqual({ type: "added-folder", path: "Jobs/Acme Ltd" });
	});

	it("does not reconcile an unrelated create that merely shares a name with an old delete at the same path", async () => {
		const app = new App();
		seedRoot(app, [], ["Notes"]);
		const addedItems: AddedItem[] = [];
		const unitIndex = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], addedItems);
		const viewsManager = new ViewsManager(app, [], "default", () => {});
		const plugin = makePlugin(unitIndex, viewsManager);

		const deleted = app.vault.getAbstractFileByPath("Notes") as TFolder;
		await app.vault.delete(deleted, true);
		plugin.onVaultDeleteEvent(deleted);

		// Recreated at the very same path — not a move, so no rename reconciliation should run.
		const recreated = await app.vault.createFolder("Notes");
		expect(() => plugin.onVaultCreateEvent(recreated)).not.toThrow();
		expect(unitIndex.getAddedItems()).toEqual([]);
	});
});
