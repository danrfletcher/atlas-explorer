import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "obsidian";
import { Menu, Notice } from "obsidian";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, ViewNode } from "../../src/types";
import { registerAddBlockCommand } from "../../src/commands";
import { registerF10Commands } from "../../src/f10-commands";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { AtlasExplorerView, compareInboxRows } from "../../src/explorer-view";
import type { InboxSortRow } from "../../src/explorer-view";
import { SORT_MODE_CHOICES } from "../../src/sort";
import { file, meta, unit } from "../integration/create-from-meta-fixtures";
import { renderUnitRow } from "./folder-source-outside-children-behavior.test";
import { dragOverAt, flushNoticeMicrotasks, makeDropFake, makeRow } from "./explorer-view-drop-helpers";
import { callRenderNodeList, makeFakeExplorer, makeStatusesManager, rowOrder, view as sortView } from "./explorer-view-sort-truncate-helpers";

/** F5: "Folder source introduces no new disk-moving behavior beyond the three existing named
 * exceptions (module-icon drop, block graduation, Create)" — none of which live in this PR's own
 * files. Combines a static source-text check (no disk-write API call anywhere in the Folder-source
 * code) with a behavioral one (actually driving the real reconcile/refresh/rename paths against the
 * mock `Vault`'s own `calls` tracker and confirming it never records a write). */

const dropUnit = (id: string, path: string): ViewNode => ({ id, type: "unit", ref: { kind: "file", path }, children: [] });

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
		const body = folderSourceSlice("src/explorer-view.ts", "refreshFolderSource(view: View", "\n\t}");
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

