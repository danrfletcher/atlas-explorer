import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice, TFolder } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { seedRoot, flush } from "../helpers";
import { unitRefKey, unitToRef } from "../../src/types";
import type { UnitRef, View, ViewNode } from "../../src/types";

// The Obsidian mock DOM has no `hasClass` (the real API does); the module-row wiring calls it.
if (!(HTMLElement.prototype as { hasClass?: unknown }).hasClass) {
	(HTMLElement.prototype as unknown as { hasClass: (cls: string) => boolean }).hasClass = function (cls: string) {
		return this.classList.contains(cls);
	};
}

/** One-line mock of the Obsidian confirm modal only (the mock `Setting` has no `addButton`, so the
 * real `ConfirmModal` cannot render under test). Records each confirmation so the test can answer it. */
const confirms = vi.hoisted(() => [] as { message: string; label: string; onConfirm: () => void }[]);
vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingConfirmModal {
		constructor(_app: unknown, message: string, label: string, onConfirm: () => void) {
			confirms.push({ message, label, onConfirm });
		}
		open(): void {}
	}
	return { ...actual, ConfirmModal: RecordingConfirmModal };
});

const folder = (path: string): UnitRef => ({ kind: "folder", path });
const file = (path: string): UnitRef => ({ kind: "file", path });

type Method = (...args: unknown[]) => unknown;
const proto = AtlasExplorerView.prototype as unknown as Record<string, Method>;

/** The row-level methods the real module wiring and renderers call. Everything here is the real
 * prototype implementation, except the chrome helpers listed in `stubbed` below, which these tests
 * don't exercise (drag-drop zones, menus, selection, keyboard). */
const REAL = [
	"renderNode",
	"renderConnectionDots",
	"renderInboxRow",
	"resolveRef",
	"resolveOutsideManagedRowInfo",
	"isOutsideManagedUnit",
	"wireModuleRow",
	"handleAddToModule",
	"uniquePath",
	"openRef",
	"singleDragRef",
	"refOfNode",
	"findNodeAnywhere",
	"matchesFilter",
	"trackModuleModal",
	"removeUnitsFromView",
	"holdsLiveDataSource",
	"forgetDeviceLocalSourceState",
] as const;

interface Ctx {
	app: App;
	index: UnitIndex;
	views: ViewsManager;
	view: View;
	explorer: Record<string, unknown> & { openModuleContentsModal: ReturnType<typeof vi.fn>; viewsManager: ViewsManager };
}

function makeCtx(files: string[], folders: string[], index?: (app: App) => UnitIndex): Ctx {
	const app = new App();
	seedRoot(app, files, folders);
	const unitIndex = index ? index(app) : new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
	unitIndex.rebuild();
	const views = new ViewsManager(app, [], "", () => {});
	const view = views.getViews()[0];
	const explorer = {
		plugin: {
			app,
			settings: { ...DEFAULT_SETTINGS, confirmAddToModule: true },
			unitIndex,
			viewsManager: views,
			freeBlockTextCache: undefined,
			isModuleFolderExpanded: vi.fn(() => false),
			setModuleFolderExpanded: vi.fn(),
			folderSourcePathStore: { get: () => undefined },
		},
		filterText: "",
		dragPayload: null,
		selectedBucketNodeIds: new Set<string>(),
		selectedInboxRefKeys: new Set<string>(),
		unitsByRefKey: new Map(),
		cancelActiveDwell: null,
		openModuleModal: null,
		openModuleContentsModal: vi.fn(),
		openModuleContentsModalForDrag: vi.fn(),
		renderRowIcon: vi.fn(),
		makeDropZone: vi.fn(),
		setPlacementTooltip: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		buildNodeDragPayload: vi.fn(),
		buildInboxDragPayload: vi.fn(),
		handleRowKeydown: vi.fn(),
		showUnitMenu: vi.fn(),
		showInboxUnitMenu: vi.fn(),
		viewsManager: views,
	} as unknown as Ctx["explorer"];
	for (const name of REAL) explorer[name] = proto[name].bind(explorer);
	return { app, index: unitIndex, views, view, explorer };
}

