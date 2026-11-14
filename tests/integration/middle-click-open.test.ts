import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { createEmptyView } from "../../src/types";
import type { UnitRef, ViewNode } from "../../src/types";

/** Middle-click end to end against the obsidian mock: the REAL `renderNode` / `renderInboxRow`, the REAL
 * `openRef`, the REAL `findInterfaceNote`, and the REAL `updateActiveHighlight`. Only the workspace is a
 * recording fake (the mock App has no `getLeaf` / `openLinkText`). */

interface FakeLeaf {
	opened: TFile | null;
	openFile: ReturnType<typeof vi.fn>;
}

function makeWorkspace(vault: App["vault"]) {
	const leaves: FakeLeaf[] = [];
	let activeFile: TFile | null = null;
	const newLeaf = (): FakeLeaf => {
		const leaf: FakeLeaf = { opened: null, openFile: vi.fn() };
		leaf.openFile = vi.fn(async (file: TFile) => {
			leaf.opened = file;
			activeFile = file; // a new tab takes focus: the active file is now the opened one
		});
		leaves.push(leaf);
		return leaf;
	};
	const currentLeaf = newLeaf();
	const workspace = {
		leaves,
		currentLeaf,
		getLeaf: vi.fn((newTab?: boolean) => (newTab ? newLeaf() : currentLeaf)),
		openLinkText: vi.fn(async (_link: string, _source: string, _newLeaf?: boolean) => {}),
		getActiveFile: () => activeFile,
		setActiveFile: (path: string) => {
			activeFile = vault.getAbstractFileByPath(path) as TFile;
		},
		on: vi.fn(() => ({})),
		getLeavesOfType: () => [],
		onLayoutReady: (cb: () => void) => cb(),
	};
	return workspace;
}

const file: UnitRef = { kind: "file", path: "Projects/Boat.md" };
const ideas: UnitRef = { kind: "file", path: "Notes/Ideas.md" };
const block: UnitRef = { kind: "block", path: "_pool/20260101000000-abcd.md", subpath: "^abcd" };
const withNote: UnitRef = { kind: "folder", path: "Modules/WithNote" };
const noNote: UnitRef = { kind: "folder", path: "Modules/NoNote" };

type Proto = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as Proto;

function setup() {
	const app = new App();
	const v = app.vault;
	for (const dir of ["Projects", "Notes", "Daily", "_pool", "Modules", "Modules/WithNote", "Modules/NoNote"]) v.seedFolder(dir);
	for (const f of ["Projects/Boat.md", "Notes/Ideas.md", "Daily/2026-10-26.md", "_pool/20260101000000-abcd.md", "Modules/WithNote/WithNote.md"]) v.seedFile(f);
	const workspace = makeWorkspace(v);
	(app as unknown as { workspace: unknown }).workspace = workspace;
	workspace.setActiveFile("Daily/2026-10-26.md");

	const settings = { ...DEFAULT_SETTINGS };
	const plugin = {
		app,
		settings,
		unitIndex: new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []),
		viewsManager: { managedRowFilterState: () => "shown" },
		flushSave: vi.fn(async () => {}),
	};
	const explorer = new AtlasExplorerView({} as WorkspaceLeaf, plugin as never);
	const host = document.createElement("div");
	host.appendChild(document.createElement("div")); // view header
	const content = host.appendChild(document.createElement("div")); // view content
	document.body.appendChild(host);
	(explorer as unknown as { containerEl: HTMLElement }).containerEl = host;
	Object.assign(explorer, {
		isOutsideManagedUnit: () => false,
		matchesFilter: () => true,
		renderRowIcon: () => {},
		wireModuleRow: () => {},
		setPlacementTooltip: () => {},
		makeDropZone: () => {},
		renderFoldableChildren: async () => {},
	});
	const e = explorer as unknown as Record<string, unknown> & { selectedBucketNodeIds: Set<string>; selectedInboxRefKeys: Set<string> };
	return { app, workspace, explorer: e, content, plugin };
}
type Ctx = ReturnType<typeof setup>;

const view = createEmptyView("v1", "Default");
let nodeSeq = 0;

