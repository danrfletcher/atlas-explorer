import * as fs from "fs";
import { FolderLiveRefresh, FolderLiveRefreshTimers } from "./folder-live-refresh";

/** PR-2 (G6): quiet time after the last outside-folder event before a rescan. Finder copies and
 * renames fire several events in a row, so one rescan covers the whole burst. The shared debounce
 * (`FolderLiveRefresh`) also enforces a 2 s maximum wait, so a continuous stream still rescans. */
export const OUTSIDE_WATCH_DEBOUNCE_MS = 1000;

export type OutsideWatchListener = (eventType: string, filename: string | null) => void;

/** The slice of Node's `FSWatcher` this module uses. */
export interface OutsideWatcherLike {
	on(event: "error", listener: () => void): unknown;
	close(): void;
}

export type OutsideWatchFn = (path: string, listener: OutsideWatchListener) => OutsideWatcherLike;

/** G6: one non-recursive watch per folder — one OS handle whatever the file count, and nothing below
 * the folder's direct children is ever reported. This is the only `fs.watch` call in the plugin. */
const defaultWatch: OutsideWatchFn = (path, listener) => fs.watch(path, listener);

/** G6: dotfiles (`.DS_Store`, and `.obsidian` when the folder is an ancestor of the vault, E7) never
 * trigger a rescan. A `null` filename means the platform could not say which entry changed, so it
 * rescans to be safe (this is also how a Windows buffer overflow arrives). */
export function isIgnoredOutsideEvent(filename: string | null): boolean {
	return filename !== null && filename.startsWith(".");
}

interface OutsideWatchEntry {
	path: string;
	/** Every source (node id) on this folder. The watcher stays open while this is non-empty. */
	nodeIds: Set<string>;
	/** `null` while closed: never opened (unresolved path), failed (`fs.watch` threw or emitted
	 * `'error'`), or released. `retry()` reopens it. */
	watcher: OutsideWatcherLike | null;
}

export interface FolderSourceOutsideWatchersDeps {
	/** Real `fs.watch` by default; tests inject a mock. */
	watch?: OutsideWatchFn;
	/** Whether a device-local path currently resolves to a directory (see `resolveOutsidePath`). A
	 * blank or unresolved path is never opened. */
	isResolved: (path: string) => boolean;
	/** Called once per source (node id) whose folder changed. */
	onRescan: (nodeId: string) => void;
	timers?: FolderLiveRefreshTimers;
}

/** G9: one plugin-level registry, keyed by resolved outside path and reference-counted per source.
 * Two sources on the same folder share one watcher, and a change refreshes each of them once. Sources
 * are kept in step with the active view by `sync`, and `closeAll` runs from `onunload`. */
export class FolderSourceOutsideWatchers {
	private entries = new Map<string, OutsideWatchEntry>();
	private sourcePaths = new Map<string, string>();
	private debounce: FolderLiveRefresh;
	private watch: OutsideWatchFn;

	constructor(private deps: FolderSourceOutsideWatchersDeps) {
		this.watch = deps.watch ?? defaultWatch;
		this.debounce = new FolderLiveRefresh((path) => this.fire(path), deps.timers, OUTSIDE_WATCH_DEBOUNCE_MS);
	}

	/** Brings the registry in line with `sources` (node id → device-local path, possibly blank or
	 * unresolved). Sources that left are released; new ones are retained. */
	sync(sources: Map<string, string>): void {
		for (const [nodeId, path] of Array.from(this.sourcePaths)) {
			if (sources.get(nodeId) !== path) this.release(nodeId);
		}
		for (const [nodeId, path] of sources) {
			if (!this.sourcePaths.has(nodeId)) this.retain(nodeId, path);
		}
	}

	/** Reopens every closed watcher whose path resolves again. Called on window focus, which is the
	 * retry for a drive that was unplugged and has come back. */
	retry(): void {
		for (const entry of this.entries.values()) {
			if (entry.watcher === null) this.open(entry);
		}
	}

	/** Closes every watcher and drops every pending rescan. Idempotent. */
	closeAll(): void {
		for (const entry of this.entries.values()) {
			this.debounce.cancel(entry.path);
			this.close(entry);
		}
		this.entries.clear();
		this.sourcePaths.clear();
	}

	private retain(nodeId: string, path: string): void {
		let entry = this.entries.get(path);
		if (!entry) {
			entry = { path, nodeIds: new Set(), watcher: null };
			this.entries.set(path, entry);
			this.open(entry);
		}
		entry.nodeIds.add(nodeId);
		this.sourcePaths.set(nodeId, path);
	}

	private release(nodeId: string): void {
		const path = this.sourcePaths.get(nodeId);
		if (path === undefined) return;
		this.sourcePaths.delete(nodeId);
		const entry = this.entries.get(path);
		if (!entry) return;
		entry.nodeIds.delete(nodeId);
		if (entry.nodeIds.size > 0) return;
		this.debounce.cancel(path);
		this.close(entry);
		this.entries.delete(path);
	}

	private open(entry: OutsideWatchEntry): void {
		if (!this.deps.isResolved(entry.path)) return;
		try {
			const watcher = this.watch(entry.path, (eventType, filename) => {
				if (!isIgnoredOutsideEvent(filename)) this.debounce.schedule(entry.path);
				// G7: Linux emits no 'error' when the folder is removed, so a watcher on a path that no longer
				// resolves is closed here. The rescan above still reconciles the rows; focus retry reopens it.
				if (!this.deps.isResolved(entry.path) && entry.watcher === watcher) this.close(entry);
			});
			// G7: an `'error'` closes this handle. Focus retries it, and the rows stay as they are until then.
			watcher.on("error", () => {
				if (entry.watcher === watcher) this.close(entry);
			});
			entry.watcher = watcher;
		} catch {
			// A synchronous throw from `fs.watch` (e.g. the folder vanished between resolve and watch) is a failed watcher.
			entry.watcher = null;
		}
	}

	private close(entry: OutsideWatchEntry): void {
		const watcher = entry.watcher;
		if (!watcher) return;
		entry.watcher = null;
		watcher.close();
	}

	private fire(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		for (const nodeId of Array.from(entry.nodeIds)) this.deps.onRescan(nodeId);
	}
}