/** Mirrors `AtlasExplorerView.render`'s own unit lookup, so a row resolves against the current index. */
function refreshLookup(ctx: Ctx): void {
	ctx.explorer.unitsByRefKey = new Map(ctx.index.getUnits().map((u) => [unitRefKey(unitToRef(u)), u]));
}

async function renderInbox(ctx: Ctx, ref: UnitRef): Promise<HTMLElement> {
	refreshLookup(ctx);
	const info = await (ctx.explorer.resolveRef as (r: UnitRef) => Promise<never>)(ref);
	const container = document.createElement("div");
	(ctx.explorer.renderInboxRow as (c: HTMLElement, r: UnitRef, i: unknown, v: View) => HTMLElement)(container, ref, info, ctx.view);
	return container.querySelector(".atlas-row")!;
}

async function renderBucketNode(ctx: Ctx, node: ViewNode): Promise<HTMLElement> {
	refreshLookup(ctx);
	const container = document.createElement("div");
	await (ctx.explorer.renderNode as (n: ViewNode, c: HTMLElement, v: View, d: number, a: unknown[]) => Promise<void>)(
		node,
		container,
		ctx.view,
		0,
		[]
	);
	return container.querySelector(".atlas-row")!;
}

beforeEach(() => {
	confirms.length = 0;
	Notice.reset();
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("GP3 — an added folder shows as a folder-icon row tagged 'added', never expanded inline", () => {
	it("renders 'Acme' with a module icon and an 'added' badge, with no child rows (F3)", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/Acme/notes.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));

		const row = await renderInbox(ctx, folder("Jobs/Acme"));

		expect(row.querySelector(".atlas-row-text")?.textContent).toBe("Acme");
		expect(row.querySelector(".atlas-icon.atlas-module-icon")).not.toBeNull();
		expect(Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent)).toEqual(["added"]);
		expect(row.parentElement!.querySelectorAll(".atlas-row")).toHaveLength(1);
	});

	it("PR-1.S1 R2: placed in the bucket, renders as a module row with no child rows (F3)", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/Acme/notes.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		ctx.views.placeUnit(ctx.view.id, folder("Jobs/Acme"), null);
		const placed = ctx.views.getViews()[0].root[0];

		const row = await renderBucketNode(ctx, placed);

		expect(row.querySelector(".atlas-row-text")?.textContent).toBe("Acme");
		expect(row.querySelector(".atlas-icon.atlas-module-icon")).not.toBeNull();
		expect(row.parentElement!.querySelectorAll(".atlas-row")).toHaveLength(1);
	});
});

describe("G5 — clicking the row opens the interface note if it has one, otherwise nothing happens", () => {
	it("no interface note: click does nothing, no error, no notice", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		const getLeaf = vi.fn();
		ctx.app.workspace.getLeaf = getLeaf as unknown as App["workspace"]["getLeaf"];

		const row = await renderInbox(ctx, folder("Jobs/Acme"));
		row.click();
		await flush();

		expect(getLeaf).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(0);
	});

	it("with an interface note: click opens that note", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/Acme/Acme.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		const openFile = vi.fn();
		ctx.app.workspace.getLeaf = vi.fn(() => ({ openFile })) as unknown as App["workspace"]["getLeaf"];

		const row = await renderInbox(ctx, folder("Jobs/Acme"));
		row.click();
		await flush();

		expect(openFile).toHaveBeenCalledWith(ctx.app.vault.getAbstractFileByPath("Jobs/Acme/Acme.md"));
	});
});

