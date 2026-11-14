import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Platform, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { StatusesManager } from "../../src/statuses";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { openBacklinkRow, TephraBacklinksSection } from "../../src/backlinks-section";
import { TephraConnection, type TephraConnectionClient } from "../../src/tephra-connection";
import type { TephraPushResult } from "../../src/tephra-client";
import { TephraGraphSync } from "../../src/tephra-graph-sync";
import { seedRoot } from "../helpers";

// F1 / F3: nothing source-related reaches `data.json` or any file. The real `AtlasPlugin.persistNow` is called before and
// after a graph sync (promotions from Tephra's edges), a section render and a row open, and the payloads are compared key
// by key and value by value.

const link = (name: string) => ({ link: name, original: `[[${name}]]`, displayText: name, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } });
const edge = (from: string, to: string, line: number | null = 3) => ({ from, to: { resolved: to }, to_raw: to, kind: "wikilink", offline: false, line });

const REGISTRY = "Sources/demo/crates/core/src/registry.rs";
const SETUP = "Sources/demo/docs/guide/Setup.md";
const BUILD = "Sources/demo/scripts/build.sh";
const FILES = ["Home.md", "Weekly Review.md", REGISTRY, SETUP, BUILD];
const FOLDERS = ["Sources", "Sources/demo", "Sources/demo/crates", "Sources/demo/crates/core", "Sources/demo/crates/core/src", "Sources/demo/docs", "Sources/demo/docs/guide", "Sources/demo/scripts"];

beforeEach(() => {
	Platform.isMobile = false;
	document.body.innerHTML = "";
	vi.useFakeTimers();
	vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("F1/F3: what Atlas persists does not change when Tephra's links are read, shown or opened", () => {
	it("persistNow writes the same keys and values after a graph sync, a section render and a row open", async () => {
		const app = new App();
		seedRoot(app, FILES, FOLDERS);
		app.viewRegistry.typeByExtension.sh = "vscode";
		let active: TFile | null = null;
		const caches: Record<string, CachedMetadata> = { "Weekly Review.md": { links: [link("Setup")] } as CachedMetadata };
		const noCache = new Set([REGISTRY, BUILD]);
		app.metadataCache.getFileCache = ((file: TFile) => caches[file.path] ?? (noCache.has(file.path) && file.path.endsWith(".md") ? null : {})) as App["metadataCache"]["getFileCache"];
		app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => (linkpath === "Setup" ? app.vault.getAbstractFileByPath(SETUP) : null)) as App["metadataCache"]["getFirstLinkpathDest"];

		const settings = { ...DEFAULT_SETTINGS, tephraEnabled: true };
		const unitIndex = new UnitIndex(app, settings, []);
		unitIndex.rebuild();

		// The real persist, with `saveData` captured. `Object.create` skips the constructor, as main-persistence.test.ts does.
		const saved: string[] = [];
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		Object.assign(plugin, {
			settings,
			unitIndex,
			viewsManager: new ViewsManager(app, [], "default", () => undefined),
			statusesManager: new StatusesManager([], [], () => undefined),
			expandedModuleFolders: new Set<string>(),
			saveData: async (data: unknown) => void saved.push(JSON.stringify(data)),
		});
		const persist = () => (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

		await persist();
		const writesBefore = app.vault.calls.length;

		// Tephra: one fake client serving both calls the feature makes.
		const calls: string[] = [];
		const client: TephraConnectionClient = {
			listSources: async () => ({ ok: true, sources: [{ name: "demo", path: "/d", status: "online" }] }),
			call: async (method, params) => {
				calls.push(method);
				if (method === "graph.get_edges") return { ok: true, result: [edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md"), edge("@demo:scripts/build.sh", "@demo:crates/core/src/registry.rs", 12)] };
				if (method === "graph.get_backlinks" && (params as { id: string }).id === "@demo:crates/core/src/registry.rs") return { ok: true, result: [edge("@demo:scripts/build.sh", "@demo:crates/core/src/registry.rs", 12)] };
				return { ok: true, result: [] };
			},
			openPush: (): Promise<TephraPushResult> => Promise.resolve({ ok: true, handle: { close() {} } }),
		};
		const connection = new TephraConnection(client);
		const sync = new TephraGraphSync({ setEdges: (edges) => unitIndex.setTephraEdges(edges), clearEdges: () => unitIndex.clearTephraEdges(), afterRefresh: () => undefined });
		sync.bind(connection);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toContain("graph.get_edges");
		const promoted = unitIndex.getUnits().filter((u) => u.path.startsWith("Sources/demo/") && u.type.startsWith("promoted"));
		expect(promoted.length).toBeGreaterThan(0); // the sync really changed what the index holds in memory

		// The section in a fake Backlinks panel, then a click on its row.
		const containerEl = document.createElement("div");
		const pane = document.createElement("div");
		pane.className = "backlink-pane";
		containerEl.appendChild(pane);
		document.body.appendChild(containerEl);
		const opened: Array<{ file: string; state: unknown }> = [];
		const ws = app.workspace as unknown as Record<string, unknown>;
		ws.getActiveFile = () => active;
		ws.getLeavesOfType = (type: string) => (type === "backlink" ? [{ view: { containerEl } }] : []);
		ws.getLeaf = () => ({ openFile: async (file: TFile, state: unknown) => void opened.push({ file: file.path, state }) });
		const section = new TephraBacklinksSection({
			app,
			isEnabled: () => true,
			getConnection: () => connection,
			includeCrossSourceNotes: () => false,
			open: (path, line, newTab) => void openBacklinkRow(app, path, line, newTab),
		});
		active = app.vault.getAbstractFileByPath(REGISTRY) as TFile;
		section.refresh(true);
		await vi.advanceTimersByTimeAsync(0);
		const row = document.querySelector<HTMLElement>(".atlas-tephra-backlink-row");
		expect(row?.textContent).toBe(`${BUILD}:12`);
		row!.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(opened.map((o) => o.file)).toEqual([BUILD]);

		await persist();
		expect(saved).toHaveLength(2);
		expect(Object.keys(JSON.parse(saved[1])).sort()).toEqual(Object.keys(JSON.parse(saved[0])).sort());
		expect(saved[1]).toBe(saved[0]); // every value too: no promotion, edge, row or source path was written
		expect(saved[1]).not.toContain("build.sh");
		expect(saved[1]).not.toContain("registry.rs");
		expect(JSON.parse(saved[1]).manualPromotions).toEqual([]);
		expect(app.vault.calls).toHaveLength(writesBefore); // and no vault file was created or modified
		section.detach();
		sync.unbind(false);
	});
});
