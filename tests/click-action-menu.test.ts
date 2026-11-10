import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Menu } from "obsidian";
import { CommandPickerModal } from "../src/click-action-modal";
import { AtlasExplorerView } from "../src/explorer-view";
import { ApiItemState, ApiSourceConfig, UnitRef, View, ViewNode, createEmptyView } from "../src/types";
import { ViewsManager } from "../src/views";
import { clickMenuItem, makeModuleRig, itemRow, rightClick } from "./unit/module-contents-fixtures";

const ENTRY = "Click action…";
const LIVE_ID = "app-runner:open-live-captions";

type Method = (...args: unknown[]) => unknown;
const proto = AtlasExplorerView.prototype as unknown as Record<string, Method>;

const view: View = createEmptyView("v1", "Default");

const moduleNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "live", type: "unit", ref: { kind: "folder", path: "Live Captions" }, children: [], ...over });
const folderNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "apps", type: "meta", label: "Apps", children: [], ...over });
const API_SOURCE = { type: "api", url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge" } as unknown as ApiSourceConfig;
const row = (over: Partial<ApiItemState> = {}): ApiItemState => ({ id: "1", label: "Docker 4.34", kind: "placeholder", ...over });

function fakeHost() {
	return {
		plugin: {
			app: new App(),
			unitIndex: { getUnits: () => [{ type: "folder-unit", path: "Live Captions" }], isDismissed: () => false, isAdded: () => false },
			viewsManager: {
				getNode: () => null,
				managedRowFilterState: () => "shown",
				removeApiItem: vi.fn(),
				clearApiItemNoteRef: vi.fn(),
			},
			settings: { interfaceNoteAcceptAltNames: false },
			statusesManager: undefined,
		},
		startAddUnder: vi.fn(),
		startCreateFromMeta: vi.fn(),
		startCreateModule: vi.fn(),
		openStatusesModal: vi.fn(),
		openSwapPicker: vi.fn(),
		openClickActionModal: vi.fn(),
		duplicateFolder: vi.fn(),
		selectedBucketNodeIds: new Set<string>(),
	};
}

/** Runs one of the explorer's real menu builders against a fake host and returns the `Menu` it built. */
function build(method: string, args: unknown[], host = fakeHost()): { menu: Menu; host: ReturnType<typeof fakeHost> } {
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	proto[method].call(host, new MouseEvent("contextmenu"), ...args);
	show.mockRestore();
	return { menu: built!, host };
}

const unitMenu = (ref: UnitRef, node: ViewNode, outsideManaged = false) => build("showUnitMenu", [ref, view, node, "Name", [], outsideManaged]);
const metaMenu = (node: ViewNode) => build("showMetaFolderMenu", [node, view]);
const apiMenu = (owner: ViewNode, item: ApiItemState = row()) => {
	// T1: the menu reads the live row from ViewsManager, so the host holds this owner with the item in it.
	const host = fakeHost();
	owner.apiItemState = { [item.id]: item };
	host.plugin.viewsManager.getNode = () => owner;
	return build("showApiItemMenu", [view, owner, item], host);
};

beforeEach(() => {
	Menu.shownAtPosition = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("G15: the Click action… entry is offered on module, Folder and API item rows", () => {
	it("a module row has it, directly after Open in new tab and before Reveal in native explorer", () => {
		const titles = unitMenu({ kind: "folder", path: "Live Captions" }, moduleNode()).menu.titles();
		const at = titles.indexOf(ENTRY);
		expect(at).toBeGreaterThan(-1);
		expect(titles[at - 2]).toBe("Open");
		expect(titles[at - 1]).toBe("Open in new tab");
		expect(titles[at + 1]).toBe("Reveal in native explorer");
		expect(titles.filter((t) => t === ENTRY)).toHaveLength(1);
	});

	it("a Folder row has it first, in the top section", () => {
		const titles = metaMenu(folderNode()).menu.titles();
		expect(titles[0]).toBe(ENTRY);
		expect(titles.filter((t) => t === ENTRY)).toHaveLength(1);
	});

	it("an API item row has it first", () => {
		const titles = apiMenu(folderNode({ apiSource: API_SOURCE })).menu.titles();
		expect(titles[0]).toBe(ENTRY);
		expect(titles.filter((t) => t === ENTRY)).toHaveLength(1);
	});

	it("an API item row with an attachment keeps Open attachment and the Add actions after it", () => {
		const titles = apiMenu(folderNode({ apiSource: API_SOURCE }), row({ noteRef: { kind: "file", path: "Note.md" } })).menu.titles();
		expect(titles.slice(0, 5)).toEqual([ENTRY, "Open attachment", "Add note", "Add block", "Add module"]);
	});
});

describe("G15/F1: it is absent from every other row type and menu", () => {
	it.each<[string, UnitRef]>([
		["a file row", { kind: "file", path: "Note.md" }],
		["a block row", { kind: "block", path: "Note.md", subpath: "#^abc" }],
		["a free block row", { kind: "file", path: "_pool/20260101000000-abcd.md" }],
	])("%s", (_label, ref) => {
		expect(unitMenu(ref, moduleNode({ ref })).menu.titles()).not.toContain(ENTRY);
	});

	it("an Outside-Vault-managed module row, which has no Open either", () => {
		const { menu } = unitMenu({ kind: "folder", path: "Sub" }, moduleNode({ ref: { kind: "folder", path: "Sub" } }), true);
		expect(menu.titles()).not.toContain("Open");
		expect(menu.titles()).not.toContain(ENTRY);
	});

	it.each<[string, Partial<ViewNode>]>([
		["a Table row", { markdownTableSource: { type: "markdown-table" } as never }],
		["a CSV row", { csvSource: { type: "csv", path: "a.csv" } as never }],
		["a row of a Folder with no source at all", {}],
	])("%s", (_label, over) => {
		expect(apiMenu(folderNode(over)).menu.titles()).not.toContain(ENTRY);
	});

	it("an Inbox row, even a folder (module) one", () => {
		const host = fakeHost();
		(host.plugin.app.vault as unknown as { seedFolder: (p: string) => void }).seedFolder("Live Captions");
		const { menu } = build("showInboxUnitMenu", [{ kind: "folder", path: "Live Captions" }, view], host);
		expect(menu.titles()).toContain("Open");
		expect(menu.titles()).not.toContain(ENTRY);
	});

	it("the Bucket header menu (the empty-area menu)", () => {
		expect(build("showBucketHeaderMenu", [view]).menu.titles()).not.toContain(ENTRY);
	});

	it("a Module Contents row, file or folder", () => {
		const rig = makeModuleRig(["Mod/a.md", "Mod/sub/c.md"], ["Mod", "Mod/sub"]);
		const modal = rig.openModal();
		for (const name of ["a.md", "sub"]) expect(rightClick(itemRow(modal, name)).titles(), name).not.toContain(ENTRY);
	});
});

describe("choosing the entry opens the modal for exactly that row", () => {
	it("a module row", () => {
		const node = moduleNode();
		const { menu, host } = unitMenu({ kind: "folder", path: "Live Captions" }, node);
		clickMenuItem(menu, ENTRY);
		expect(host.openClickActionModal).toHaveBeenCalledWith(view, node);
	});

	it("a Folder row", () => {
		const node = folderNode();
		const { menu, host } = metaMenu(node);
		clickMenuItem(menu, ENTRY);
		expect(host.openClickActionModal).toHaveBeenCalledWith(view, node);
	});

	it("an API item row, with its owning Folder and the item", () => {
		const owner = folderNode({ apiSource: API_SOURCE });
		const item = row();
		const { menu, host } = apiMenu(owner, item);
		clickMenuItem(menu, ENTRY);
		expect(host.openClickActionModal).toHaveBeenCalledWith(view, owner, item);
	});
});

describe("the real openClickActionModal: Save writes through ViewsManager, storage only", () => {
	const select = () => document.querySelector<HTMLSelectElement>(".atlas-click-action-kind")!;
	const field = () => document.querySelector<HTMLInputElement>(".atlas-click-action-value input")!;
	const save = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Save")!;
	const chooseKind = (value: string) => {
		select().value = value;
		select().dispatchEvent(new Event("change", { bubbles: true }));
	};
	const typeInto = (value: string) => {
		field().value = value;
		field().dispatchEvent(new Event("input", { bubbles: true }));
	};

	function rig(nodes: ViewNode[]) {
		const v: View = { id: "v1", name: "Default", inboxMode: "view", root: nodes };
		const persisted = vi.fn();
		const views = new ViewsManager(new App(), [v], "v1", persisted);
		const host = { plugin: { app: new App(), viewsManager: views }, openClickActionModals: new Set() };
		(host.plugin.app as unknown as { commands: unknown }).commands = { commands: { [LIVE_ID]: { id: LIVE_ID, name: "App Runner: Open Live Captions" } } };
		const openModal = (node: ViewNode, item?: ApiItemState) => (proto.openClickActionModal as (...a: unknown[]) => void).call(host, v, node, item);
		return { views, persisted, host, openModal, v };
	}

	it("a module: pick the command, Save, and the node stores the id; reopening preloads it (GP1, GP2)", () => {
		const { views, openModal } = rig([moduleNode()]);
		openModal(views.getNode("v1", "live")!);
		expect(select().value).toBe("unset"); // GP1: Default
		chooseKind("command");
		const pickers: CommandPickerModal[] = [];
		vi.spyOn(CommandPickerModal.prototype, "open").mockImplementation(function (this: CommandPickerModal) {
			pickers.push(this);
		});
		document.querySelector<HTMLButtonElement>(".atlas-click-action-choose")!.click();
		const [match] = pickers[0].getSuggestions("live");
		pickers[0].onChooseSuggestion(match as never, new MouseEvent("click"));
		save().click();
		expect(views.getNode("v1", "live")!.clickAction).toEqual({ kind: "command", value: LIVE_ID });

		openModal(views.getNode("v1", "live")!);
		expect(select().value).toBe("command");
		expect(document.querySelector(".atlas-click-action-command-name")!.textContent).toBe("App Runner: Open Live Captions");
	});

	it("a module: Save of a URI stores it, and the same Save again changes and persists nothing", () => {
		const { views, persisted, openModal } = rig([moduleNode()]);
		openModal(views.getNode("v1", "live")!);
		chooseKind("uri");
		typeInto("obsidian://open?vault=Notes&file=Docker");
		save().click();
		expect(views.getNode("v1", "live")!.clickAction).toEqual({ kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" });
		expect(persisted).toHaveBeenCalledTimes(1);

		const before = JSON.stringify(views.getViews());
		openModal(views.getNode("v1", "live")!);
		expect(select().value).toBe("uri");
		save().click();
		expect(JSON.stringify(views.getViews())).toBe(before);
		expect(persisted).toHaveBeenCalledTimes(1);
	});

	it("a Folder: None plus Save stores it absent, removing a stored action's key entirely", () => {
		const { views, openModal } = rig([folderNode({ clickAction: { kind: "terminal", value: "open -a Docker" } })]);
		openModal(views.getNode("v1", "apps")!);
		expect(select().value).toBe("terminal");
		expect(field().value).toBe("open -a Docker");
		chooseKind("unset");
		save().click();
		expect("clickAction" in views.getNode("v1", "apps")!).toBe(false);
	});

	it("a Folder: an unbalanced-quote terminal value is refused, and nothing is stored", () => {
		const { views, persisted, openModal } = rig([folderNode()]);
		openModal(views.getNode("v1", "apps")!);
		expect(select().value).toBe("unset"); // None
		chooseKind("terminal");
		typeInto('open -a "Docker');
		expect(save().disabled).toBe(true);
		save().click();
		expect(views.getNode("v1", "apps")!.clickAction).toBeUndefined();
		expect(persisted).not.toHaveBeenCalled();
	});

	it("an API item: stores on the item's own state, not the Folder's, and offers Use source setting", () => {
		const owner = folderNode({ apiSource: API_SOURCE, apiItemState: { "1": row() }, apiItemOrder: ["1"] });
		const { views, openModal } = rig([owner]);
		const liveOwner = views.getNode("v1", "apps")!;
		openModal(liveOwner, liveOwner.apiItemState!["1"]);
		expect(Array.from(select().options)[0].textContent).toBe("Use source setting");
		chooseKind("uri");
		typeInto("obsidian://open?vault=Notes&file=Docker");
		save().click();
		expect(views.getNode("v1", "apps")!.apiItemState!["1"].clickAction).toEqual({ kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" });
		expect(views.getNode("v1", "apps")!.clickAction).toBeUndefined();
	});

	describe("an API item's Item override: None and Use source setting (G10)", () => {
		const apiRig = (item: ApiItemState = row()) => {
			const r = rig([folderNode({ apiSource: API_SOURCE, apiItemState: { "1": item }, apiItemOrder: ["1"] })]);
			const open = () => {
				const owner = r.views.getNode("v1", "apps")!;
				r.openModal(owner, owner.apiItemState!["1"]);
			};
			const stored = () => r.views.getNode("v1", "apps")!.apiItemState!["1"];
			return { ...r, open, stored };
		};

		it("offers Use source setting, None, then the three kinds, and no Default (open the interface note)", () => {
			apiRig().open();
			expect(Array.from(select().options).map((o) => o.textContent)).toEqual(["Use source setting", "None", "Run terminal command (desktop only)", "Run Obsidian command", "Open Obsidian URI"]);
			expect(select().value).toBe("unset"); // the Kind default is Use source setting
			expect(document.querySelector(".modal-title, .modal-header")?.textContent ?? "").not.toContain("Default");
		});

		it("None is stored as an explicit value, distinct from absent, and reopens as None", () => {
			const { open, stored, persisted } = apiRig();
			open();
			chooseKind("none");
			save().click();
			expect(stored().clickAction).toEqual({ kind: "none" });
			expect("clickAction" in stored()).toBe(true);
			expect(persisted).toHaveBeenCalledTimes(1);
			open();
			expect(select().value).toBe("none");
		});

		it("Use source setting clears the override: the key is absent, not None", () => {
			const { open, stored } = apiRig(row({ clickAction: { kind: "none" } }));
			open();
			expect(select().value).toBe("none");
			chooseKind("unset");
			save().click();
			expect("clickAction" in stored()).toBe(false);
		});

		it("switching from a stored command to Use source setting clears it", () => {
			const { open, stored } = apiRig(row({ clickAction: { kind: "command", value: LIVE_ID } }));
			open();
			chooseKind("unset");
			save().click();
			expect("clickAction" in stored()).toBe(false);
		});

		it("keeps the PR-2 validation on this surface: whitespace and unbalanced-quote terminal values and a bad URI block Save", () => {
			const { open, stored, persisted } = apiRig();
			open();
			chooseKind("terminal");
			typeInto("   ");
			expect(save().disabled).toBe(true);
			typeInto('open -a "Docker');
			expect(save().disabled).toBe(true);
			chooseKind("uri");
			typeInto("not a uri");
			expect(save().disabled).toBe(true);
			save().click();
			expect(stored().clickAction).toBeUndefined();
			expect(persisted).not.toHaveBeenCalled();
		});

		it("the command kind stores the id from the picker", () => {
			const { open, stored } = apiRig();
			open();
			chooseKind("command");
			const pickers: CommandPickerModal[] = [];
			vi.spyOn(CommandPickerModal.prototype, "open").mockImplementation(function (this: CommandPickerModal) {
				pickers.push(this);
			});
			document.querySelector<HTMLButtonElement>(".atlas-click-action-choose")!.click();
			pickers[0].onChooseSuggestion(pickers[0].getSuggestions("live")[0] as never, new MouseEvent("click"));
			save().click();
			expect(stored().clickAction).toEqual({ kind: "command", value: LIVE_ID });
		});

		it("a module and a Folder are never offered None, and a stored None on one opens as the default", () => {
			const { views, openModal } = rig([moduleNode({ clickAction: { kind: "none" } as never }), folderNode()]);
			openModal(views.getNode("v1", "live")!);
			expect(Array.from(select().options).map((o) => o.value)).not.toContain("none");
			expect(select().value).toBe("unset");
		});
	});

	it("Cancel stores nothing and the modal is dropped from the view's open set", () => {
		const { views, persisted, openModal, host } = rig([moduleNode()]);
		openModal(views.getNode("v1", "live")!);
		expect(host.openClickActionModals.size).toBe(1);
		chooseKind("uri");
		typeInto("obsidian://open?file=A");
		Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Cancel")!.click();
		expect(views.getNode("v1", "live")!.clickAction).toBeUndefined();
		expect(persisted).not.toHaveBeenCalled();
		expect(host.openClickActionModals.size).toBe(0);
	});

	it("opens preloaded from the live node, not from a stale snapshot taken when the menu was built", () => {
		const { views, openModal } = rig([moduleNode()]);
		const stale = views.getNode("v1", "live")!;
		views.setClickAction("v1", "live", { kind: "command", value: LIVE_ID });
		openModal(stale);
		expect(select().value).toBe("command");
	});

	it("ViewsManager refuses an action on a node that is not a module or Folder, and an unsaveable one", () => {
		const file: ViewNode = { id: "f", type: "unit", ref: { kind: "file", path: "Note.md" }, children: [] };
		const { views } = rig([file, moduleNode()]);
		expect(views.setClickAction("v1", "f", { kind: "uri", value: "obsidian://x" })).toBe(false);
		expect(views.getNode("v1", "f")!.clickAction).toBeUndefined();
		expect(views.setClickAction("v1", "live", { kind: "uri", value: "   " })).toBe(false);
		expect(views.setClickAction("v1", "live", { kind: "shell", value: "ls" } as never)).toBe(false);
		expect(views.getNode("v1", "live")!.clickAction).toBeUndefined();
		expect(views.setClickAction("v1", "missing", { kind: "uri", value: "obsidian://x" })).toBe(false);
	});
});