describe("G6 — clicking the folder icon opens Module Contents for the folder", () => {
	it("icon click calls the Module Contents opener with the folder path", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/Acme/notes.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));

		const row = await renderInbox(ctx, folder("Jobs/Acme"));
		row.querySelector<HTMLElement>(".atlas-module-icon")!.click();

		expect(ctx.explorer.openModuleContentsModal).toHaveBeenCalledWith("Jobs/Acme");
	});

	it("PR-1.S1 R1 (GP5): the real modal lists the added folder's files", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/Acme/notes.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		(ctx.explorer.openModuleContentsModal as Method) = proto.openModuleContentsModal.bind(ctx.explorer);

		const row = await renderInbox(ctx, folder("Jobs/Acme"));
		row.querySelector<HTMLElement>(".atlas-module-icon")!.click();

		const rowNames = Array.from(document.querySelectorAll<HTMLElement>(".atlas-module-modal-tree .atlas-row-text")).map(
			(el) => el.textContent
		);
		expect(rowNames).toEqual(["brief.md", "notes.md"]);
	});

	it("PR-1.S1 R1 (E1): an empty added folder opens the modal empty, with no error", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md"], ["Jobs", "Jobs/Acme", "Jobs/Empty"]);
		ctx.index.markAdded(folder("Jobs/Empty"));
		(ctx.explorer.openModuleContentsModal as Method) = proto.openModuleContentsModal.bind(ctx.explorer);

		const row = await renderInbox(ctx, folder("Jobs/Empty"));
		expect(() => row.querySelector<HTMLElement>(".atlas-module-icon")!.click()).not.toThrow();

		expect(document.querySelectorAll(".atlas-module-modal-tree .atlas-row")).toHaveLength(0);
		expect(Notice.instances).toHaveLength(0);
	});
});

describe("G7 — a single-item drop onto the icon asks, then really moves the file; multi-item and folder drops do not", () => {
	function dropOnIcon(row: HTMLElement, payloadRefs: UnitRef[], ctx: Ctx): void {
		ctx.explorer.dragPayload = { kind: "inbox", refs: payloadRefs };
		row.querySelector<HTMLElement>(".atlas-icon")!.dispatchEvent(new Event("drop", { bubbles: true }));
	}

	it("a single file dropped on the icon asks for confirmation first, then moves it on confirm", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/Loose.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		const row = await renderInbox(ctx, folder("Jobs/Acme"));

		dropOnIcon(row, [file("Jobs/Loose.md")], ctx);
		await flush();

		expect(confirms).toHaveLength(1);
		expect(confirms[0].message).toContain('"Acme"');
		expect(ctx.app.vault.calls).not.toContain("fileManager.renameFile");

		confirms[0].onConfirm();
		await flush();

		expect(ctx.app.vault.calls).toContain("fileManager.renameFile");
		expect(ctx.app.vault.getAbstractFileByPath("Jobs/Acme/Loose.md")).not.toBeNull();
		expect(ctx.app.vault.getAbstractFileByPath("Jobs/Loose.md")).toBeNull();
	});

	it("a multi-item drop onto the icon is not offered a move", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md", "Jobs/A.md", "Jobs/B.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		const row = await renderInbox(ctx, folder("Jobs/Acme"));

		dropOnIcon(row, [file("Jobs/A.md"), file("Jobs/B.md")], ctx);
		await flush();

		expect(confirms).toHaveLength(0);
		expect(ctx.app.vault.calls).not.toContain("fileManager.renameFile");
	});

	it("a folder dropped on the icon is not offered a move", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md"], ["Jobs", "Jobs/Acme", "Jobs/Other"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		const row = await renderInbox(ctx, folder("Jobs/Acme"));

		dropOnIcon(row, [folder("Jobs/Other")], ctx);
		await flush();

		expect(confirms).toHaveLength(0);
		expect(ctx.app.vault.calls).not.toContain("fileManager.renameFile");
	});
});

