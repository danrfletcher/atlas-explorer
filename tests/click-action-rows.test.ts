import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";
import { App, Notice, Platform } from "obsidian";
import { AtlasExplorerView } from "../src/explorer-view";
import { ClickActionRunner } from "../src/click-action-runner";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createEmptyView } from "../src/types";
import type { ApiItemState, ClickAction, UnitRef, View, ViewNode } from "../src/types";
import { makeModuleRig, itemRow } from "./unit/module-contents-fixtures";

vi.mock("../src/status-popup", () => ({ openStatusPickerPopup: vi.fn() }));
import { openStatusPickerPopup } from "../src/status-popup";

/** Click actions on rendered Bucket rows: the REAL `renderNode`, `handleSelectionClick`, `handleRowKeydown`,
 * `renderRowIcon`, `wireModuleRow`, `renderFoldableChildren` and `runClickAction`, driven through the
 * fake-`this` `.call(fake, ...)` pattern used by the middle-click wiring tests. What is faked: the vault
 * (an in-memory one), `openRef`, the drop zones, the child list renderer, the status manager, `spawn`, and the
 * Obsidian command registry. Fake timers: the Folder fold persists on a 160 ms timer and the runner debounces. */

type Proto = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as Proto;

const LIVE: ClickAction = { kind: "command", value: "app-runner:open-live-captions" };
const DOCKER: ClickAction = { kind: "terminal", value: "open -a Docker" };

const moduleRef: UnitRef = { kind: "folder", path: "Live Captions" };
const noActionRef: UnitRef = { kind: "folder", path: "Plain" };
const fileRef: UnitRef = { kind: "file", path: "Note.md" };
const blockRef: UnitRef = { kind: "block", path: "_pool/20260101000000-abcd.md", subpath: "^abcd" };

const view: View = createEmptyView("v1", "Default");

function seedApp(): App {
	const app = new App();
	app.vault.seedFolder("Live Captions");
	app.vault.seedFile("Live Captions/Live Captions.md");
	app.vault.seedFolder("Plain");
	app.vault.seedFile("Plain/Plain.md");
	app.vault.seedFile("Note.md");
	app.vault.seedFolder("_pool");
	app.vault.seedFile("_pool/20260101000000-abcd.md");
	return app;
}

interface Rig {
	fake: Record<string, ReturnType<typeof vi.fn>> & { selectedBucketNodeIds: Set<string>; clickActionRunner: ClickActionRunner | null };
	executeCommandById: ReturnType<typeof vi.fn>;
	spawnCalls: { executable: string; args: string[]; options: Record<string, unknown> }[];
	setNodeCollapsed: ReturnType<typeof vi.fn>;
	setExplicitStatus: ReturnType<typeof vi.fn>;
	openModuleContentsModal: ReturnType<typeof vi.fn>;
}

function makeRig(app: App, opts: { status?: boolean } = {}): Rig {
	const executeCommandById = vi.fn((_id: string) => true);
	(app as unknown as { commands: unknown }).commands = { executeCommandById };
	const spawnCalls: Rig["spawnCalls"] = [];
	const spawnImpl = ((executable: string, args: string[], options: Record<string, unknown>) => {
		spawnCalls.push({ executable, args, options });
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child;
	}) as never;
	const setNodeCollapsed = vi.fn();
	const setExplicitStatus = vi.fn();
	const openModuleContentsModal = vi.fn();
	const status = { id: "todo", label: "Todo", color: "#f00" };
	const fake: Record<string, unknown> = {
		plugin: {
			app,
			settings: { ...DEFAULT_SETTINGS },
			viewsManager: { managedRowFilterState: vi.fn(() => "shown"), setNodeCollapsed, setExplicitStatus },
			statusesManager: {
				findSortGovernor: () => null,
				resolveNodeStatus: () => (opts.status ? status : null),
				findGoverningAncestor: () => ({ statusSetId: "set1" }),
				getStatusSet: () => ({ id: "set1", statuses: [status] }),
			},
			flushSave: vi.fn(async () => {}),
		},
		selectedBucketNodeIds: new Set<string>(),
		selectedInboxRefKeys: new Set<string>(),
		selectionAnchor: null,
		selectionAnchorScope: null,
		inboxSelectOrder: [] as string[],
		filterText: "",
		clickActionRunner: new ClickActionRunner({ app: app as never, spawnImpl }),
		isOutsideManagedUnit: vi.fn(() => false),
		resolveOutsideManagedRowInfo: vi.fn(),
		resolveRef: vi.fn(async (ref: UnitRef) => ({ text: ref.path, icon: ref.kind === "folder" ? "folder" : "file", promoted: false, added: false, missing: false })),
		matchesFilter: vi.fn(() => true),
		setPlacementTooltip: vi.fn(),
		bucketVisibleOrder: vi.fn(() => []),
		openRef: vi.fn(async () => {}),
		makeDropZone: vi.fn(),
		buildNodeDragPayload: vi.fn(() => ({})),
		showUnitMenu: vi.fn(),
		showMetaFolderMenu: vi.fn(),
		renderSortIndicator: vi.fn(),
		renderNodeList: vi.fn(async () => {}),
		computeEffectiveCollapsed: vi.fn(async (node: ViewNode) => !!node.collapsed),
		openModuleContentsModal,
		render: vi.fn(async () => {}),
	};
	for (const name of ["renderRowIcon", "renderConnectionDots", "renderFoldableChildren", "wireModuleRow", "handleRowKeydown", "runClickAction"]) {
		fake[name] = (...args: unknown[]) => proto[name].call(fake, ...args);
	}
	fake.handleSelectionClick = vi.fn((...args: unknown[]) => proto.handleSelectionClick.call(fake, ...args));
	return { fake: fake as Rig["fake"], executeCommandById, spawnCalls, setNodeCollapsed, setExplicitStatus, openModuleContentsModal };
}

const moduleNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "live", type: "unit", ref: moduleRef, children: [], clickAction: LIVE, ...over });
const folderNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "apps", type: "meta", label: "Apps", children: [], clickAction: DOCKER, ...over });

async function render(rig: Rig, node: ViewNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	await (proto.renderNode as (...a: unknown[]) => Promise<void>).call(rig.fake, node, container, view, 0, []);
	return container.querySelector<HTMLElement>(".atlas-row-unit, .atlas-row-meta")!;
}

const label = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-row-text")!;
const click = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
const key = (row: HTMLElement, k: string, init: KeyboardEventInit = {}) => row.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

/** Nothing of any kind ran. */
function expectNothingRan(rig: Rig, openSpy: MockInstance<typeof window.open>) {
	expect(rig.executeCommandById).not.toHaveBeenCalled();
	expect(rig.spawnCalls).toEqual([]);
	expect(openSpy).not.toHaveBeenCalled();
}

let app: App;
let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
	(Platform as { isMobile: boolean }).isMobile = false;
	app = seedApp();
	Notice.reset();
	openSpy = vi.spyOn(window, "open").mockImplementation(() => ({}) as Window);
	vi.mocked(openStatusPickerPopup).mockClear();
});

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("G3/GP3: a module with an action", () => {
	it("a plain click runs it and does not open the module's note", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		click(label(row));
		expect(rig.executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-live-captions");
		expect(rig.fake.openRef).not.toHaveBeenCalled();
		expect(Notice.instances).toEqual([]);
	});

	it("the runner is built on first use from the plugin's app (no injected runner)", async () => {
		const rig = makeRig(app);
		rig.fake.clickActionRunner = null;
		const row = await render(rig, moduleNode());
		click(label(row));
		expect(rig.executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-live-captions");
		expect(rig.fake.clickActionRunner).toBeInstanceOf(ClickActionRunner);
	});

	it("a plain click still selects the row", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		click(label(row));
		expect(rig.fake.selectedBucketNodeIds).toEqual(new Set(["live"]));
	});

	it("Enter runs it and does not open the note; the key press is consumed", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		row.dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(true);
		expect(rig.executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-live-captions");
		expect(rig.fake.openRef).not.toHaveBeenCalled();
	});

	it("uri kind: window.open gets the stored value untouched", async () => {
		const rig = makeRig(app);
		const uri = "obsidian://open?vault=Notes&file=Live%20Captions";
		const row = await render(rig, moduleNode({ clickAction: { kind: "uri", value: uri } }));
		click(label(row));
		expect(openSpy).toHaveBeenCalledExactlyOnceWith(uri);
	});

	it("a second click within 1 s is ignored; after 1 s it runs again (E9)", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		click(label(row));
		vi.advanceTimersByTime(500);
		click(label(row));
		expect(rig.executeCommandById).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(500);
		click(label(row));
		expect(rig.executeCommandById).toHaveBeenCalledTimes(2);
	});

	it("an unregistered command id shows the notice and the stored action is kept (E1)", async () => {
		const rig = makeRig(app);
		rig.executeCommandById.mockReturnValue(false);
		const node = moduleNode();
		const row = await render(rig, node);
		click(label(row));
		await vi.advanceTimersByTimeAsync(0);
		expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: command not found: app-runner:open-live-captions"]);
		expect(node.clickAction).toEqual(LIVE);
	});

	it("a terminal action on mobile shows the desktop-only notice, spawns nothing and keeps the setting (G13/E17)", async () => {
		(Platform as { isMobile: boolean }).isMobile = true;
		const rig = makeRig(app);
		const node = moduleNode({ clickAction: DOCKER });
		const row = await render(rig, node);
		click(label(row));
		await vi.advanceTimersByTimeAsync(0);
		expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: terminal actions are desktop only"]);
		expect(rig.spawnCalls).toEqual([]);
		expect(node.clickAction).toEqual(DOCKER);
		(Platform as { isMobile: boolean }).isMobile = false;
	});
});

