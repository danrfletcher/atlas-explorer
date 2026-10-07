import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";

/** PR-1.F2 integration, E4: a note deleted while it is hidden or "filtered out" follows the mode's
 * existing delete rule, unchanged by the filter. Merge keeps a "not found, last seen" placeholder,
 * append keeps the row as a placeholder, and overwrite removes it. The file is really removed from the
 * vault, and the plugin's delete handler (`onVaultDelete`) runs on it, as it does in Obsidian. */

type CacheEntry = { frontmatter?: Record<string, unknown> } | null;
type Mode = FolderSourceConfig["mode"];
type Cause = "hidden-at-save" | "live-drop-out";

const RULES: YamlFilterRule[] = [{ key: "status", value: "active" }];

function source(mode: Mode, rules?: YamlFilterRule[]): FolderSourceConfig {
	return {
		type: "folder",
		location: "inside",
		path: "Jobs",
		showFiles: true,
		showFolders: false,
		mode,
		...(rules ? { filters: { files: { yaml: { rules } } } } : {}),
	};
}

async function setup(mode: Mode, cause: Cause) {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	const cache = new Map<string, CacheEntry>([
		["Jobs/acme.md", { frontmatter: { status: "active" } }],
		["Jobs/beta.md", { frontmatter: { status: "done" } }],
	]);
	for (const path of cache.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => cache.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;

	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const viewId = vm.getViews()[0].id;
	const folder = vm.addMetaFolder(viewId, null, "Job search")!;
	vm.setFolderSource(viewId, folder.id, source(mode));
	vm.refreshFolderSource(viewId, folder.id);
	vm.onMetadataResolved();

	// The subject is beta (not matching) for a hidden-at-save row, and acme for a live drop-out.
	const subjectPath = cause === "hidden-at-save" ? "Jobs/beta.md" : "Jobs/acme.md";
	vm.setFolderSource(viewId, folder.id, source(mode, RULES));
	vm.onMetadataResolved();
	if (cause === "live-drop-out") {
		cache.set("Jobs/acme.md", { frontmatter: { status: "done" } });
		vm.onMetadataResolved();
	}

	const subject = () => vm.getNode(viewId, folder.id)!.children.find((c) => c.ref?.path === subjectPath);
	return { app, vm, viewId, folderId: folder.id, subjectPath, subject, cache };
}

/** Removes the subject's file from the vault, then runs the plugin's delete handler on it. */
async function deleteSubject(f: Awaited<ReturnType<typeof setup>>): Promise<void> {
	const file = f.app.vault.getAbstractFileByPath(f.subjectPath)!;
	await f.app.vault.delete(file);
	f.vm.onVaultDelete(f.subjectPath);
}

function placeholderFor(f: Awaited<ReturnType<typeof setup>>, label: string) {
	const folder = f.vm.getNode(f.viewId, f.folderId)!;
	return Object.values(folder.apiItemState ?? {}).find((item) => item.label === label);
}

describe("E4: deleting a hidden or filtered-out note follows the existing mode delete rule", () => {
	for (const cause of ["hidden-at-save", "live-drop-out"] as Cause[]) {
		const label = cause === "hidden-at-save" ? "beta" : "acme";

		it(`merge × ${cause}: the row becomes a "not found, last seen" placeholder`, async () => {
			const f = await setup("merge", cause);
			await deleteSubject(f);
			expect(f.subject()).toBeUndefined();
			const placeholder = placeholderFor(f, label);
			expect(placeholder?.notFound).toBe(true);
			expect(placeholder?.lastSeenAt).toEqual(expect.any(String));
		});

		it(`append × ${cause}: the row is kept as a placeholder`, async () => {
			const f = await setup("append", cause);
			expect(f.subject()).toBeDefined();
			await deleteSubject(f);
			expect(f.subject()).toBeUndefined();
			const placeholder = placeholderFor(f, label);
			expect(placeholder).toBeDefined();
			expect(placeholder?.notFound).toBeUndefined();
			// The placeholder's noteRef is cleared in the same call by the existing clear-noteRef mechanism.
			expect(placeholder?.noteRef).toBeUndefined();
		});

		it(`overwrite × ${cause}: the row is removed outright`, async () => {
			const f = await setup("overwrite", cause);
			await deleteSubject(f);
			expect(f.subject()).toBeUndefined();
			expect(placeholderFor(f, label)).toBeUndefined();
		});
	}

	it("F4: the delete writes no removedRefs in any mode, and the filter changes none of it", async () => {
		for (const mode of ["merge", "append", "overwrite"] as Mode[]) {
			const f = await setup(mode, "live-drop-out");
			await deleteSubject(f);
			const folder = f.vm.getNode(f.viewId, f.folderId)!;
			expect(folder.folderSource?.removedRefs ?? []).toEqual([]);
		}
	});

	it("a deleted note is not revived by a later refresh, because the file is gone from the vault", async () => {
		const f = await setup("merge", "hidden-at-save");
		await deleteSubject(f);
		f.vm.refreshFolderSource(f.viewId, f.folderId);
		expect(f.subject()).toBeUndefined();
	});
});

