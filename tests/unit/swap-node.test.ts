import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { ViewsManager } from "../../src/views";
import { ApplyToConfig, StatusGovernance, UnitRef, View, ViewNode } from "../../src/types";

const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });
const meta = (id: string, label: string, children: ViewNode[] = [], extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "meta", label, children, ...extra });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A source the view loader keeps: `sanitizeApiFields` drops one without an id and label mapping. */
const apiSource = (url: string): ViewNode["apiSource"] => ({
	type: "api",
	url,
	method: "GET",
	mapping: { idField: "id", labelField: "name" },
	mode: "append",
	refreshOnViewLoad: false,
});

const FILE: UnitRef = { kind: "file", path: "Customer Discovery.md" };
const FOLDER: UnitRef = { kind: "folder", path: "Boat" };
const BLOCK: UnitRef = { kind: "block", path: "Notes.md", subpath: "^abc123" };

let app: App;
let persist: ReturnType<typeof vi.fn>;
let listener: ReturnType<typeof vi.fn>;

function manager(root: ViewNode[]): ViewsManager {
	const view: View = { id: "v1", name: "Default", inboxMode: "view", root };
	const m = new ViewsManager(app, [view], "v1", persist);
	m.onChange(listener);
	return m;
}

beforeEach(() => {
	app = new App();
	persist = vi.fn();
	listener = vi.fn();
});