describe("a module with no action behaves as before (G3, E13)", () => {
	it("a plain click opens the note and runs nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode({ id: "plain", ref: noActionRef, clickAction: undefined }));
		click(label(row));
		expect(rig.fake.openRef).toHaveBeenCalledExactlyOnceWith(noActionRef);
		expectNothingRan(rig, openSpy);
	});

	it("Enter still calls openRef", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode({ id: "plain", ref: noActionRef, clickAction: undefined }));
		key(row, "Enter");
		expect(rig.fake.openRef).toHaveBeenCalledExactlyOnceWith(noActionRef);
		expectNothingRan(rig, openSpy);
	});

	it("a malformed stored action is treated as none: the note opens (hand-edited data.json)", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode({ clickAction: { kind: "shell", value: "rm -rf /" } as never }));
		click(label(row));
		key(row, "Enter");
		expect(rig.fake.openRef).toHaveBeenCalledTimes(2);
		expectNothingRan(rig, openSpy);
	});
});

describe("GP4: right-click and middle-click never run the action", () => {
	it("middle-click (auxclick) opens the note in a new tab, changes no selection and runs nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		label(row).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
		expect(rig.fake.openRef).toHaveBeenCalledExactlyOnceWith(moduleRef, true);
		expect(rig.fake.selectedBucketNodeIds.size).toBe(0);
		expectNothingRan(rig, openSpy);
	});

	it("right-click shows the unit menu and runs nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		expect(rig.fake.showUnitMenu).toHaveBeenCalledTimes(1);
		expectNothingRan(rig, openSpy);
	});

	it("a Folder row's middle-click opens nothing and runs nothing (F11)", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode());
		label(row).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
		expect(rig.fake.openRef).not.toHaveBeenCalled();
		expectNothingRan(rig, openSpy);
	});
});

describe("E18/F5: modifier clicks keep their selection meaning and never run", () => {
	it.each([["shift"], ["meta"], ["ctrl"], ["alt"]])("%s-click on a module", async (mod) => {
		const rig = makeRig(app);
		rig.fake.selectionAnchor = "other";
		const row = await render(rig, moduleNode());
		click(label(row), { [`${mod}Key`]: true });
		expectNothingRan(rig, openSpy);
		expect(rig.fake.openRef).not.toHaveBeenCalled();
	});

	it.each([["shift"], ["meta"], ["ctrl"], ["alt"]])("%s-click on a Folder", async (mod) => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode());
		click(label(row), { [`${mod}Key`]: true });
		expectNothingRan(rig, openSpy);
	});

	it("cmd-click still toggles the selection, and a shift-click with an anchor still range-selects", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		click(label(row), { metaKey: true });
		expect(rig.fake.selectedBucketNodeIds).toEqual(new Set(["live"]));
		click(label(row), { metaKey: true });
		expect(rig.fake.selectedBucketNodeIds.size).toBe(0);
		expect(rig.fake.handleSelectionClick).toHaveBeenCalledTimes(2);
		expectNothingRan(rig, openSpy);
	});

	it.each([["shiftKey"], ["metaKey"], ["ctrlKey"], ["altKey"]])("Enter with %s does not run", async (mod) => {
		const rig = makeRig(app);
		const moduleRow = await render(rig, moduleNode());
		const folderRow = await render(rig, folderNode());
		key(moduleRow, "Enter", { [mod]: true });
		key(folderRow, "Enter", { [mod]: true });
		expectNothingRan(rig, openSpy);
	});

	it("a held Enter (key repeat) does not run", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		key(row, "Enter", { repeat: true });
		expectNothingRan(rig, openSpy);
	});

	it("a click that a long-press already swallowed (default prevented) does not run", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		row.addEventListener("click", (e) => e.preventDefault(), true);
		click(row);
		expectNothingRan(rig, openSpy);
	});
});

