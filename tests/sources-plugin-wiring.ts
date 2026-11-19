/** The real `AtlasPlugin` vault-event handlers (`onVaultDeleteEvent`, `onVaultCreateEvent`) wired to a real
 * `ViewsManager`, `UnitIndex`, `ExternalMoveDetector` and the given `SourceDeleteClassifier`, over the shared
 * Obsidian mock, plus what a test needs to see of the sources that must NOT run for a delete Atlas caused. It
 * is the same wiring `sources-folder.test.ts` builds for itself. Not a `*.test.ts` file, so vitest's glob skips it. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { App as ObsidianApp } from "obsidian";
import type { App } from "./mocks/obsidian";
import AtlasPlugin from "../src/main";
import { ExternalMoveDetector } from "../src/external-move";
import { FolderLiveRefresh } from "../src/folder-live-refresh";
import type { AtlasSettings } from "../src/settings";
import type { SourceDeleteClassifier } from "../src/source-delete-classifier";
import { UnitIndex } from "../src/unit-index";
import { ViewsManager } from "../src/views";

export function wirePluginVaultEvents(app: App, settings: AtlasSettings, classifier: SourceDeleteClassifier) {
	const p = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const viewsManager = new ViewsManager(app as unknown as ObsidianApp, [], "", () => {});
	const unitIndex = new UnitIndex(app as unknown as ObsidianApp, settings, []);
	const externalMoveDetector = new ExternalMoveDetector();
	/** Paths `graduation.handleDelete` was called with: it must stay empty for a delete Atlas caused. */
	const graduationDeletes: string[] = [];
	/** The old paths `onVaultRenameEvent` was called with: a delete-and-create pair taken for a move lands here. */
	const renames: string[] = [];
	Object.assign(p, {
		app,
		settings,
		viewsManager,
		unitIndex,
		sourceDeleteClassifier: classifier,
		graduation: { handleDelete: (f: { path: string }) => graduationDeletes.push(f.path) },
		externalMoveDetector,
		folderLiveRefresh: new FolderLiveRefresh(() => {}),
		persistDebounced: Object.assign(() => {}, { cancel: () => {}, run: () => {} }),
	});
	(p as unknown as { onVaultRenameEvent: (f: unknown, old: string) => void }).onVaultRenameEvent = (_f, old) => void renames.push(old);
	app.vault.on("delete", (file: unknown) => p.onVaultDeleteEvent(file as never));
	app.vault.on("create", (file: unknown) => p.onVaultCreateEvent(file as never));
	return { p, viewsManager, unitIndex, externalMoveDetector, graduationDeletes, renames };
}

interface VaultInternals {
	emit(name: "create" | "delete", ...args: unknown[]): void;
	unlink(entry: unknown): void;
	getAbstractFileByPath(path: string): { path: string } | null;
	getAllLoadedFiles(): { path: string }[];
	seedFile(path: string): unknown;
	seedFolder(path: string): unknown;
}

/** Every path under `dir` that Obsidian would index (links followed, dot entries skipped), as vault paths. */
function diskPaths(dir: string, rel = ""): Map<string, "file" | "folder"> {
	const out = new Map<string, "file" | "folder">();
	for (const name of readdirSync(join(dir, rel)).sort()) {
		if (name.startsWith(".")) continue;
		const path = rel === "" ? name : `${rel}/${name}`;
		let stat;
		try {
			stat = statSync(join(dir, path)); // follows a link: a dangling one is skipped, as Obsidian does
		} catch {
			continue;
		}
		out.set(path, stat.isDirectory() ? "folder" : "file");
		if (stat.isDirectory()) for (const [child, kind] of diskPaths(dir, path)) out.set(child, kind);
	}
	return out;
}

/**
 * What Obsidian's file watcher does, for the mock vault: compares the vault folder on disk (symlinks followed)
 * with the vault index, then reports every new path as a `create` event (parents first) and every vanished one
 * as a `delete` event (children first). It uses the mock's own event plumbing, never `vault.delete`, so a test
 * can spy on the vault API Atlas must not call and still see Obsidian's events arrive.
 */
export function indexLikeObsidian(app: App, vaultDir: string): { created: string[]; deleted: string[] } {
	const vault = app.vault as unknown as VaultInternals;
	const onDisk = diskPaths(vaultDir);
	const created: string[] = [];
	const deleted: string[] = [];
	for (const [path, kind] of [...onDisk].sort((a, b) => a[0].split("/").length - b[0].split("/").length)) {
		if (vault.getAbstractFileByPath(path)) continue;
		const entry = kind === "folder" ? vault.seedFolder(path) : vault.seedFile(path);
		vault.emit("create", entry);
		created.push(path);
	}
	const gone = vault
		.getAllLoadedFiles()
		.filter((entry) => entry.path !== "/" && !onDisk.has(entry.path))
		.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
	for (const entry of gone) {
		vault.unlink(entry);
		vault.emit("delete", entry);
		deleted.push(entry.path);
	}
	return { created, deleted };
}