async function bucketRow(ctx: Ctx, ref: UnitRef, text: string, missing = false): Promise<HTMLElement> {
	ctx.explorer.resolveRef = async () => ({ text, icon: "file", promoted: false, added: false, missing });
	const node = { id: `n${++nodeSeq}`, type: "unit", ref, children: [] } as ViewNode;
	await (proto.renderNode as unknown as (...a: unknown[]) => Promise<void>).call(ctx.explorer, node, ctx.content, view, 0, []);
	return ctx.content.lastElementChild as HTMLElement;
}

function inboxRow(ctx: Ctx, ref: UnitRef, text: string, missing = false): HTMLElement {
	(proto.renderInboxRow as unknown as (...a: unknown[]) => HTMLElement).call(ctx.explorer, ctx.content, ref, { text, icon: "file", promoted: false, added: false, missing }, view, false);
	return ctx.content.lastElementChild as HTMLElement;
}

const aux = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true, ...init }));
const label = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-row-text")!;
/** `openRef` is async and fire-and-forget from the listener; let its microtasks finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const highlight = (ctx: Ctx) => (proto.updateActiveHighlight as () => void).call(ctx.explorer);

let ctx: Ctx;
beforeEach(() => {
	ctx = setup();
	Notice.reset();
	ctx.app.vault.calls.length = 0;
});
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("middle-click opens in a fresh, focused tab (G1, G3, G11, GP1-GP5)", () => {
	it("G1/GP1/GP2: a bucket file row opens Projects/Boat.md in a new leaf; the daily note's leaf is untouched", async () => {
		const row = await bucketRow(ctx, file, "Boat");
		aux(label(row));
		await settle();
		expect(ctx.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		const opened = ctx.workspace.leaves.filter((l) => l.opened);
		expect(opened.map((l) => l.opened!.path)).toEqual(["Projects/Boat.md"]);
		expect(ctx.workspace.currentLeaf.openFile).not.toHaveBeenCalled();
		expect(ctx.workspace.getActiveFile()!.path).toBe("Projects/Boat.md");
	});

	it("GP4: an inbox file row opens Notes/Ideas.md in a new leaf", async () => {
		aux(label(inboxRow(ctx, ideas, "Ideas")));
		await settle();
		expect(ctx.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		expect(ctx.workspace.leaves.filter((l) => l.opened).map((l) => l.opened!.path)).toEqual(["Notes/Ideas.md"]);
	});

	it("G11/GP5: a second middle-click on a note that is already open makes a second, separate leaf", async () => {
		const row = await bucketRow(ctx, file, "Boat");
		aux(label(row));
		await settle();
		aux(label(row));
		await settle();
		const boatLeaves = ctx.workspace.leaves.filter((l) => l.opened?.path === "Projects/Boat.md");
		expect(boatLeaves).toHaveLength(2);
		expect(boatLeaves[0]).not.toBe(boatLeaves[1]);
	});

	it("E4: five rapid middle-clicks open five leaves", async () => {
		const row = await bucketRow(ctx, file, "Boat");
		for (let i = 0; i < 5; i++) aux(label(row));
		await settle();
		expect(ctx.workspace.leaves.filter((l) => l.opened?.path === "Projects/Boat.md")).toHaveLength(5);
	});

	it("G3: a module row body opens its interface note in a new leaf; the icon does not", async () => {
		const row = await bucketRow(ctx, withNote, "WithNote");
		aux(row.querySelector(".atlas-icon")!);
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		aux(label(row));
		await settle();
		expect(ctx.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		expect(ctx.workspace.leaves.filter((l) => l.opened).map((l) => l.opened!.path)).toEqual(["Modules/WithNote/WithNote.md"]);
	});

	it("G3/E2: a module with no interface note does nothing and no note is created", async () => {
		aux(label(await bucketRow(ctx, noNote, "NoNote")));
		aux(label(inboxRow(ctx, noNote, "NoNote")));
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		expect(ctx.workspace.openLinkText).not.toHaveBeenCalled();
		expect(ctx.app.vault.getAbstractFileByPath("Modules/NoNote/NoNote.md")).toBeNull();
		expect(ctx.app.vault.calls).toEqual([]);
	});
});

describe("blocks (G2, G7, E3)", () => {
	it("G2: a bucket block row calls openLinkText(path#subpath, '', true) and nothing else", async () => {
		aux(label(await bucketRow(ctx, block, "Idea")));
		await settle();
		expect(ctx.workspace.openLinkText).toHaveBeenCalledExactlyOnceWith("_pool/20260101000000-abcd.md#^abcd", "", true);
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
	});

	it("G2: an inbox block row does the same", async () => {
		aux(label(inboxRow(ctx, block, "Idea")));
		await settle();
		expect(ctx.workspace.openLinkText).toHaveBeenCalledExactlyOnceWith("_pool/20260101000000-abcd.md#^abcd", "", true);
	});

	it("G7/E3: a block row whose file was deleted resolves as missing: no openLinkText, no file created (bucket and inbox)", async () => {
		await ctx.app.vault.delete(ctx.app.vault.getAbstractFileByPath(block.path)!);
		ctx.app.vault.calls.length = 0;
		aux(label(await bucketRow(ctx, block, "^abcd", true)));
		aux(label(inboxRow(ctx, block, "^abcd", true)));
		await settle();
		expect(ctx.workspace.openLinkText).not.toHaveBeenCalled();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		expect(ctx.app.vault.calls).toEqual([]);
		expect(ctx.app.vault.getAbstractFileByPath(block.path)).toBeNull();
		expect(Notice.instances).toEqual([]);
	});

	it("E3: even when the row still thinks it is live, a file deleted after render is not reopened", async () => {
		const row = await bucketRow(ctx, block, "Idea");
		await ctx.app.vault.delete(ctx.app.vault.getAbstractFileByPath(block.path)!);
		ctx.app.vault.calls.length = 0;
		aux(label(row));
		await settle();
		expect(ctx.workspace.openLinkText).not.toHaveBeenCalled();
		expect(ctx.app.vault.calls).toEqual([]);
	});
});

describe("selection and the vault stay untouched (G10, G14, F4)", () => {
	it("a middle-click inside a multi-row selection leaves both selections and the vault alone", async () => {
		ctx.explorer.selectedBucketNodeIds.add("a");
		ctx.explorer.selectedBucketNodeIds.add("b");
		ctx.explorer.selectedInboxRefKeys.add("file:Other.md");
		const row = await bucketRow(ctx, file, "Boat");
		const bucketBefore = new Set(ctx.explorer.selectedBucketNodeIds);
		const inboxBefore = new Set(ctx.explorer.selectedInboxRefKeys);
		aux(label(row));
		aux(label(inboxRow(ctx, ideas, "Ideas")));
		await settle();
		expect(ctx.explorer.selectedBucketNodeIds).toEqual(bucketBefore);
		expect(ctx.explorer.selectedInboxRefKeys).toEqual(inboxBefore);
		expect(ctx.app.vault.calls).toEqual([]);
		expect(Notice.instances).toEqual([]);
	});
});

describe("E5 the active highlight follows the newly opened note; selection classes are untouched", () => {
	it("after the new tab becomes active, updateActiveHighlight marks exactly that row is-active and not is-selected", async () => {
		const boat = await bucketRow(ctx, file, "Boat");
		const other = await bucketRow(ctx, ideas, "Ideas");
		const inboxIdeas = inboxRow(ctx, ideas, "Ideas");
		// the daily note is active before the gesture: no row matches it
		highlight(ctx);
		expect(ctx.content.querySelectorAll(".is-active")).toHaveLength(0);

		aux(label(boat));
		await settle();
		highlight(ctx); // what the `file-open` / `active-leaf-change` handlers run
		expect(boat.classList.contains("is-active")).toBe(true);
		expect(other.classList.contains("is-active")).toBe(false);
		expect(inboxIdeas.classList.contains("is-active")).toBe(false);
		expect(boat.classList.contains("is-selected")).toBe(false);
		expect(ctx.explorer.selectedBucketNodeIds.size).toBe(0);
	});

	it("the same holds for an inbox row", async () => {
		const row = inboxRow(ctx, ideas, "Ideas");
		aux(label(row));
		await settle();
		highlight(ctx);
		expect(row.classList.contains("is-active")).toBe(true);
		expect(row.classList.contains("is-selected")).toBe(false);
	});
});

describe("F7 the 'Open in new tab' menu items still call openRef(ref, true)", () => {
	it("showUnitMenu and showInboxUnitMenu are unchanged", () => {
		const src = [proto.showUnitMenu, proto.showInboxUnitMenu].map((fn) => String(fn));
		for (const text of src) expect(text).toMatch(/Open in new tab[\s\S]*?openRef\(ref, true\)/);
	});
});

/** Atlas #13 PR-1: the REAL `resolveRef` (nothing stubbed) decides the row, so a placed note that is not
 * an Atlas unit still renders normally and opens in a new tab on middle-click. */
