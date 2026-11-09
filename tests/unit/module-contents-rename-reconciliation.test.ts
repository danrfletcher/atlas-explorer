import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { ExternalMoveDetector } from "../../src/external-move";
import { makeModuleRig } from "./module-contents-fixtures";

/** The plugin as `main.ts` registers its vault listeners, over the real index and real vault mutations. */
function rigWithEvents(hidden: Record<string, string[]>, files: string[], folders: string[]) {
	const rig = makeModuleRig(files, folders, hidden);
	Object.assign(rig.plugin, {
		settings: { ...DEFAULT_SETTINGS, noAutoPromoteFolders: [] },
		graduation: { handleDelete: () => {}, handleRename: () => undefined, handleModify: () => {} },
		externalMoveDetector: new ExternalMoveDetector(),
	});
	return rig;
}

describe("G2 hidden record follows vault renames and is pruned on delete", () => {
	it("renaming a hidden file inside the module migrates its entry and persists", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/a.md", "Mod/b.md"] }, ["Mod/a.md", "Mod/b.md"], ["Mod"]);
		const file = rig.app.vault.getAbstractFileByPath("Mod/a.md") as TFile;
		const oldPath = file.path;
		await rig.app.fileManager.renameFile(file, "Mod/renamed.md");
		rig.plugin.onVaultRenameEvent(file, oldPath);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/renamed.md", "Mod/b.md"] });
		expect(rig.persistDebounced).toHaveBeenCalled();
	});

	it("renaming a hidden folder rewrites every path beneath it", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/sub", "Mod/sub/c.md", "Mod/keep.md"] }, ["Mod/sub/c.md", "Mod/keep.md"], ["Mod", "Mod/sub"]);
		const sub = rig.app.vault.getAbstractFileByPath("Mod/sub") as TFolder;
		await rig.app.fileManager.renameFile(sub, "Mod/inner");
		rig.plugin.onVaultRenameEvent(sub, "Mod/sub");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/inner", "Mod/inner/c.md", "Mod/keep.md"] });
	});

	it("renaming the MODULE folder re-keys the record and rewrites its items", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/a.md"] }, ["Mod/a.md"], ["Mod"]);
		const mod = rig.app.vault.getAbstractFileByPath("Mod") as TFolder;
		await rig.app.fileManager.renameFile(mod, "Renamed");
		rig.plugin.onVaultRenameEvent(mod, "Mod");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Renamed: ["Renamed/a.md"] });
	});

	it("a prefix that is not a parent is left alone (Mod/a vs Mod/ab.md)", () => {
		const rig = rigWithEvents({ Mod: ["Mod/ab.md"] }, ["Mod/ab.md"], ["Mod"]);
		expect(rig.index.rewriteHiddenModuleItems("Mod/a", "Mod/z")).toBe(false);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/ab.md"] });
	});

	it("moving a hidden file OUT of its module drops the entry instead of leaving it pointing outside", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/a.md"] }, ["Mod/a.md"], ["Mod", "Other"]);
		const file = rig.app.vault.getAbstractFileByPath("Mod/a.md") as TFile;
		await rig.app.fileManager.renameFile(file, "Other/a.md");
		rig.plugin.onVaultRenameEvent(file, "Mod/a.md");
		expect(rig.index.getHiddenModuleItems()).toEqual({});
	});

	it("child-before-parent: Mod/a.md -> Mod2/a.md arriving before Mod -> Mod2 keeps the hidden entry and re-keys it", () => {
		// The vault as it is when the events fire: the rename is already done, so only Mod2 exists.
		const rig = rigWithEvents({ Mod: ["Mod/a.md", "Mod/sub/b.md"], Other: ["Other/z.md"] }, ["Mod2/a.md", "Mod2/sub/b.md", "Other/z.md"], ["Mod2", "Mod2/sub", "Other"]);
		const a = rig.app.vault.getAbstractFileByPath("Mod2/a.md") as TFile;
		const b = rig.app.vault.getAbstractFileByPath("Mod2/sub/b.md") as TFile;
		rig.plugin.onVaultRenameEvent(a, "Mod/a.md");
		rig.plugin.onVaultRenameEvent(b, "Mod/sub/b.md");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod2/a.md", "Mod2/sub/b.md"], Other: ["Other/z.md"] });
		rig.plugin.onVaultRenameEvent(rig.app.vault.getAbstractFileByPath("Mod2") as TFolder, "Mod");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod2: ["Mod2/a.md", "Mod2/sub/b.md"], Other: ["Other/z.md"] });
		expect(rig.persistDebounced).toHaveBeenCalled();
	});

	it("deleting a hidden file prunes its entry (and the module's key once empty) and persists", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/a.md"], Keep: ["Keep/x.md"] }, ["Mod/a.md", "Keep/x.md"], ["Mod", "Keep"]);
		const file = rig.app.vault.getAbstractFileByPath("Mod/a.md") as TFile;
		await rig.app.vault.delete(file);
		rig.plugin.onVaultDeleteEvent(file);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Keep: ["Keep/x.md"] });
		expect(rig.persistDebounced).toHaveBeenCalled();
	});

	it("deleting a folder prunes every entry beneath it; deleting the module drops its whole key", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/sub", "Mod/sub/c.md", "Mod/keep.md"] }, ["Mod/sub/c.md", "Mod/keep.md"], ["Mod", "Mod/sub"]);
		const sub = rig.app.vault.getAbstractFileByPath("Mod/sub") as TFolder;
		await rig.app.vault.delete(sub, true);
		rig.plugin.onVaultDeleteEvent(sub);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/keep.md"] });

		const mod = rig.app.vault.getAbstractFileByPath("Mod") as TFolder;
		await rig.app.vault.delete(mod, true);
		rig.plugin.onVaultDeleteEvent(mod);
		expect(rig.index.getHiddenModuleItems()).toEqual({});
	});

	it("deleting an unrelated file changes nothing and does not trigger a save", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/a.md"] }, ["Mod/a.md", "Other/z.md"], ["Mod", "Other"]);
		const file = rig.app.vault.getAbstractFileByPath("Other/z.md") as TFile;
		await rig.app.vault.delete(file);
		rig.plugin.onVaultDeleteEvent(file);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
		expect(rig.persistDebounced).not.toHaveBeenCalled();
	});

	it("a shell mv (delete then create) is the known limit: the entry is pruned on the delete, not migrated", async () => {
		const rig = rigWithEvents({ Mod: ["Mod/a.md"] }, ["Mod/a.md"], ["Mod"]);
		const file = rig.app.vault.getAbstractFileByPath("Mod/a.md") as TFile;
		await rig.app.vault.delete(file);
		rig.plugin.onVaultDeleteEvent(file);
		expect(rig.index.getHiddenModuleItems()).toEqual({});
	});
});
