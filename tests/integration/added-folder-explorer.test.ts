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
