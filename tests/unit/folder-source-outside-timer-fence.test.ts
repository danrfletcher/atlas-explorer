import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { listOutsideChildren, resolveOutsidePath } from "../../src/folder-source-outside";
import { FolderSourceOutsideWatchers, OUTSIDE_WATCH_DEBOUNCE_MS } from "../../src/folder-source-outside-watcher";
import { FOLDER_LIVE_REFRESH_MAX_WAIT_MS } from "../../src/folder-live-refresh";
import { FolderSourcePathStore } from "../../src/folder-source-path-store";
import { AtlasExplorerView } from "../../src/explorer-view";
import { buildFolderSourceChildren } from "../../src/folder-source";
import { View, ViewNode } from "../../src/types";
import { meta } from "../integration/create-from-meta-fixtures";

/** F4 (PR-2): the timer/watcher fence F10 is retired. Outside-Vault sources may now watch their folder,
 * but only through `fs.watch` in the one new watcher module, and only with the debounce timer the
 * watcher schedules. Everything else stays timer-free: path resolution, listing, the path store, the
 * reconcile, and the focus/view-load hooks, which may call the registry to retry but never schedule a
 * timer themselves. The static checks below enforce that. The behavioural half is the same
 * zero-timer check as before, with the watcher left out of it. */

const root = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** The one module allowed to call `fs.watch`. */
const WATCHER_MODULE = "src/folder-source-outside-watcher.ts";
/** The shared debounce the watcher reuses (PR-1 groundwork), the only other place a timer may be created. */
const DEBOUNCE_MODULE = "src/folder-live-refresh.ts";

