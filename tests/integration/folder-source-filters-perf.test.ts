import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig } from "../../src/types";

/** E8: evaluating a large folder with a rule reads `metadataCache.getFileCache` only. No vault read
 * (`read`/`cachedRead`) may happen. There is deliberately no wall-clock threshold. */
describe("E8: a large folder is evaluated from metadataCache only", () => {
	it("makes zero vault read or cachedRead calls for several thousand files", () => {
		const app = new MockApp();
		app.vault.seedFolder("Jobs");
		const total = 3000;
		const cache = new Map<string, { frontmatter: Record<string, unknown> }>();
		for (let i = 0; i < total; i++) {
			const path = `Jobs/job-${i}.md`;
			app.vault.seedFile(path);
			cache.set(path, { frontmatter: { status: i % 2 === 0 ? "active" : "done" } });
		}

		const lookups = vi.fn((file: TFile) => cache.get(file.path) ?? null);
		app.metadataCache.getFileCache = lookups as unknown as typeof app.metadataCache.getFileCache;
		const readSpy = vi.spyOn(app.vault, "read");
		const cachedReadSpy = vi.spyOn(app.vault, "cachedRead");

		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const viewId = vm.getViews()[0].id;
		const folder = vm.addMetaFolder(viewId, null, "Job search")!;
		const source: FolderSourceConfig = {
			type: "folder",
			location: "inside",
			path: "Jobs",
			showFiles: true,
			showFolders: false,
			mode: "merge",
			filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } },
		};
		vm.setFolderSource(viewId, folder.id, source);
		vm.onMetadataResolved();

		const rows = vm.getViews()[0].root.find((n) => n.id === folder.id)!.children;
		expect(rows).toHaveLength(total / 2);
		expect(lookups.mock.calls.length).toBeGreaterThanOrEqual(total);
		expect(readSpy).not.toHaveBeenCalled();
		expect(cachedReadSpy).not.toHaveBeenCalled();
	});
});
