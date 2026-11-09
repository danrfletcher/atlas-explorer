/** Shared wiring for the Module Contents tests (atlas-17 PR-2). Not a `*.test.ts` file, so vitest's
 * include glob skips it. Builds the REAL `ModuleContentsModal` over an in-memory vault, with callbacks
 * wired to the REAL `AtlasPlugin` hide/unhide methods and the REAL `AtlasExplorerView` drag/promote
 * methods, so a test drives the same code path the app does. */
import { vi } from "vitest";
import { App, Menu, TFolder } from "obsidian";
import AtlasPlugin from "../../src/main";
import { AtlasExplorerView, ModuleContentsModal } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { seedRoot } from "../helpers";
import type { UnitRef, View } from "../../src/types";

type Method = (...args: unknown[]) => unknown;
const proto = AtlasExplorerView.prototype as unknown as Record<string, Method>;

export interface ModuleRig {
	app: App;
	index: UnitIndex;
	views: ViewsManager;
	plugin: AtlasPlugin;
	explorer: Record<string, unknown>;
	persistDebounced: ReturnType<typeof vi.fn>;
	flushSave: ReturnType<typeof vi.fn>;
	saveManualPromotions: ReturnType<typeof vi.fn>;
	render: ReturnType<typeof vi.fn>;
	queueRender: ReturnType<typeof vi.fn>;
	openModal: (folderPath?: string) => ModuleContentsModal;
}

/** A vault holding `files` (and the folders in `folders`), one view `v1`, and the plugin/explorer
 * collaborators a Module Contents modal reaches. */
export function makeModuleRig(files: string[], folders: string[], hidden: Record<string, string[]> = {}): ModuleRig {
	const app = new App();
	seedRoot(app, files, folders);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], [], hidden);
	index.rebuild();
	const view: View = { id: "v1", name: "Default", root: [], inboxMode: "view" };
	const views = new ViewsManager(app, [view], "v1", () => {});

	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
	const persistDebounced = vi.fn();
	const flushSave = vi.fn(async () => {});
	const saveManualPromotions = vi.fn(async () => {});
	const expanded = new Set<string>();
	Object.assign(plugin, {
		app,
		settings: { ...DEFAULT_SETTINGS },
		unitIndex: index,
		viewsManager: views,
		persistDebounced,
		flushSave,
		saveManualPromotions,
		expandedModuleFolders: expanded,
	});

	const render = vi.fn(async () => {});
	const queueRender = vi.fn();
	const explorer = {
		plugin,
		render,
		queueRender,
		dragPayload: null,
		moduleDragCommitted: false,
		selectedBucketNodeIds: new Set<string>(),
		selectedInboxRefKeys: new Set<string>(),
		openModuleModal: null,
		trackModuleModal: vi.fn(),
		openRef: vi.fn(async () => {}),
		revealInNativeExplorer: vi.fn(),
		promoteAndPlaceFlow: vi.fn(),
		singleDragRef: proto.singleDragRef,
	} as Record<string, unknown>;
	for (const name of ["moduleModalCallbacks", "openModuleContentsModal", "promoteToInbox", "startModuleItemDrag", "endModuleItemDrag", "handleDrop"]) {
		explorer[name] = proto[name].bind(explorer);
	}
	explorer.singleDragRef = proto.singleDragRef.bind(explorer);

	const openModal = (folderPath = "Mod") => {
		(explorer.openModuleContentsModal as (p: string) => void)(folderPath);
		const modal = (explorer.trackModuleModal as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as ModuleContentsModal;
		return modal;
	};
	return { app, index, views, plugin, explorer, persistDebounced, flushSave, saveManualPromotions, render, queueRender, openModal };
}

export const folderRef = (path: string): UnitRef => ({ kind: "folder", path });
export const fileRef = (path: string): UnitRef => ({ kind: "file", path });

/** The `.atlas-row-internal` row of the item named `name` in an open modal. */
export function itemRow(modal: ModuleContentsModal, name: string): HTMLElement {
	const rows = Array.from(modal.contentEl.querySelectorAll<HTMLElement>(".atlas-row-internal"));
	const row = rows.find((r) => r.querySelector(".atlas-row-text")?.textContent === name);
	if (!row) throw new Error(`no row named ${name}`);
	return row;
}

/** Right-clicks `row` and returns the menu it showed, as the recording mock `Menu` holds it. */
export function rightClick(row: HTMLElement): Menu {
	const shown: Menu[] = [];
	const spy = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		shown.push(this);
	});
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	spy.mockRestore();
	if (shown.length !== 1) throw new Error(`expected one menu, got ${shown.length}`);
	return shown[0];
}

export function clickMenuItem(menu: Menu, title: string): void {
	const item = menu.items.find((i) => i.title === title);
	if (!item?.clickHandler) throw new Error(`no menu item "${title}" in [${menu.titles().join(", ")}]`);
	item.clickHandler();
}

/** A pointer/drag event carrying coordinates (jsdom has no DragEvent; the modal reads only clientX/Y). */
export function dragEvent(type: string, x = 0, y = 0, target?: EventTarget): MouseEvent {
	const evt = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, relatedTarget: target as Node | null });
	return evt;
}

/** Gives the modal frame a real-looking box (jsdom lays nothing out): left/top 100, 300 x 200. */
export function sizeModal(modal: ModuleContentsModal): void {
	modal.modalEl.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
}

export const isFolder = (app: App, path: string) => app.vault.getAbstractFileByPath(path) instanceof TFolder;