const TIMER_CONSTRUCT = /\b(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|FileSystemWatcher|fs\.watch|fs\.watchFile|setImmediate)\b/;
const FS_WATCH_CALL = /\bfs\.watch\s*\(/;
// PR-2 R3 fix: the namespace-call sweep above only catches `fs.watch(...)` — a file that instead
// wrote `import { watch } from "fs"` and called `watch(...)` bare would never match it.
const FS_WATCH_NAMED_IMPORT = /import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["']node:fs["']|import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["']fs["']/;
const ALWAYS_FORBIDDEN = /\b(setInterval|FileSystemWatcher|watchFile)\b/;

function slice(file: string, startMarker: string, endMarker: string): string {
	const src = read(file);
	const start = src.indexOf(startMarker);
	expect(start, `${startMarker} not found in ${file}`).toBeGreaterThanOrEqual(0);
	const end = src.indexOf(endMarker, start + startMarker.length);
	expect(end, `${endMarker} not found after ${startMarker} in ${file}`).toBeGreaterThan(start);
	return src.slice(start, end);
}

const srcFiles = readdirSync(join(root, "src"))
	.filter((f) => f.endsWith(".ts"))
	.map((f) => `src/${f}`);

describe("F4 static sweep — fs.watch and timer constructs are confined to the watcher module", () => {
	it("setInterval, fs.watchFile and FileSystemWatcher appear nowhere in src", () => {
		for (const file of srcFiles) expect(read(file), file).not.toMatch(ALWAYS_FORBIDDEN);
	});

	it("fs.watch is called only from the new watcher module", () => {
		for (const file of srcFiles) {
			if (file === WATCHER_MODULE) continue;
			expect(read(file), file).not.toMatch(FS_WATCH_CALL);
		}
		expect(read(WATCHER_MODULE)).toMatch(FS_WATCH_CALL);
	});

	it("no file imports fs.watch by its bare named export, side-stepping the fs.watch( sweep above", () => {
		for (const file of srcFiles) {
			if (file === WATCHER_MODULE) continue;
			expect(read(file), file).not.toMatch(FS_WATCH_NAMED_IMPORT);
		}
	});

	it("the watcher module's only timer is the shared debounce (no timer of its own)", () => {
		const src = read(WATCHER_MODULE);
		expect(src).not.toMatch(/\bsetTimeout\b/);
		expect(src).not.toMatch(/\bsetInterval\b/);
		expect(read(DEBOUNCE_MODULE)).toMatch(/\bsetTimeout\b/);
	});

	it("src/folder-source-outside.ts (path resolution + listing) is fully clean", () => {
		expect(read("src/folder-source-outside.ts")).not.toMatch(TIMER_CONSTRUCT);
	});

	it("src/folder-source-path-store.ts (device-local storage) is fully clean", () => {
		expect(read("src/folder-source-path-store.ts")).not.toMatch(TIMER_CONSTRUCT);
	});
});

describe("F4 static sweep — the Outside-Vault-specific additions to existing files have no timer/poll construct", () => {
	it("folder-source.ts's buildOutsideFolderChildren (E8 reconciliation) is clean", () => {
		const body = slice("src/folder-source.ts", "function buildOutsideFolderChildren(", "\n/** G16/E1:");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("folder-source.ts's diffOutsideChildren (rename detection) is clean", () => {
		const body = slice("src/folder-source.ts", "export function diffOutsideChildren(", "\n/** PR-1 (G5)");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("views.ts's refreshFolderSource (the outsidePath-aware reconcile call site) is clean", () => {
		const body = slice("src/views.ts", "refreshFolderSource(viewId: string", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("views.ts's reconcileOutsideChildChanges (outside delete and rename) is clean", () => {
		const body = slice("src/views.ts", "private reconcileOutsideChildChanges(", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("views.ts's collectOutsideFolderSourceNodeIdPairs (duplicate-node path copying) is clean", () => {
		const body = slice("src/views.ts", "export function collectOutsideFolderSourceNodeIdPairs(", "\n}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("explorer-view.ts's refreshApiSourcesOnViewLoad (recheck-on-load, including the Outside-mandatory branch) is clean", () => {
		const body = slice("src/explorer-view.ts", "private refreshApiSourcesOnViewLoad(): void {", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("explorer-view.ts's refreshOutsideFolderSourcesOnFocus (recheck and registry retry on focus-regain) is clean", () => {
		const body = slice("src/explorer-view.ts", "private refreshOutsideFolderSourcesOnFocus(): void {", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("explorer-view.ts's renderNode (the row-level indicator dot plus drag/nest/rename gating) is clean", () => {
		const body = slice("src/explorer-view.ts", "private async renderNode(node: ViewNode", "\n\t// --- inbox");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("api-source-modal.ts's renderOutsidePathField (the modal's own live indicator) is clean", () => {
		const body = slice("src/api-source-modal.ts", "private renderOutsidePathField(contentEl: HTMLElement): void {", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});
});

describe("F4 behavioural check — driving every Outside-Vault connection-check path never schedules a timer", () => {
	let tmpDir: string;
	let setIntervalSpy: ReturnType<typeof vi.spyOn>;
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-timer-fence-"));
		setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		setIntervalSpy.mockRestore();
		setTimeoutSpy.mockRestore();
	});

	it("resolveOutsidePath and listOutsideChildren never schedule a timer", () => {
		resolveOutsidePath(tmpDir);
		resolveOutsidePath("/definitely/does/not/exist");
		listOutsideChildren(tmpDir, { showFiles: true, showFolders: true });

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("FolderSourcePathStore get/set/delete never schedule a timer", () => {
		const store = new FolderSourcePathStore({
			loadLocalStorage: vi.fn(() => null),
			saveLocalStorage: vi.fn(),
		});
		store.set("node-a", tmpDir);
		store.get("node-a");
		store.delete("node-a");

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("buildFolderSourceChildren's Outside-Vault branch never schedules a timer, resolved or unresolved", () => {
		const source = { location: "outside" as const, path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false };
		buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source, [], (ref) => ({ id: "x", type: "unit", ref, children: [] }), undefined, tmpDir);
		buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source, [], (ref) => ({ id: "x", type: "unit", ref, children: [] }), undefined, "/nowhere");

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("refreshOutsideFolderSourcesOnFocus (the real focus-regain handler) never schedules a timer", () => {
		const outside = meta("outside-x", "Folder");
		outside.folderSource = { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false };
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [outside] };
		const proto = AtlasExplorerView.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
		const fake = {
			plugin: {
				viewsManager: { getActiveView: () => view, refreshFolderSource: vi.fn() },
				folderSourcePathStore: { get: vi.fn(() => tmpDir) },
				outsideFolderWatchers: { retry: vi.fn() },
			},
			collectFolderSourceNodes: proto.collectFolderSourceNodes,
			refreshFolderSource: proto.refreshFolderSource,
			render: vi.fn(),
		};

		proto.refreshOutsideFolderSourcesOnFocus.call(fake as unknown as Record<string, unknown>);

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("resolving a node that doesn't exist on disk still never schedules a retry timer (no backoff/poll-until-found behavior)", () => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		const result = resolveOutsidePath(tmpDir);

		expect(result).toBe(false);
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});
});

describe("F4 behavioural check — the watcher schedules only the debounce setTimeout", () => {
	let setIntervalSpy: ReturnType<typeof vi.spyOn>;
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
	let registry: FolderSourceOutsideWatchers | undefined;

	beforeEach(() => {
		setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});

	afterEach(() => {
		registry?.closeAll();
		registry = undefined;
		setIntervalSpy.mockRestore();
		setTimeoutSpy.mockRestore();
	});

	it("opening and retrying a watcher schedules no timer; one event schedules only the debounce and max-wait pair", () => {
		const listeners: ((eventType: string, filename: string | null) => void)[] = [];
		registry = new FolderSourceOutsideWatchers({
			watch: (_path, listener) => {
				listeners.push(listener);
				return Object.assign(new EventEmitter(), { close: vi.fn() });
			},
			isResolved: () => true,
			onRescan: vi.fn(),
		});

		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		registry.retry();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();

		listeners[0]("rename", "new.pdf");
		expect(setIntervalSpy).not.toHaveBeenCalled();
		const delays = setTimeoutSpy.mock.calls.map((call) => call[1]).sort((a, b) => a - b);
		expect(delays).toEqual([OUTSIDE_WATCH_DEBOUNCE_MS, FOLDER_LIVE_REFRESH_MAX_WAIT_MS]);
	});

	it("releasing the watcher schedules no further timer", () => {
		registry = new FolderSourceOutsideWatchers({
			watch: () => Object.assign(new EventEmitter(), { close: vi.fn() }),
			isResolved: () => true,
			onRescan: vi.fn(),
		});
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		const scheduledBeforeClose = setTimeoutSpy.mock.calls.length;

		registry.closeAll();
		expect(setTimeoutSpy).toHaveBeenCalledTimes(scheduledBeforeClose);
		expect(setIntervalSpy).not.toHaveBeenCalled();
	});
});