describe("E11/F5: controls keep their own jobs on a module row", () => {
	it("a status dot click opens the status popup and runs nothing", async () => {
		const rig = makeRig(app, { status: true });
		const row = await render(rig, moduleNode());
		const circle = row.querySelector<HTMLElement>(".atlas-status-dot-circle")!;
		expect(circle).not.toBeNull();
		click(circle);
		expect(openStatusPickerPopup).toHaveBeenCalledTimes(1);
		expectNothingRan(rig, openSpy);
	});

	it("a click on the status dot's own padding (not the circle) does not run either", async () => {
		const rig = makeRig(app, { status: true });
		const row = await render(rig, moduleNode());
		click(row.querySelector(".atlas-icon")!);
		expectNothingRan(rig, openSpy);
	});

	it("a click on the module icon opens Module Contents and runs nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		click(row.querySelector(".atlas-icon")!);
		expect(rig.openModuleContentsModal).toHaveBeenCalledExactlyOnceWith("Live Captions");
		expectNothingRan(rig, openSpy);
	});

	it("a click on the module icon does not run even where the icon's own handler is absent", async () => {
		const rig = makeRig(app);
		rig.fake.wireModuleRow = vi.fn();
		const row = await render(rig, moduleNode());
		click(row.querySelector(".atlas-icon")!);
		expectNothingRan(rig, openSpy);
	});

	it.each(["atlas-badge", "atlas-api-connection-dot", "atlas-sort-indicator", "atlas-row-action"])("a click on .%s does not run", async (cls) => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		const control = row.createDiv({ cls });
		click(control.createSpan());
		expectNothingRan(rig, openSpy);
	});

	it("a long-press release (the swallowed click) does not run, and the hold opens Module Contents", async () => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode());
		row.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true, clientX: 5, clientY: 5 }));
		vi.advanceTimersByTime(500);
		expect(rig.openModuleContentsModal).toHaveBeenCalledExactlyOnceWith("Live Captions");
		row.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		click(label(row));
		expectNothingRan(rig, openSpy);
		// and the next ordinary click runs it again
		click(label(row));
		expect(rig.executeCommandById).toHaveBeenCalledTimes(1);
	});
});

describe("GP6/E13/F12: a Folder with an action", () => {
	it("a click spawns the argv with no shell and does not fold", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode());
		click(label(row));
		await vi.advanceTimersByTimeAsync(300);
		expect(rig.spawnCalls).toHaveLength(1);
		expect([rig.spawnCalls[0].executable, ...rig.spawnCalls[0].args]).toEqual(["open", "-a", "Docker"]);
		expect(rig.spawnCalls[0].options.shell).toBe(false);
		expect(rig.setNodeCollapsed).not.toHaveBeenCalled();
		expect(row.nextElementSibling?.classList.contains("is-collapsed")).toBeFalsy();
	});

	it("Enter runs it, does not fold, and is consumed", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode());
		const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		row.dispatchEvent(evt);
		await vi.advanceTimersByTimeAsync(300);
		expect(evt.defaultPrevented).toBe(true);
		expect(rig.spawnCalls).toHaveLength(1);
		expect(rig.setNodeCollapsed).not.toHaveBeenCalled();
	});

	it("Space still folds and runs nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode({ collapsed: false }));
		key(row, " ");
		expect(rig.setNodeCollapsed).toHaveBeenCalledExactlyOnceWith("v1", "apps", true);
		expectNothingRan(rig, openSpy);
	});

	it("the chevron still folds (after the 160 ms transition) and runs nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode({ collapsed: false }));
		click(row.querySelector(".atlas-chevron")!);
		await vi.advanceTimersByTimeAsync(200);
		expect(rig.setNodeCollapsed).toHaveBeenCalledExactlyOnceWith("v1", "apps", true);
		expectNothingRan(rig, openSpy);
	});

	it("a click on a Folder's status dot opens the status popup and runs nothing", async () => {
		const rig = makeRig(app, { status: true });
		const row = await render(rig, folderNode());
		click(row.querySelector(".atlas-status-dot-circle")!);
		expect(openStatusPickerPopup).toHaveBeenCalledTimes(1);
		click(row.querySelector(".atlas-icon")!);
		expectNothingRan(rig, openSpy);
	});

	it("a click on the Folder's connection dot or sort indicator does not run", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode());
		for (const cls of ["atlas-api-connection-dot", "atlas-sort-indicator"]) click(row.createDiv({ cls }));
		expectNothingRan(rig, openSpy);
	});

	it("a Folder with a {field} placeholder gives the resolve error at click and spawns nothing", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode({ clickAction: { kind: "terminal", value: "open {path}" } }));
		click(label(row));
		await vi.advanceTimersByTimeAsync(0);
		expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: Missing value for placeholder: {path}"]);
		expect(rig.spawnCalls).toEqual([]);
	});

	it("a Folder with no action: click and Enter do nothing, Space still folds", async () => {
		const rig = makeRig(app);
		const row = await render(rig, folderNode({ clickAction: undefined, collapsed: false }));
		click(label(row));
		const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		row.dispatchEvent(enter);
		expect(enter.defaultPrevented).toBe(false);
		expectNothingRan(rig, openSpy);
		expect(rig.setNodeCollapsed).not.toHaveBeenCalled();
		key(row, " ");
		expect(rig.setNodeCollapsed).toHaveBeenCalledTimes(1);
	});

	it("running writes nothing to the vault (F11)", async () => {
		const rig = makeRig(app);
		app.vault.calls.length = 0;
		const row = await render(rig, folderNode());
		click(label(row));
		await vi.advanceTimersByTimeAsync(0);
		expect(app.vault.calls).toEqual([]);
	});
});