describe("G10 — a deleted added folder shows a greyed '(missing)' row with a remove button in the bucket", () => {
	it("missing row renders greyed with a remove button; remove unplaces the node; nothing auto-removed", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		ctx.views.placeUnit(ctx.view.id, folder("Jobs/Acme"), null);
		const placed = ctx.views.getViews()[0].root[0];

		await ctx.app.vault.delete(ctx.app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder, true);
		ctx.index.onVaultDelete("Jobs/Acme");

		const row = await renderBucketNode(ctx, placed);
		expect(row.classList.contains("atlas-missing")).toBe(true);
		expect(row.querySelector(".atlas-row-secondary")?.textContent).toBe("(missing)");
		expect(ctx.index.isAdded(folder("Jobs/Acme"))).toBe(true);

		row.querySelector<HTMLElement>(".atlas-row-action")!.click();
		expect(ctx.views.getViews()[0].root).toEqual([]);
		expect(ctx.index.isAdded(folder("Jobs/Acme"))).toBe(true);
	});

	it("folder deleted then recreated at the same path resolves again, no longer missing", async () => {
		const ctx = makeCtx(["Jobs/Acme/brief.md"], ["Jobs", "Jobs/Acme"]);
		ctx.index.markAdded(folder("Jobs/Acme"));
		ctx.views.placeUnit(ctx.view.id, folder("Jobs/Acme"), null);
		const placed = ctx.views.getViews()[0].root[0];

		await ctx.app.vault.delete(ctx.app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder, true);
		ctx.index.onVaultDelete("Jobs/Acme");
		await ctx.app.vault.createFolder("Jobs/Acme");
		ctx.index.onVaultCreate(ctx.app.vault.getAbstractFileByPath("Jobs/Acme")!);

		const row = await renderBucketNode(ctx, placed);
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(row.querySelector(".atlas-row-text")?.textContent).toBe("Acme");
		expect(row.querySelector(".atlas-module-icon")).not.toBeNull();
	});
});