describe("Atlas #13 PR-1 — a placed note that is not a unit (Dan's Responsibilities.md in FDE Play)", () => {
	const moved: UnitRef = { kind: "file", path: "FDE Play/Responsibilities.md" };

	async function realBucketRow(c: Ctx, ref: UnitRef): Promise<HTMLElement> {
		c.explorer.resolveRef = (proto.resolveRef as (r: UnitRef) => Promise<unknown>).bind(c.explorer);
		const node = { id: `n${++nodeSeq}`, type: "unit", ref, children: [] } as ViewNode;
		await (proto.renderNode as unknown as (...a: unknown[]) => Promise<void>).call(c.explorer, node, c.content, view, 0, []);
		return c.content.lastElementChild as HTMLElement;
	}

	it("GP3/GP4: reads 'Responsibilities', not missing, and middle-click opens it in a new leaf", async () => {
		ctx.app.vault.seedFolder("FDE Play");
		ctx.app.vault.seedFile(moved.path);
		const row = await realBucketRow(ctx, moved);
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(row.textContent).not.toContain("(missing)");
		expect(row.querySelector(".atlas-row-action")).toBeNull();
		expect(label(row).textContent).toBe("Responsibilities");
		aux(label(row));
		await settle();
		expect(ctx.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		expect(ctx.workspace.leaves.filter((l) => l.opened).map((l) => l.opened!.path)).toEqual([moved.path]);
		expect(ctx.app.vault.calls).toEqual([]);
	});

	it("a deleted note renders missing and middle-click opens nothing", async () => {
		ctx.app.vault.seedFolder("FDE Play");
		ctx.app.vault.seedFile(moved.path);
		await ctx.app.vault.delete(ctx.app.vault.getAbstractFileByPath(moved.path)!);
		ctx.app.vault.calls.length = 0;
		const row = await realBucketRow(ctx, moved);
		expect(row.classList.contains("atlas-missing")).toBe(true);
		aux(label(row));
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		expect(ctx.workspace.openLinkText).not.toHaveBeenCalled();
		expect(ctx.app.vault.calls).toEqual([]);
	});

	it("a non-unit folder with no interface note is a normal module row and middle-click does nothing", async () => {
		const row = await realBucketRow(ctx, noNote);
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(label(row).textContent).toBe("NoNote");
		aux(label(row));
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		expect(ctx.app.vault.getAbstractFileByPath("Modules/NoNote/NoNote.md")).toBeNull();
	});
});

/** Tephra multi-source PR-6 (G7, E5): the same middle-click rules for rows whose path is `Sources/<name>/...`. The
 * real `renderNode` / `renderInboxRow` / `openRef` / opener rule; only the workspace is the recording fake above. */
describe("source rows (Tephra toggle on): middle-click opens by the source-open rule", () => {
	const note: UnitRef = { kind: "file", path: "Sources/whoop/Workout Plan.md" };
	const docx: UnitRef = { kind: "file", path: "Sources/whoop/Plan.docx" };
	const code: UnitRef = { kind: "file", path: "Sources/tephra/crates/tephrad/src/registry.rs" };
	const crates: UnitRef = { kind: "folder", path: "Sources/tephra/crates" };
	const defaultApp = (): string[] => (ctx.app as unknown as { defaultAppOpens: string[] }).defaultAppOpens;

	beforeEach(() => {
		(ctx.plugin.settings as { tephraEnabled: boolean }).tephraEnabled = true;
		const v = ctx.app.vault;
		for (const dir of ["Sources", "Sources/whoop", "Sources/tephra", "Sources/tephra/crates", "Sources/tephra/crates/tephrad", "Sources/tephra/crates/tephrad/src"]) v.seedFolder(dir);
		for (const f of [note.path, docx.path, code.path]) v.seedFile(f);
		v.calls.length = 0;
	});

	it("a bucket row and an inbox row for a source note open in a new leaf, by the full Sources/ path", async () => {
		aux(label(await bucketRow(ctx, note, "Workout Plan")));
		aux(label(inboxRow(ctx, note, "Workout Plan")));
		await settle();
		expect(ctx.workspace.getLeaf.mock.calls).toEqual([[true], [true]]);
		expect(ctx.workspace.leaves.filter((l) => l.opened).map((l) => l.opened!.path)).toEqual([note.path, note.path]);
		expect(defaultApp()).toEqual([]);
	});

	it("a source file with no Obsidian view goes to the default app instead of a leaf", async () => {
		aux(label(inboxRow(ctx, docx, "Plan")));
		await settle();
		expect(defaultApp()).toEqual([docx.path]);
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
	});

	it("a code file opens in a leaf only while a plugin has registered its extension", async () => {
		const registry = (ctx.app as unknown as { viewRegistry: { typeByExtension: Record<string, string> } }).viewRegistry.typeByExtension;
		aux(label(inboxRow(ctx, code, "registry.rs")));
		await settle();
		expect(defaultApp()).toEqual([code.path]);
		registry.rs = "workbench";
		aux(label(inboxRow(ctx, code, "registry.rs")));
		await settle();
		expect(ctx.workspace.leaves.filter((l) => l.opened).map((l) => l.opened!.path)).toEqual([code.path]);
	});

	it("the rules are the vault rows' rules: modifiers and controls do nothing, a plain middle-click does", async () => {
		const row = inboxRow(ctx, note, "Workout Plan");
		for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) aux(label(row), init);
		const dot = row.appendChild(document.createElement("span"));
		dot.className = "atlas-status-dot";
		aux(dot);
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		aux(label(row));
		await settle();
		expect(ctx.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
	});

	it("E5: a source row whose file is gone (rendered missing, or deleted after render) does nothing and creates nothing", async () => {
		const stale = inboxRow(ctx, note, "Workout Plan");
		const missing = inboxRow(ctx, { kind: "file", path: "Sources/gone/Ghost.md" }, "Ghost", true);
		await ctx.app.vault.delete(ctx.app.vault.getAbstractFileByPath(note.path)!);
		ctx.app.vault.calls.length = 0;
		aux(label(stale));
		aux(label(missing));
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		expect(ctx.workspace.openLinkText).not.toHaveBeenCalled();
		expect(defaultApp()).toEqual([]);
		expect(ctx.app.vault.calls).toEqual([]);
	});

	it("a source module with no interface note does nothing and creates no <Folder>/<Folder>.md", async () => {
		aux(label(inboxRow(ctx, crates, "crates")));
		await settle();
		expect(ctx.workspace.getLeaf).not.toHaveBeenCalled();
		expect(ctx.app.vault.getAbstractFileByPath("Sources/tephra/crates/crates.md")).toBeNull();
		expect(ctx.app.vault.calls).toEqual([]);
	});

	it("a block row inside a source note opens its exact file in a new tab with the subpath as view state, never by openLinkText", async () => {
		const blockRef: UnitRef = { kind: "block", path: note.path, subpath: "^k3f9a2" };
		aux(label(inboxRow(ctx, blockRef, "Idea")));
		await settle();
		expect(ctx.workspace.openLinkText).not.toHaveBeenCalled();
		expect(ctx.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		const leaf = ctx.workspace.leaves.find((l) => l.opened)!;
		expect(leaf.opened!.path).toBe(note.path);
		expect(leaf.openFile).toHaveBeenCalledExactlyOnceWith(expect.anything(), { eState: { subpath: "#^k3f9a2" } });
		expect(ctx.app.vault.calls).toEqual([]);
	});
});