describe("G14/F1: rows that get no click action", () => {
	it.each<[string, UnitRef]>([
		["a file row", fileRef],
		["a block row", blockRef],
	])("%s never runs, even with a clickAction hand-written into data.json", async (_label, ref) => {
		const rig = makeRig(app);
		const row = await render(rig, moduleNode({ id: "x", ref }));
		click(label(row));
		key(row, "Enter");
		expect(rig.fake.openRef).toHaveBeenCalledTimes(2);
		expectNothingRan(rig, openSpy);
	});

	it("an Outside-Vault-managed module never runs and opens nothing", async () => {
		const rig = makeRig(app);
		rig.fake.isOutsideManagedUnit.mockReturnValue(true);
		rig.fake.resolveOutsideManagedRowInfo.mockReturnValue({ text: "Live Captions", icon: "folder", promoted: false, added: false, missing: false });
		const row = await render(rig, moduleNode());
		click(label(row));
		key(row, "Enter");
		expect(rig.fake.openRef).not.toHaveBeenCalled();
		expectNothingRan(rig, openSpy);
	});

	it("an Inbox row for a module that also has a Bucket action: click opens its note, nothing runs", () => {
		const rig = makeRig(app);
		rig.fake.unitIndex = undefined as never;
		const container = document.createElement("div");
		document.body.appendChild(container);
		(proto.renderInboxRow as (...a: unknown[]) => HTMLElement).call(rig.fake, container, moduleRef, { text: "Live Captions", icon: "folder", promoted: false, added: false, missing: false }, view, false);
		const row = container.firstElementChild as HTMLElement;
		click(label(row));
		key(row, "Enter");
		expect(rig.fake.openRef).toHaveBeenCalled();
		expectNothingRan(rig, openSpy);
	});

	it.each([["a Table row", { markdownTableSource: { type: "markdown-table" } }], ["a CSV row", { csvSource: { type: "csv", path: "a.csv" } }]])(
		"%s with a hand-written Item override never runs",
		(_label, source) => {
			const rig = makeRig(app);
			const item: ApiItemState = { id: "1", label: "Row", kind: "placeholder", clickAction: LIVE };
			rig.fake.handleApiItemClick = vi.fn((...args: unknown[]) => proto.handleApiItemClick.call(rig.fake, ...args));
			rig.fake.pseudoNodeForApiItem = (i: unknown) => proto.pseudoNodeForApiItem.call(rig.fake, i) as never;
			rig.fake.renderRowIcon = vi.fn() as never;
			const owner = { id: "owner", type: "meta", children: [], ...source, apiItemState: { "1": item } } as unknown as ViewNode;
			const container = document.createElement("div");
			document.body.appendChild(container);
			(proto.renderApiItemRow as (...a: unknown[]) => void).call(rig.fake, item, container, view, owner, 1, []);
			click(container.querySelector(".atlas-row-text")!);
			expectNothingRan(rig, openSpy);
		}
	);

	it("a Module Contents row (file and folder) never runs anything", () => {
		vi.useRealTimers(); // the modal draws its rows without the fake clock
		const rig = makeModuleRig(["Mod/a.md", "Mod/sub/c.md"], ["Mod", "Mod/sub"]);
		const executeCommandById = vi.fn(() => true);
		(rig.app as unknown as { commands: unknown }).commands = { executeCommandById };
		const modal = rig.openModal();
		const rows = ["a.md", "sub"].map((name) => itemRow(modal, name)); // looked up first: a click may redraw the modal
		for (const row of rows) {
			click(row);
			row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		}
		expect(executeCommandById).not.toHaveBeenCalled();
		expect(openSpy).not.toHaveBeenCalled();
	});
});