// PR-2.F2: Folder is the first real "Add under…" choice (G4) — these grep-style checks mirror
// PR-2.F1's own add-under-fence.test.ts for the one new module this PR adds, plus a static
// check for the fence's F4 ("always the last child, no position choice").
describe("PR-2.F2 fence — F2 (no command/toolbar change) and F4 (no sibling-insert/position choice)", () => {
	it("src/add-under-folder.ts adds no new command, hotkey or toolbar button", () => {
		const body = read("src/add-under-folder.ts");
		expect(body).not.toMatch(/addCommand\(/);
		expect(body).not.toMatch(/hotkeys\s*:/);
		expect(body).not.toMatch(/toolbarButton\(/);
	});

	it("the toolbar's create section (Add block/file/module/folder) still has exactly four buttons", () => {
		const body = read("src/explorer-view.ts");
		const start = body.indexOf("// --- section 2: create");
		const end = body.indexOf("// --- section 3: view controls");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const section = body.slice(start, end);
		expect((section.match(/this\.toolbarButton\(/g) ?? []).length).toBe(4);
	});

	it("src/add-under-folder.ts never splices or unshifts into a children array, and offers no position choice", () => {
		const body = read("src/add-under-folder.ts");
		expect(body).not.toMatch(/\.splice\(/);
		expect(body).not.toMatch(/\.unshift\(/);
		expect(body).not.toMatch(/position/i);
	});

	it("src/add-under-folder.ts contains no disk-write call (Folder is data-only)", () => {
		expect(read("src/add-under-folder.ts")).not.toMatch(DISK_WRITE_CALL);
	});
});

// PR-3.F3: Module's own fence check — F8 ("no undo: after a successful add there is no undo
// entry, command or Notice button, and nothing in the code reverses a completed add"). Mirrors
// PR-2.F2's own grep-style checks above for the new module this PR adds.
describe("PR-3.F3 fence — F8 no undo for Add under > Module", () => {
	it("src/add-under-module.ts adds no undo path, command, hotkey or toolbar button", () => {
		const body = read("src/add-under-module.ts");
		expect(body).not.toMatch(/addCommand\(/);
		expect(body).not.toMatch(/hotkeys\s*:/);
		expect(body).not.toMatch(/toolbarButton\(/);
		expect(body).not.toMatch(/undo/i);
	});

	it("the toolbar's create section (Add block/file/module/folder) still has exactly four buttons", () => {
		const body = read("src/explorer-view.ts");
		const start = body.indexOf("// --- section 2: create");
		const end = body.indexOf("// --- section 3: view controls");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const section = body.slice(start, end);
		expect((section.match(/this\.toolbarButton\(/g) ?? []).length).toBe(4);
	});
});

// PR-2.F3: the G10 hidden-row helper only ever reads `filterText`, sort settings,
// `truncatedStatuses` and `expandedTruncationGroups` (via the signals its caller computes) — it
// must never write any of them. Static grep plus a behavioral check that a real call leaves a
// `state` object with those fields byte-identical.
describe("PR-2.F3 fence — the G10 helper never writes filterText, sort settings, truncatedStatuses or expandedTruncationGroups", () => {
	const WRITES_GOVERNED_STATE = /\b(filterText|sortMode|sortReverse|truncatedStatuses|expandedTruncationGroups)\s*(=(?!=)|\.\s*(add|delete|clear|push|splice)\s*\()/;

	it("src/add-under-hidden-notice.ts has no assignment or mutating call on any of those names", () => {
		expect(read("src/add-under-hidden-notice.ts")).not.toMatch(WRITES_GOVERNED_STATE);
	});

	it("a real call leaves the caller's own governed-state object untouched, whether the row is hidden or visible", async () => {
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { noticeIfAddedRowHidden } = await import("../../src/add-under-hidden-notice");
			const governedState = { filterText: "drone", sortMode: "status", sortReverse: true, truncatedStatuses: { done: { enabled: true } }, expandedTruncationGroups: new Set(["a"]) };
			const before = JSON.stringify({ ...governedState, expandedTruncationGroups: [...governedState.expandedTruncationGroups] });

			await noticeIfAddedRowHidden("new-1", "Quarry Notes", "quarry-drones", {
				render: () => Promise.resolve(),
				getBucketListEl: () => document.createElement("div"), // empty: the row never rendered
				filterActive: governedState.filterText.trim() !== "",
			});

			const after = JSON.stringify({ ...governedState, expandedTruncationGroups: [...governedState.expandedTruncationGroups] });
			expect(after).toBe(before);
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});
});


// PR-1 (R1 fix) — F9: no new command-palette entry and no new keyboard shortcut is registered.
describe("PR-1 F9 — no new command or keyboard shortcut", () => {
	it("the registered command id set is exactly the pre-existing seven, with no sort command added", () => {
		const ids: string[] = [];
		const fakePlugin = { addCommand: (cmd: { id: string }) => ids.push(cmd.id) } as unknown as Parameters<typeof registerF10Commands>[0];
		registerF10Commands(fakePlugin);
		registerAddBlockCommand(fakePlugin);

		expect(ids.sort()).toEqual(
			["open-explorer", "switch-view", "place-active-file-in-view", "reveal-active-file", "new-view", "rebuild-index", "add-block"].sort()
		);
	});

	it("no registered command declares a hotkey", () => {
		const cmds: { id: string; hotkeys?: unknown }[] = [];
		const fakePlugin = { addCommand: (cmd: { id: string; hotkeys?: unknown }) => cmds.push(cmd) } as unknown as Parameters<typeof registerF10Commands>[0];
		registerF10Commands(fakePlugin);
		registerAddBlockCommand(fakePlugin);

		expect(cmds.length).toBe(7);
		for (const cmd of cmds) expect(cmd.hotkeys).toBeUndefined();
	});
});

// PR-1 (R1 fix) — F5: no global default sort setting and no bucket toolbar change; the inbox
// toolbar toggle and the inbox's own ordering are untouched by this PR.
describe("PR-1 F5 — no global sort setting, no bucket toolbar change, inbox ordering unchanged", () => {
	it("AtlasSettings carries no global sort-related field", () => {
		const keys = Object.keys(DEFAULT_SETTINGS).map((k) => k.toLowerCase());
		expect(keys.some((k) => k.includes("sort"))).toBe(false);
	});

	it("renderInboxSection's own source has no reference to the new per-folder sort machinery", () => {
		const body = folderSourceSlice("src/explorer-view.ts", "private async renderInboxSection(", "\n	private renderInboxRow(");
		// Deliberately excludes the bare `sortMode`/`sortReverse` property names: this function
		// legitimately reads the pre-existing `this.sortMode` bucket-toolbar toggle (a different,
		// older feature). What must stay absent here is the new PR's own machinery.
		for (const name of ["isDirectSortMode", "compareSortKeys(", "currentSortMode(", "SORT_MODE_CHOICES", "findSortGovernor("]) {
			expect(body).not.toContain(name);
		}
	});

	it("the inbox comparator (compareInboxRows) is unchanged by this PR: alphabetical/newest-first ordering still behaves exactly as before", () => {
		// A direct, minimal regression guard alongside inbox-sort.test.ts's own full comparator
		// coverage — this PR must not have touched `compareInboxRows`'s own alphabetical-mode
		// behavior (the only mode shared in spirit with G8's A-Z).
		const a: InboxSortRow = { unit: { type: "root-file", path: "Zeta.md" }, text: "Zeta" };
		const b: InboxSortRow = { unit: { type: "root-file", path: "Alpha.md" }, text: "Alpha" };
		const lookup = () => null;
		expect(compareInboxRows(a, b, true, lookup)).toBeGreaterThan(0); // Alpha before Zeta
	});
});

// PR-2 F2 — a sort is purely a render-order transform; it never rewrites `ViewNode.children`.
describe("PR-2 F2 — sort never rewrites a node's stored children order", () => {
	it("A-Z sorts the rendered rows but leaves the input node array itself in its original order", async () => {
		const sm = makeStatusesManager();
		const folder: ViewNode = { id: "folder", type: "meta", label: "Folder", children: [], sortMode: "alphabetical" };
		const zebra: ViewNode = { id: "zebra", type: "meta", label: "Zebra", children: [] };
		const apple: ViewNode = { id: "apple", type: "meta", label: "Apple", children: [] };
		const mango: ViewNode = { id: "mango", type: "meta", label: "Mango", children: [] };
		const nodes = [zebra, apple, mango];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, nodes, container, sortView, 1, [folder]);

		// Rendered order is sorted...
		expect(rowOrder(container)).toEqual(["apple", "mango", "zebra"]);
		// ...but the array `renderNodeList` was handed is untouched, both by reference and by order.
		expect(nodes).toEqual([zebra, apple, mango]);
		expect(nodes[0]).toBe(zebra);
	});
});

// PR-2 F4 — the menu's four unconditional choices never grow a fifth by accident; Status is
// appended conditionally at the call site (explorer-view-menu.test.ts covers that half).
describe("PR-2 F4 — the sort menu's unconditional choices are exactly Manual, A-Z, Modified, Time added", () => {
	it("SORT_MODE_CHOICES holds exactly those four modes, in that order", () => {
		expect(SORT_MODE_CHOICES.map((c) => c.mode)).toEqual(["manual", "alphabetical", "modified", "time-added"]);
		expect(SORT_MODE_CHOICES.map((c) => c.label)).toEqual(["Manual", "A-Z", "Modified", "Time added"]);
	});
});

// PR-2 F8 — Reverse is disabled (never a live control) for Manual, and choosing Manual explicitly
// always resets sortReverse to false rather than leaving a stale `true` behind.
describe("PR-2 F8 — Reverse order is disabled for Manual and Manual never carries a Reverse value", () => {
	function openChooser(node: ViewNode): Menu {
		const fake = {
			plugin: {
				viewsManager: { updateStatusGovernance: () => {} },
				statusesManager: { findSortGovernor: () => null },
			},
		};
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			node,
			{ id: "v1", name: "Default", inboxMode: "view", root: [] }
		);
		show.mockRestore();
		let chooser: Menu | undefined;
		const showChooser = vi.spyOn(Menu.prototype, "showAtPosition").mockImplementation(function (this: Menu) {
			chooser = this;
		});
		built!.items.find((i) => i.title === "Sort children…")!.clickHandler!();
		showChooser.mockRestore();
		return chooser!;
	}

	it("Reverse order is disabled on a Manual (unset) folder", () => {
		const chooser = openChooser({ id: "f", type: "meta", label: "Folder", children: [] });
		expect(chooser.items.find((i) => i.title === "Reverse order")!.disabled).toBe(true);
	});

	it("choosing Manual explicitly (from a Reversed Modified sort) resets sortReverse to false in the same patch", () => {
		const node: ViewNode = { id: "f", type: "meta", label: "Folder", children: [], sortMode: "modified", sortReverse: true };
		const calls: unknown[] = [];
		const fake = {
			plugin: {
				viewsManager: { updateStatusGovernance: (...args: unknown[]) => calls.push(args) },
				statusesManager: { findSortGovernor: () => null },
			},
		};
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			node,
			{ id: "v1", name: "Default", inboxMode: "view", root: [] }
		);
		show.mockRestore();
		let chooser: Menu | undefined;
		const showChooser = vi.spyOn(Menu.prototype, "showAtPosition").mockImplementation(function (this: Menu) {
			chooser = this;
		});
		built!.items.find((i) => i.title === "Sort children…")!.clickHandler!();
		showChooser.mockRestore();
		chooser!.items.find((i) => i.title === "Manual")!.clickHandler!();
		expect(calls).toEqual([["v1", "f", { sortMode: "manual", sortReverse: false }]]);
	});
});

// PR-3 (F3/fence): an edge-drop reorder never touches disk and never edits file content -- no
// vault rename, move or write of any kind results from `handleDrop`'s sibling-insert branches.
describe("PR-3 fence — an edge drop never touches disk", () => {
	it("handleDrop's node-reorder branch has no disk-write call anywhere in its own body", () => {
		const body = folderSourceSlice("src/explorer-view.ts", "private handleDrop(target: DropTarget", "\n	private nodeContainsDescendant(");
		expect(body).not.toMatch(DISK_WRITE_CALL);
	});

	it("driving a real edge-drop move and a real edge-drop inbox-place records no Vault call", () => {
		const app = new MockApp();
		app.vault.seedFile("A.md");
		app.vault.seedFile("B.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		vm.placeUnit(view.id, { kind: "file", path: "A.md" }, null);
		vm.placeUnit(view.id, { kind: "file", path: "B.md" }, null);
		const a = vm.getViews()[0].root[0];

		// A same-parent reorder (the moveNode fix) and a positioned inbox place (the placeUnit fix) --
		// both PR-3's own new code paths -- neither one is a disk operation.
		vm.moveNode(view.id, a.id, null, 2);
		vm.placeUnit(view.id, { kind: "file", path: "C.md" }, null, 1);

		expect(app.vault.calls).toEqual([]);
	});
});

// PR-3 (fence): no new command id is registered by this PR's edge-drop/reorder work -- the
// registered set is still exactly the same seven as PR-1's own F9 check above.
describe("PR-3 fence — no new command id from the edge-drop/reorder work", () => {
	it("the registered command id set still has no sort/reorder/move id of any kind", () => {
		const ids: string[] = [];
		const fakePlugin = { addCommand: (cmd: { id: string }) => ids.push(cmd.id) } as unknown as Parameters<typeof registerF10Commands>[0];
		registerF10Commands(fakePlugin);
		registerAddBlockCommand(fakePlugin);

		expect(ids).toHaveLength(7);
		for (const id of ids) expect(id.toLowerCase()).not.toMatch(/sort|reorder|move-up|move-down/);
	});
});

// PR-4 (fence F7): the sorted-drop gating (resolveDropDecision/assessDrop/sortedFolderNoticeText)
// lives only in drop-zones.ts/sort.ts/explorer-view.ts's own drag handlers -- it never leaks into
// the Module Contents modal or any other modal, which has no drag/drop code of its own to gate.
describe("PR-4 fence F7 — no reorder/sorted-drop code reaches the modals", () => {
	it("src/modals.ts has no drag/drop or sorted-drop-decision code at all", () => {
		const body = read("src/modals.ts");
		expect(body).not.toMatch(/makeDropZone|resolveDropDecision|assessDrop|sortedFolderNoticeText|atlas-sorted-drop-outline|dragover|dragstart|draggable\s*=/);
	});
});

// PR-4 (fence): no new disk-write call anywhere in the sorted-drop gating this PR adds -- a
// refused or allowed sorted-insert drop is exactly as disk-free as every other arrange-only
// action (per F5's own named three exceptions, none of which this PR touches).
describe("PR-4 fence — the sorted-drop gating has no disk-write call", () => {
	it("src/drop-zones.ts (the pure decision function) has no disk-write call anywhere", () => {
		expect(read("src/drop-zones.ts")).not.toMatch(DISK_WRITE_CALL);
	});

	it("sortedFolderNoticeText and the sortedParentLabel/showSortedDropRefusedNotice/assessDrop slice of explorer-view.ts have no disk-write call", () => {
		expect(read("src/sort.ts")).not.toMatch(DISK_WRITE_CALL);
		const body = folderSourceSlice("src/explorer-view.ts", "private assessDrop(", "\n	private async sortedParentLabel(");
		expect(body).not.toMatch(DISK_WRITE_CALL);
		const noticeBody = folderSourceSlice("src/explorer-view.ts", "private async sortedParentLabel(", "\n	private showSortedDropOutline(");
		expect(noticeBody).not.toMatch(DISK_WRITE_CALL);
	});

	it("driving a real refused drop and a real sorted-insert drop, through makeDropZone/handleDrop, records no Vault call", async () => {
		const app = new MockApp();
		app.vault.seedFile("A.md");
		app.vault.seedFile("B.md");
		app.vault.seedFile("C.md");
		const sorted: ViewNode = { id: "sorted", type: "meta", label: "Sorted", sortMode: "alphabetical", children: [dropUnit("a", "A.md"), dropUnit("b", "B.md")] };
		const loose = dropUnit("c", "C.md");
		const vm = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [sorted, loose] }], "v1", () => {});
		const fake = makeDropFake(vm, makeStatusesManager());
		const zone = (nodeId: string) => {
			const row = makeRow();
			document.body.appendChild(row);
			fake.makeDropZone(row, { kind: "node", nodeId, viewId: "v1" }, true);
			return row;
		};
		Notice.reset();

		// a refused in-folder edge drop: B onto A's top edge inside the sorted folder
		fake.dragPayload = { kind: "node", nodeIds: ["b"], viewId: "v1" };
		const refusedRow = zone("a");
		dragOverAt(refusedRow, 5);
		refusedRow.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();
		expect(Notice.instances.map((n) => n.message)).toEqual(["Sorted is sorted A-Z. Set it to Manual to reorder."]); // it really was refused
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["a", "b"]); // and nothing moved

		// a sorted-insert from elsewhere: C (a root row) onto A's top edge
		fake.dragPayload = { kind: "node", nodeIds: ["c"], viewId: "v1" };
		const insertRow = zone("a");
		dragOverAt(insertRow, 5);
		insertRow.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["c", "a", "b"]); // it really landed

		expect(app.vault.calls).toEqual([]);
	});
});

// PR-4 (T3/T7/C32 fix): F10 — a child of an Outside-Vault source folder stays un-draggable (no
// `draggable` attribute, no `dragstart` wiring), so it never takes part in an edge drop or a
// batch -- true whether or not this PR's new sorted-drop gating is in play, since the row never
// gets a drag payload to begin with. Drives the real (unstubbed) `renderNode` the same way
// `folder-source-outside-children-behavior.test.ts`'s own G8/F7 block does.
describe("PR-4 fence F10 — a child of an Outside-Vault source folder stays un-draggable", () => {
	it("an Outside-Vault-managed child renders with no draggable attribute at all, sorted owner or not", async () => {
		const owner = meta("owner", "Folder", [], {
			folderSource: { location: "outside", path: "", showFiles: true, showFolders: true },
			sortMode: "alphabetical",
		});
		const childNode = unit("c1", file("/Volumes/External/Notes/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { row } = await renderUnitRow(childNode, { ownerNode: owner });

		expect(row.getAttribute("draggable")).toBe("false");
	});

	it("firing dragstart on an Outside-Vault-managed row never records a drag payload", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true } });
		const childNode = unit("c1", file("/Volumes/External/Notes/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { row, fake } = await renderUnitRow(childNode, { ownerNode: owner });
		row.dispatchEvent(new Event("dragstart"));

		expect((fake as { dragPayload: unknown }).dragPayload).toBeNull();
	});

	it("an ordinary (non-managed) row stays draggable, control case", async () => {
		const childNode = unit("c2", file("Notes/a.md"));
		const { row } = await renderUnitRow(childNode);

		expect(row.getAttribute("draggable")).toBe("true");
	});
});
