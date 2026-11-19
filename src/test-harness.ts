import { TFile } from "obsidian";
import type AtlasPlugin from "./main";
import { NameDialogOptions, openNameDialog } from "./name-dialog";
import { noticeIfLinksNotUpdated } from "./links-notice";
import { DismissScope, UnitRef } from "./types";

/** Test-only handle for driving the PR-1 helpers from the desktop container over CDP. Registered
 * only when `__ATLAS_TEST__` is true (never in a production build). */
interface AtlasTestHarness {
	lastResult: string | null | undefined;
	openNameDialog(opts: NameDialogOptions): Promise<string | null>;
	convertFileNodesToModule(filePath: string, folderPath: string): { nodes: number; manualPromotions: number };
	replaceMetaNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean;
	noticeIfLinksNotUpdated(): boolean;
	scenarioMoveIntoModule(filePath: string, folder: string): Promise<{ nodes: number; manualPromotions: number }>;
	dump(): Promise<unknown>;
	/** Graduation state: pending records, and the reverts Atlas is still waiting to see. */
	graduationState(): { pending: number; ownReverts: string[] };
	/** Wraps `fileManager.renameFile` to count and log calls (`[path, newPath]`); returns a restore function. */
	spyRenameFile(): { calls: Array<[string, string]>; restore(): void };
	/** PR-2: drives the dismiss/added-state storage foundation directly, since this PR has no UI. */
	setDismissed(ref: UnitRef, scope: DismissScope, value: boolean, viewId?: string): Promise<void>;
	isDismissed(ref: UnitRef, scope: DismissScope, viewId?: string): boolean;
	markAdded(ref: UnitRef): Promise<void>;
	isAdded(ref: UnitRef): boolean;
}

export function registerTestHarness(plugin: AtlasPlugin): () => void {
	const { app } = plugin;
	const harness: AtlasTestHarness = {
		lastResult: undefined,
		async openNameDialog(opts) {
			harness.lastResult = undefined;
			const result = await openNameDialog(app, {
				poolFolder: plugin.settings.poolFolder,
				excludedFolders: plugin.settings.excludedFolders,
				...opts,
			});
			harness.lastResult = result;
			return result;
		},
		convertFileNodesToModule: (filePath, folderPath) => plugin.viewsManager.convertFileNodesToModule(filePath, folderPath, plugin.unitIndex),
		replaceMetaNodeWithUnit: (viewId, nodeId, ref) => plugin.viewsManager.replaceMetaNodeWithUnit(viewId, nodeId, ref),
		noticeIfLinksNotUpdated: () => noticeIfLinksNotUpdated(app, undefined, () => plugin.tephraActive()),
		async scenarioMoveIntoModule(filePath, folder) {
			const file = app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) throw new Error(`No file at ${filePath}`);
			await app.vault.createFolder(folder);
			await app.fileManager.renameFile(file, `${folder}/${folder}.md`);
			const counts = plugin.viewsManager.convertFileNodesToModule(filePath, folder, plugin.unitIndex);
			noticeIfLinksNotUpdated(app, undefined, () => plugin.tephraActive());
			return counts;
		},
		graduationState: () => ({ pending: plugin.graduation.pendingCount(), ownReverts: [...plugin.graduation.getOwnReverts()] }),
		spyRenameFile() {
			const calls: Array<[string, string]> = [];
			const original = app.fileManager.renameFile;
			app.fileManager.renameFile = function (this: unknown, file, newPath) {
				calls.push([file.path, newPath]);
				return original.call(app.fileManager, file, newPath);
			};
			return {
				calls,
				restore() {
					app.fileManager.renameFile = original;
				},
			};
		},
		async setDismissed(ref, scope, value, viewId) {
			if (scope === "global") plugin.unitIndex.setDismissed(ref, "global", value);
			else plugin.unitIndex.setDismissed(ref, "view", value, viewId ?? "");
			await plugin.flushSave();
		},
		isDismissed: (ref, scope, viewId) =>
			scope === "global" ? plugin.unitIndex.isDismissed(ref, "global") : plugin.unitIndex.isDismissed(ref, "view", viewId ?? ""),
		async markAdded(ref) {
			plugin.unitIndex.markAdded(ref);
			await plugin.flushSave();
		},
		isAdded: (ref) => plugin.unitIndex.isAdded(ref),
		async dump() {
			await new Promise((resolve) => window.setTimeout(resolve, 600)); // let the debounced save land
			return {
				views: plugin.viewsManager.getViews(),
				manualPromotions: plugin.unitIndex.getManualPromotions(),
				data: await plugin.loadData(),
			};
		},
	};
	(window as unknown as { __atlasTest?: AtlasTestHarness }).__atlasTest = harness;
	return () => {
		delete (window as unknown as { __atlasTest?: AtlasTestHarness }).__atlasTest;
	};
}