describe("Atlas #13 PR-2 — module-icon drop keeps a placed file where it was placed; blocks are still un-placed", () => {
	const CONFIRM_TEXT =
		'Add "Note" to "Mod"? This moves the file on disk into that folder — Atlas doesn\'t otherwise touch a module\'s internal organization.';
	const flat = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
	const refsOf = (view: View): string[] => flat(view.root).map((n) => unitRefKey(n.ref));

	/** Wires the two events the plugin's own `main.ts` wires, in the same order: the vault `rename`
	 * event (`unitIndex.onVaultRename`, `viewsManager.onVaultRename`) and the one `metadataCache`
	 * "resolved" listener that recomputes promotions. It is registered first, as in `onload`, so it
	 * runs before the one-shot listener `handleAddToModule` adds at drop time. */
	function makePr2Ctx(files: string[]): Ctx {
		const ctx = makeCtx(files, ["Mod"]);
		ctx.app.vault.on("rename", (f: never, oldPath: string) => {
			ctx.index.onVaultRename(f, oldPath);
			ctx.views.onVaultRename(oldPath, (f as { path: string }).path);
		});
		ctx.app.metadataCache.on("resolved", () => ctx.index.onMetadataResolved());
		return ctx;
	}

	/** Drags the placed node `nodeId` of `viewId` onto the real icon of the `Mod` module row. */
	async function dragNodeOntoMod(ctx: Ctx, viewId: string, nodeId: string): Promise<void> {
		const row = await renderInbox(ctx, folder("Mod"));
		ctx.explorer.dragPayload = { kind: "node", nodeIds: [nodeId], viewId };
		row.querySelector<HTMLElement>(".atlas-icon")!.dispatchEvent(new Event("drop", { bubbles: true }));
		await flush();
	}

	const unitKeys = (ctx: Ctx): string[] => ctx.index.getUnits().map((u) => unitRefKey(unitToRef(u)));

	describe("file refs", () => {
		it("GP6: a placed root note with no backlink keeps its node (same id, same parent) at the new path", async () => {
			const ctx = makePr2Ctx(["Note.md", "Parent.md"]);
			ctx.views.placeUnit(ctx.view.id, file("Parent.md"), null);
			const parent = ctx.views.getViews()[0].root[0];
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), parent.id)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			expect(confirms).toHaveLength(1);
			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			expect(ctx.app.vault.getAbstractFileByPath("Mod/Note.md")).not.toBeNull();
			expect(ctx.app.vault.getAbstractFileByPath("Note.md")).toBeNull();
			const after = ctx.views.getViews()[0];
			const parentAfter = after.root[0];
			expect(parentAfter.id).toBe(parent.id);
			expect(parentAfter.children).toHaveLength(1);
			expect(parentAfter.children[0].id).toBe(placed.id);
			expect(parentAfter.children[0].ref).toEqual(file("Mod/Note.md"));
			// The exact case the old clean-up removed: no longer a unit (no backlink, no manual promotion).
			expect(unitKeys(ctx)).not.toContain(unitRefKey(file("Mod/Note.md")));
			expect(ctx.index.getManualPromotions()).toEqual([]);
		});

		it("GP6: the kept row renders as a normal file row, not atlas-missing", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			const row = await renderBucketNode(ctx, ctx.views.getViews()[0].root[0]);
			expect(row.classList.contains("atlas-missing")).toBe(false);
			expect(row.querySelector(".atlas-row-text")?.textContent).toBe("Note");
			expect(row.querySelector(".atlas-row-secondary")?.textContent ?? "").not.toContain("missing");
		});

		it("GP6: placed in two views, every view keeps its node (same ids) at the new path", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const second = ctx.views.createView("Second")!;
			const a = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;
			const b = ctx.views.placeUnit(second.id, file("Note.md"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, a.id);
			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			const [v1, v2] = ctx.views.getViews();
			expect(v1.root.map((n) => [n.id, n.ref])).toEqual([[a.id, file("Mod/Note.md")]]);
			expect(v2.root.map((n) => [n.id, n.ref])).toEqual([[b.id, file("Mod/Note.md")]]);
		});

		it("GP6: placed twice in one view, neither node is removed", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const first = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;
			const copy = ctx.views.duplicateNode(ctx.view.id, first.id)!;
			expect(refsOf(ctx.views.getViews()[0])).toEqual(["file:Note.md", "file:Note.md"]);

			await dragNodeOntoMod(ctx, ctx.view.id, first.id);
			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			const nodes = flat(ctx.views.getViews()[0].root);
			expect(nodes.map((n) => n.id).sort()).toEqual([first.id, copy.id].sort());
			expect(nodes.map((n) => n.ref)).toEqual([file("Mod/Note.md"), file("Mod/Note.md")]);
		});

		it("GP6: skip-confirm path (Module Contents modal drop) behaves the same: no prompt, node kept", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const second = ctx.views.createView("Second")!;
			const a = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;
			const b = ctx.views.placeUnit(second.id, file("Note.md"), null)!;

			await (ctx.explorer.handleAddToModule as (r: UnitRef, f: string, skip: boolean) => Promise<void>)(file("Note.md"), "Mod", true);
			ctx.app.metadataCache.trigger("resolved");

			expect(confirms).toHaveLength(0);
			expect(ctx.app.vault.calls.filter((c) => c === "fileManager.renameFile")).toHaveLength(1);
			const [v1, v2] = ctx.views.getViews();
			expect(v1.root.map((n) => [n.id, n.ref])).toEqual([[a.id, file("Mod/Note.md")]]);
			expect(v2.root.map((n) => [n.id, n.ref])).toEqual([[b.id, file("Mod/Note.md")]]);
		});

		it("the 'resolved' event never fires: the placement is still intact", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			confirms[0].onConfirm();
			await flush();
			await flush();

			expect(ctx.views.getViews()[0].root.map((n) => [n.id, n.ref])).toEqual([[placed.id, file("Mod/Note.md")]]);
		});

		it("a file that keeps a backlink (still a unit after the move) stays placed", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;
			ctx.index.addManualPromotion(file("Note.md")); // stands in for a surviving inbound link

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			expect(unitKeys(ctx)).toContain(unitRefKey(file("Mod/Note.md")));
			expect(ctx.views.getViews()[0].root.map((n) => [n.id, n.ref])).toEqual([[placed.id, file("Mod/Note.md")]]);
		});

		it("E10: a dragged file that is not placed in any view moves, changes no view and throws nothing", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			ctx.views.createView("Second");
			const before = JSON.stringify(ctx.views.getViews());

			const row = await renderInbox(ctx, folder("Mod"));
			ctx.explorer.dragPayload = { kind: "inbox", refs: [file("Note.md")] };
			expect(() => row.querySelector<HTMLElement>(".atlas-icon")!.dispatchEvent(new Event("drop", { bubbles: true }))).not.toThrow();
			await flush();
			confirms[0].onConfirm();
			await flush();
			expect(() => ctx.app.metadataCache.trigger("resolved")).not.toThrow();

			expect(ctx.app.vault.getAbstractFileByPath("Mod/Note.md")).not.toBeNull();
			expect(JSON.stringify(ctx.views.getViews())).toBe(before);
		});

		it("a name collision in the target folder: uniquePath picks a unique path and the node follows it", async () => {
			const ctx = makePr2Ctx(["Note.md", "Mod/Note.md"]);
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			const node = ctx.views.getViews()[0].root[0];
			expect(node.id).toBe(placed.id);
			expect(node.ref).toEqual(file("Mod/Note 2.md"));
			expect(ctx.app.vault.getAbstractFileByPath("Mod/Note 2.md")).not.toBeNull();
			expect(ctx.app.vault.getAbstractFileByPath("Mod/Note.md")).not.toBeNull();
		});

		it("the ref does not resolve to a TFile, or the target is not a TFolder: returns early, changes nothing", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			ctx.views.placeUnit(ctx.view.id, file("Gone.md"), null);
			ctx.views.placeUnit(ctx.view.id, file("Note.md"), null);
			const before = JSON.stringify(ctx.views.getViews());
			const handle = ctx.explorer.handleAddToModule as (r: UnitRef, f: string, skip?: boolean) => Promise<void>;

			await handle(file("Gone.md"), "Mod"); // ref missing
			await handle(file("Note.md"), "Nowhere"); // target missing
			await handle(file("Note.md"), "Note.md", true); // target is a file, not a folder
			ctx.app.metadataCache.trigger("resolved");

			expect(confirms).toHaveLength(0);
			expect(ctx.app.vault.calls).toEqual([]);
			expect(JSON.stringify(ctx.views.getViews())).toBe(before);
		});
	});

	describe("block refs keep the post-move clean-up (F4)", () => {
		const block: UnitRef = { kind: "block", path: "Note.md", subpath: "^b1" };
		const moved: UnitRef = { kind: "block", path: "Mod/Note.md", subpath: "^b1" };

		it.each([
			{ demoted: true, twoViews: false },
			{ demoted: true, twoViews: true },
			{ demoted: false, twoViews: false },
			{ demoted: false, twoViews: true },
		])("block demoted=$demoted, placed in two views=$twoViews", async ({ demoted, twoViews }) => {
			const ctx = makePr2Ctx(["Note.md"]);
			ctx.index.addManualPromotion(block); // the block is a unit before the move
			ctx.index.onMetadataResolved();
			const second = twoViews ? ctx.views.createView("Second")! : null;
			const a = ctx.views.placeUnit(ctx.view.id, block, null)!;
			const b = second ? ctx.views.placeUnit(second.id, block, null)! : null;
			const unplace = vi.spyOn(ctx.views, "unplaceUnit");
			if (demoted) ctx.index.removeManualPromotion(block); // nothing keeps it a unit after the move
			else expect(unitKeys(ctx)).toContain(unitRefKey(block));

			await dragNodeOntoMod(ctx, ctx.view.id, a.id);
			confirms[0].onConfirm();
			await flush();
			// Before "resolved" fires nothing has been removed yet.
			expect(refsOf(ctx.views.getViews()[0])).toEqual([unitRefKey(moved)]);
			ctx.app.metadataCache.trigger("resolved");

			const views = ctx.views.getViews();
			if (demoted) {
				for (const v of views) expect(refsOf(v)).toEqual([]);
				expect(unplace).toHaveBeenCalledTimes(views.length);
				expect(unplace).toHaveBeenCalledWith(ctx.view.id, moved);
			} else {
				expect(unitKeys(ctx)).toContain(unitRefKey(moved));
				expect(views[0].root.map((n) => [n.id, n.ref])).toEqual([[a.id, moved]]);
				if (b) expect(views[1].root.map((n) => [n.id, n.ref])).toEqual([[b.id, moved]]);
				expect(unplace).not.toHaveBeenCalled();
			}
		});
	});

	describe("unchanged behaviour guards (F7)", () => {
		it("the confirm text and 'Add' label are unchanged, and exactly one fileManager.renameFile (plus its vault rename) is the only write", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			expect(confirms).toHaveLength(1);
			expect(confirms[0].message).toBe(CONFIRM_TEXT);
			expect(confirms[0].label).toBe("Add");
			expect(ctx.app.vault.calls).toEqual([]);

			confirms[0].onConfirm();
			await flush();
			ctx.app.metadataCache.trigger("resolved");

			expect(ctx.app.vault.calls).toEqual(["fileManager.renameFile", "rename"]);
		});

		it("confirmAddToModule off skips the prompt, not the move", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			(ctx.explorer.plugin as { settings: { confirmAddToModule: boolean } }).settings.confirmAddToModule = false;
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);

			expect(confirms).toHaveLength(0);
			expect(ctx.app.vault.calls).toEqual(["fileManager.renameFile", "rename"]);
			expect(ctx.views.getViews()[0].root.map((n) => n.ref)).toEqual([file("Mod/Note.md")]);
		});

		it("cancelling the confirm modal: no move, no placement change", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			const placed = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;
			const before = JSON.stringify(ctx.views.getViews());

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);
			ctx.app.metadataCache.trigger("resolved"); // never confirmed

			expect(confirms).toHaveLength(1);
			expect(ctx.app.vault.calls).toEqual([]);
			expect(ctx.app.vault.getAbstractFileByPath("Note.md")).not.toBeNull();
			expect(JSON.stringify(ctx.views.getViews())).toBe(before);
		});

		it("a multi-item node drag onto the icon is a no-op: no confirm, no move, no placement change", async () => {
			const ctx = makePr2Ctx(["Note.md", "Other.md"]);
			const a = ctx.views.placeUnit(ctx.view.id, file("Note.md"), null)!;
			const b = ctx.views.placeUnit(ctx.view.id, file("Other.md"), null)!;
			const before = JSON.stringify(ctx.views.getViews());

			const row = await renderInbox(ctx, folder("Mod"));
			ctx.explorer.dragPayload = { kind: "node", nodeIds: [a.id, b.id], viewId: ctx.view.id };
			row.querySelector<HTMLElement>(".atlas-icon")!.dispatchEvent(new Event("drop", { bubbles: true }));
			await flush();

			expect(confirms).toHaveLength(0);
			expect(ctx.app.vault.calls).toEqual([]);
			expect(JSON.stringify(ctx.views.getViews())).toBe(before);
		});

		it("a folder-kind node dropped on the icon is refused", async () => {
			const ctx = makePr2Ctx(["Note.md"]);
			ctx.app.vault.seedFolder("Other");
			ctx.index.rebuild();
			const placed = ctx.views.placeUnit(ctx.view.id, folder("Other"), null)!;

			await dragNodeOntoMod(ctx, ctx.view.id, placed.id);

			expect(confirms).toHaveLength(0);
			expect(ctx.app.vault.calls).toEqual([]);
			expect(ctx.app.vault.getAbstractFileByPath("Other")).not.toBeNull();
		});
	});
});
