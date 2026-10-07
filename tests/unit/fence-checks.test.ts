import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "obsidian";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig } from "../../src/types";

/** F5: "Folder source introduces no new disk-moving behavior beyond the three existing named
 * exceptions (module-icon drop, block graduation, Create)" — none of which live in this PR's own
 * files. Combines a static source-text check (no disk-write API call anywhere in the Folder-source
 * code) with a behavioral one (actually driving the real reconcile/refresh/rename paths against the
 * mock `Vault`'s own `calls` tracker and confirming it never records a write). */

const root = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Obsidian's disk-mutating Vault/FileManager surface — anything matching this is a write. Plain
 * reads (`getAbstractFileByPath`, `getRoot`, `.children`, `.on(...)`) don't match. */
const DISK_WRITE_CALL = /\.(create|createFolder|createBinary|modify|modifyBinary|append|delete|trash|rename|copy)\s*\(|renameFile\s*\(|fileManager\s*\./;

function folderSourceSlice(file: string, startMarker: string, endMarker: string): string {
	const src = read(file);
	const start = src.indexOf(startMarker);
	expect(start, `${startMarker} not found in ${file}`).toBeGreaterThanOrEqual(0);
	const end = src.indexOf(endMarker, start + startMarker.length);
	expect(end, `${endMarker} not found after ${startMarker} in ${file}`).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe("F5 static check — Folder-source code touches no disk-write API", () => {
	it("src/folder-source.ts (the reconcile/build module) has no disk-write call anywhere", () => {
		expect(read("src/folder-source.ts")).not.toMatch(DISK_WRITE_CALL);
	});

	it("ViewsManager.setFolderSource has no disk-write call", () => {
		const body = folderSourceSlice("src/views.ts", "setFolderSource(viewId: string", "\n\t}");
		expect(body).not.toMatch(DISK_WRITE_CALL);
	});

	it("ViewsManager.refreshFolderSource has no disk-write call", () => {
		const body = folderSourceSlice("src/views.ts", "refreshFolderSource(viewId: string", "\n\t}");
		expect(body).not.toMatch(DISK_WRITE_CALL);
	});

	it("canSave()'s Folder-source branch has no disk-write call", () => {
		const body = folderSourceSlice("src/api-source-modal.ts", "private canSave(): boolean {", "\n\t\t}\n\t\tif (this.selectedType !== \"api\")");
		expect(body).not.toMatch(DISK_WRITE_CALL);
	});

	it("save()'s Folder-source branch has no disk-write call", () => {
		const body = folderSourceSlice("src/api-source-modal.ts", "private save(): void {", "// canSave() above guarantees selectedType");
		expect(body).not.toMatch(DISK_WRITE_CALL);
	});

	it("AtlasExplorerView.refreshFolderSource (the render-side wrapper) has no disk-write call", () => {
		const body = folderSourceSlice("src/explorer-view.ts", "private refreshFolderSource(view: View", "\n\t}");
		expect(body).not.toMatch(DISK_WRITE_CALL);
	});
});

describe("F5 behavioral check — driving the real Folder-source paths never records a Vault write", () => {
	function source(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
		return { location: "inside", path: "Projects", showFiles: true, showFolders: true, ...overrides };
	}

	it("setFolderSource -> refreshFolderSource -> onVaultRename leaves vault.calls empty", () => {
		const app = new MockApp();
		app.vault.seedFolder("Projects");
		app.vault.seedFile("Projects/a.md");
		app.vault.seedFolder("Projects/Sub");

		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;

		vm.setFolderSource(view.id, folder.id, source());
		vm.refreshFolderSource(view.id, folder.id);
		vm.onVaultRename("Projects", "Renamed");
		vm.refreshFolderSource(view.id, folder.id);

		expect(app.vault.calls).toEqual([]);
	});

	it("refreshing against a missing target folder (the E1/G16 fallback path) also records no write", () => {
		const app = new MockApp();
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;

		vm.setFolderSource(view.id, folder.id, source({ path: "Does/Not/Exist" }));
		vm.refreshFolderSource(view.id, folder.id);

		expect(app.vault.calls).toEqual([]);
	});
});
