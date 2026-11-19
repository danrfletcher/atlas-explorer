import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import AtlasPlugin from "../../src/main";
import { openBacklinkRow, TephraBacklinksSection } from "../../src/backlinks-section";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { setPromotedRoots } from "../../src/source-links";
import { seedRoot } from "../helpers";

// PR-12 (T11/T12, GP8): the Backlinks panel of `registry.rs` across a promote and a Return to parent. Obsidian in the
// container cannot open a `.rs` file in a tab, so the live run could not show this panel; this drives the real
// `TephraBacklinksSection` (the panel's controller, in jsdom) and the real `AtlasPlugin.onPromotedRootsChanged`
// (what runs when Tephra's source list gains or loses a promoted root) with a fake Tephra that answers per id.

const REGISTRY = "Sources/tephra/crates/tephrad/src/registry.rs";
const SCAN = "Sources/tephra/crates/tephrad/src/scan.rs";
const NOTE = "Weekly Review.md";
const TEPHRAD = { name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad", absRoot: "/home/user/Developer/Tephra/crates/tephrad" };

const edge = (from: string, to: string, line: number | null) => ({ from, to: { resolved: to }, to_raw: to, kind: "wikilink", offline: false, line });

/** Tephra's answers, as its graph reads before the promote, after it, and after the return. The vault note links the
 * block; `scan.rs` (a code file, so Obsidian's own Backlinks never lists it) links the file at line 41. */
const BEFORE_ID = "@tephra:crates/tephrad/src/registry.rs";
const AFTER_ID = "@tephrad:src/registry.rs";
const answers: Record<string, unknown[]> = {
	[BEFORE_ID]: [edge("@notes:Weekly Review.md", BEFORE_ID, 2), edge("@tephra:crates/tephrad/src/scan.rs", BEFORE_ID, 41)],
	[AFTER_ID]: [edge("@notes:Weekly Review.md", AFTER_ID, 2), edge("@tephrad:src/scan.rs", AFTER_ID, 41)],
};

function setup() {
	const app = new App();
	seedRoot(app, [NOTE, REGISTRY, SCAN], ["Sources", "Sources/tephra", "Sources/tephra/crates", "Sources/tephra/crates/tephrad", "Sources/tephra/crates/tephrad/src"]);
	app.metadataCache.getFileCache = (() => ({})) as unknown as App["metadataCache"]["getFileCache"]; // Obsidian 1.14: `{}`, not null, for any file
	app.viewRegistry.typeByExtension.rs = "code-viewer"; // a code-file plugin is installed, so Obsidian opens `.rs` in a tab

	const containerEl = document.createElement("div");
	const pane = document.createElement("div");
	pane.className = "backlink-pane";
	pane.innerHTML = '<div class="tree-item">Linked mentions</div>';
	containerEl.appendChild(pane);
	document.body.appendChild(containerEl);

	let active: TFile | null = null;
	const opened: Array<{ file: string; state: unknown }> = [];
	const ws = app.workspace as unknown as Record<string, unknown>;
	ws.getActiveFile = () => active;
	ws.getLeavesOfType = (type: string) => (type === "backlink" ? [{ view: { containerEl } }] : []);
	ws.getLeaf = () => ({ openFile: async (file: TFile, state: unknown) => void opened.push({ file: file.path, state }) });

	const asked: string[] = [];
	const connection = {
		getSnapshot: () => ({ sources: [{ name: "tephra" }, { name: "tephrad" }] }),
		async call(method: string, params?: unknown) {
			const id = (params as { id: string }).id;
			asked.push(`${method} ${id}`);
			return { ok: true as const, result: answers[id] ?? [] };
		},
	};
	const section = new TephraBacklinksSection({
		app,
		isEnabled: () => true,
		getConnection: () => connection,
		includeCrossSourceNotes: () => false,
		open: (path, line, newTab) => void openBacklinkRow(app, path, line, newTab),
	});
	return {
		app,
		section,
		asked,
		opened,
		open: (path: string) => void (active = app.vault.getAbstractFileByPath(path) as TFile),
		rows: () => Array.from(document.querySelectorAll(".atlas-tephra-backlink-row")).map((r) => r.textContent),
		rowEls: () => Array.from(document.querySelectorAll<HTMLElement>(".atlas-tephra-backlink-row")),
	};
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
	document.body.innerHTML = "";
});
afterEach(() => {
	vi.restoreAllMocks();
	setPromotedRoots([]);
});

describe("GP8: Backlinks of registry.rs across a promote and a return", () => {
	it("asks Tephra for the id the roots give the file, and lists the same scan.rs:41 row each time", async () => {
		const t = setup();
		t.open(REGISTRY);

		t.section.refresh(true); // the GP8 starting state: `tephrad` is inside `tephra`
		await settle();
		expect(t.asked).toEqual([`graph.get_backlinks ${BEFORE_ID}`]);
		expect(t.rows()).toEqual([`${SCAN}:41`]); // the vault note is Obsidian's own list, so it is not repeated here

		setPromotedRoots([TEPHRAD]); // the promote
		t.section.refresh(true);
		await settle();
		expect(t.asked.at(-1)).toBe(`graph.get_backlinks ${AFTER_ID}`);
		expect(t.rows()).toEqual([`${SCAN}:41`]); // `@tephrad:src/scan.rs` is the same vault file as before

		setPromotedRoots([]); // Return to parent
		t.section.refresh(true);
		await settle();
		expect(t.asked.at(-1)).toBe(`graph.get_backlinks ${BEFORE_ID}`);
		expect(t.rows()).toEqual([`${SCAN}:41`]);
	});

	it("a row still opens scan.rs at line 41 after the promote", async () => {
		const t = setup();
		setPromotedRoots([TEPHRAD]);
		t.open(REGISTRY);
		t.section.refresh(true);
		await settle();
		t.rowEls()[0].click();
		await settle();
		expect(t.opened).toEqual([{ file: SCAN, state: { eState: { line: 40 } } }]);
	});
});

describe("the plugin's reaction to a promote or return", () => {
	it("onPromotedRootsChanged asks Tephra again for the open file under its new id (no graph:changed needed)", async () => {
		const t = setup();
		t.open(REGISTRY);
		t.section.refresh(true);
		await settle();
		expect(t.asked).toEqual([`graph.get_backlinks ${BEFORE_ID}`]);

		const plugin = Object.create(AtlasPlugin.prototype) as Record<string, unknown> & { settings: unknown; onPromotedRootsChanged(roots: unknown): void };
		plugin.settings = { ...DEFAULT_SETTINGS, tephraEnabled: true, tephraPromotedRoots: {} };
		plugin.flushSave = vi.fn(async () => {});
		plugin.tephraBacklinks = t.section;
		setPromotedRoots([TEPHRAD]); // what `bindPromotedRoots` has just done
		plugin.onPromotedRootsChanged([TEPHRAD]);
		await settle();

		expect(t.asked).toEqual([`graph.get_backlinks ${BEFORE_ID}`, `graph.get_backlinks ${AFTER_ID}`]);
		expect(t.rows()).toEqual([`${SCAN}:41`]);
		expect((plugin.settings as { tephraPromotedRoots: unknown }).tephraPromotedRoots).toEqual({ tephrad: { vaultPath: TEPHRAD.vaultPath, absRoot: TEPHRAD.absRoot } });

		setPromotedRoots([]);
		plugin.onPromotedRootsChanged([]);
		await settle();
		expect(t.asked.at(-1)).toBe(`graph.get_backlinks ${BEFORE_ID}`);
	});
});