describe("swapNodeWithUnit (PR-2 G8/G9/G10)", () => {
	it("rewrites type and ref in place: same index, same id, no label", () => {
		const spot = meta("spot", "Customer interviews", [unit("n1", { kind: "file", path: "n1.md" })]);
		const m = manager([unit("A", { kind: "file", path: "A.md" }), spot]);
		expect(m.swapNodeWithUnit("v1", "spot", FILE)).toBe(true);
		const root = m.getView("v1")!.root;
		expect(root.map((n) => n.id)).toEqual(["A", "spot"]);
		expect(root[1].type).toBe("unit");
		expect(root[1].ref).toEqual(FILE);
		expect("label" in root[1]).toBe(false);
	});

	it("keeps nested children untouched, including their own ids and refs", () => {
		const children = [unit("c1", { kind: "file", path: "c1.md" }), meta("c2", "Inner", [unit("c3", { kind: "folder", path: "Inner" })])];
		const m = manager([meta("spot", "Interviews", clone(children))]);
		m.swapNodeWithUnit("v1", "spot", FILE);
		expect(m.getView("v1")!.root[0].children).toEqual(children);
	});

	it("keeps status, source and cache fields on the spot", () => {
		const sourced = meta("spot", "Linear issues", [], {
			statusEnabled: true,
			statusSetId: "set1",
			explicitStatusId: "s-doing",
			apiSource: apiSource("https://example.test/rows"),
			apiCache: { lastRefreshedAt: "2026-10-05T00:00:00.000Z", status: "ok" } as ViewNode["apiCache"],
			apiItemOrder: ["r1", "r2"],
			apiItemState: { r1: { id: "r1", label: "Row 1", kind: "placeholder" } },
		});
		const m = manager([sourced]);
		const before = clone(m.getView("v1")!.root[0]);
		m.swapNodeWithUnit("v1", "spot", FILE);
		const after = m.getView("v1")!.root[0];
		expect(before.apiSource).toBeDefined();
		expect(after.statusEnabled).toBe(before.statusEnabled);
		expect(after.statusSetId).toBe(before.statusSetId);
		expect(after.explicitStatusId).toBe("s-doing");
		expect(after.apiSource).toEqual(before.apiSource);
		expect(after.apiCache).toEqual(before.apiCache);
		expect(after.apiItemOrder).toEqual(before.apiItemOrder);
		expect(after.apiItemState).toEqual(before.apiItemState);
	});

	it("saves and notifies listeners on success", () => {
		const m = manager([meta("spot", "Interviews")]);
		m.swapNodeWithUnit("v1", "spot", FILE);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("accepts a block ref", () => {
		const m = manager([meta("spot", "Interviews")]);
		expect(m.swapNodeWithUnit("v1", "spot", BLOCK)).toBe(true);
		expect(m.getView("v1")!.root[0].ref).toEqual(BLOCK);
	});

	it("refuses a folderSourceManaged node, changing nothing and not saving", () => {
		const managed = unit("managed", { kind: "file", path: "linked.md" }, { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const before = clone(managed);
		const m = manager([managed]);
		expect(m.swapNodeWithUnit("v1", "managed", FILE)).toBe(false);
		expect(m.getView("v1")!.root[0]).toEqual(before);
		expect(persist).not.toHaveBeenCalled();
	});

	it("refuses a swap to the node's own current ref", () => {
		const m = manager([unit("spot", FILE)]);
		expect(m.swapNodeWithUnit("v1", "spot", FILE)).toBe(false);
		expect(persist).not.toHaveBeenCalled();
	});

	it("returns false for a missing node, a missing view, or a row id that isn't in the tree", () => {
		const m = manager([unit("A", FILE)]);
		expect(m.swapNodeWithUnit("v1", "nope", FOLDER)).toBe(false);
		expect(m.swapNodeWithUnit("missing-view", "A", FOLDER)).toBe(false);
		expect(m.swapNodeWithUnit("v1", "api-row-id-not-in-tree", FOLDER)).toBe(false);
		expect(persist).not.toHaveBeenCalled();
	});
});

describe("swapNodeForAtlasFolder (PR-2 G4/G9)", () => {
	it("turns a unit into a meta node with the typed label, dropping its ref, in place", () => {
		const m = manager([unit("A", FILE), unit("spot", { kind: "file", path: "Boat.md" }), unit("B", FOLDER)]);
		expect(m.swapNodeForAtlasFolder("v1", "spot", "Boat")).toBe(true);
		const root = m.getView("v1")!.root;
		expect(root.map((n) => n.id)).toEqual(["A", "spot", "B"]);
		expect(root[1]).toMatchObject({ id: "spot", type: "meta", label: "Boat" });
		expect("ref" in root[1]).toBe(false);
	});

	it("keeps the spot's nested items and its data source", () => {
		const kids = [unit("k1", FILE)];
		const m = manager([unit("spot", { kind: "file", path: "Boat.md" }, { children: kids, apiSource: apiSource("https://x.test") })]);
		const sourceBefore = clone(m.getView("v1")!.root[0].apiSource);
		m.swapNodeForAtlasFolder("v1", "spot", "Boat");
		const node = m.getView("v1")!.root[0];
		expect(node.children).toEqual(kids);
		expect(node.apiSource).toEqual(sourceBefore);
	});

	it("trims the label", () => {
		const m = manager([unit("spot", FILE)]);
		m.swapNodeForAtlasFolder("v1", "spot", "  Boat  ");
		expect(m.getView("v1")!.root[0].label).toBe("Boat");
	});

	it("refuses an empty or whitespace-only label", () => {
		const m = manager([unit("spot", FILE)]);
		expect(m.swapNodeForAtlasFolder("v1", "spot", "   ")).toBe(false);
		expect(m.getView("v1")!.root[0].type).toBe("unit");
		expect(persist).not.toHaveBeenCalled();
	});

	it("refuses a node that is already an Atlas folder", () => {
		const m = manager([meta("m", "Existing")]);
		expect(m.swapNodeForAtlasFolder("v1", "m", "Other")).toBe(false);
		expect(m.getView("v1")!.root[0].label).toBe("Existing");
	});

	it("refuses a folderSourceManaged node", () => {
		const m = manager([unit("managed", FILE, { folderSourceManaged: true })]);
		expect(m.swapNodeForAtlasFolder("v1", "managed", "Boat")).toBe(false);
		expect(m.getView("v1")!.root[0].type).toBe("unit");
	});
});

describe("explicitStatusId survives swaps (PR-2 G10/E6)", () => {
	const applyTo = (over: ApplyToConfig): ApplyToConfig => ({ block: true, file: true, module: true, metaFolder: true, ...over });
	const statusSet: StatusSet = {
		id: "set1",
		name: "Work",
		statuses: [
			{ id: "s-todo", label: "To do", color: "#888888" },
			{ id: "s-doing", label: "Doing", color: "#3366ff" },
		],
		defaultStatusId: "s-todo",
	};

	/** A parent governor whose status set applies to modules but not files. */
	function governor(): StatusGovernance {
		return { statusEnabled: true, statusSetId: "set1", inheritToSubfolders: false, applyTo: applyTo({ file: false }) };
	}

	it("hides the status when the swapped-in kind is excluded, then shows it again after swapping back", () => {
		const statuses = new StatusesManager([statusSet], [], vi.fn());
		const spot = unit("spot", FOLDER, { explicitStatusId: "s-doing" });
		const m = manager([spot]);
		const ancestors = [governor()];

		const shown = statuses.resolveNodeStatus(ancestors, m.getView("v1")!.root[0]);
		expect(shown?.id).toBe("s-doing");

		m.swapNodeWithUnit("v1", "spot", FILE);
		const hidden = m.getView("v1")!.root[0];
		expect(statuses.resolveNodeStatus(ancestors, hidden)).toBeNull();
		expect(hidden.explicitStatusId).toBe("s-doing");

		m.swapNodeWithUnit("v1", "spot", FOLDER);
		const back = m.getView("v1")!.root[0];
		expect(statuses.resolveNodeStatus(ancestors, back)?.id).toBe("s-doing");
	});

	it("keeps the explicit status through an Atlas-folder swap", () => {
		const m = manager([unit("spot", FILE, { explicitStatusId: "s-doing" })]);
		m.swapNodeForAtlasFolder("v1", "spot", "Boat");
		expect(m.getView("v1")!.root[0].explicitStatusId).toBe("s-doing");
	});
});

describe("swap survives a reload (PR-2 G14)", () => {
	it("the saved views reload with the swapped state and no trace of the old item", () => {
		const m = manager([meta("spot", "Interviews", [unit("c1", { kind: "file", path: "c1.md" })])]);
		m.swapNodeWithUnit("v1", "spot", FILE);
		const saved = clone(m.getViews());
		const reloaded = new ViewsManager(app, saved, "v1", vi.fn());
		const node = reloaded.getView("v1")!.root[0];
		expect(node).toMatchObject({ id: "spot", type: "unit", ref: FILE });
		expect(node.children.map((c) => c.id)).toEqual(["c1"]);
		expect(reloaded.isPlacedAnywhere({ kind: "folder", path: "Interviews" })).toBe(false);
	});
});
