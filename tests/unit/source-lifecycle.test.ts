import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { ViewsManager, nodeHasApiRows } from "../../src/views";
import { ApiSourceConfig, CsvSourceConfig } from "../../src/types";

/** G4/G7/E6/E7: exercises `ViewsManager`'s source-lifecycle operations — "Remove data source" (G4),
 * "Duplicate Folder" (G7), Folder deletion's itemState cleanup (E6), and E7's promotion carry-over
 * invariant (documented-only, per `types.ts` — the actual conversion code doesn't exist anywhere in
 * this repo yet, matching PR-2's own precedent). */

function makeSource(overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		...overrides,
	};
}

function makeCsvSource(overrides: Partial<CsvSourceConfig> = {}): CsvSourceConfig {
	return {
		path: "data/items.csv",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		...overrides,
	};
}

function makeManager() {
	return new ViewsManager({} as App, [], "", () => {});
}

describe("G4 — Remove data source keeps rows as static, drops source+cache, stops refreshing", () => {
	it("setApiSource(undefined) clears apiSource/apiCache/apiAwaitingConfirmation but keeps itemState/order", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "One", explicitStatusId: "done" } };
		node.apiItemOrder = ["1"];
		node.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false };
		node.apiAwaitingConfirmation = true;

		vm.setApiSource(view.id, folder.id, undefined);

		const after = vm.getNode(view.id, folder.id)!;
		expect(after.apiSource).toBeUndefined();
		expect(after.apiCache).toBeUndefined();
		expect(after.apiAwaitingConfirmation).toBeUndefined();
		expect(after.apiItemState).toEqual({ "1": { id: "1", label: "One", explicitStatusId: "done" } });
		expect(after.apiItemOrder).toEqual(["1"]);
	});

	it("a removed source's leftover static rows keep whatever status/note they already had", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const before = vm.getNode(view.id, folder.id)!;
		before.apiItemState = { "1": { id: "1", label: "One", noteRef: { kind: "file", path: "Notes/x.md" } } };
		before.apiItemOrder = ["1"];

		vm.setApiSource(view.id, folder.id, undefined);

		expect(vm.getNode(view.id, folder.id)!.apiItemState?.["1"].noteRef).toEqual({ kind: "file", path: "Notes/x.md" });
	});

	it("setApiSource can only target a meta node, not a unit node", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		vm.placeUnit(view.id, { kind: "file", path: "A.md" }, null);
		const unitNode = view.root[0];
		vm.setApiSource(view.id, unitNode.id, makeSource());
		expect(vm.getNode(view.id, unitNode.id)!.apiSource).toBeUndefined();
	});
});

describe("R1 — setApiSource/setCsvSource are mutually exclusive on the same node", () => {
	it("setCsvSource clears a live apiSource (and its cache/confirmation flag)", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const node = vm.getNode(view.id, folder.id)!;
		node.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false };
		node.apiAwaitingConfirmation = true;

		vm.setCsvSource(view.id, folder.id, makeCsvSource());

		const after = vm.getNode(view.id, folder.id)!;
		expect(after.csvSource).toEqual(makeCsvSource());
		expect(after.apiSource).toBeUndefined();
		expect(after.apiCache).toBeUndefined();
		expect(after.apiAwaitingConfirmation).toBeUndefined();
	});

	it("setApiSource clears a live csvSource (and its cache/confirmation flag)", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder")!;
		vm.setCsvSource(view.id, folder.id, makeCsvSource());
		const node = vm.getNode(view.id, folder.id)!;
		node.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false };
		node.apiAwaitingConfirmation = true;

		vm.setApiSource(view.id, folder.id, makeSource());

		const after = vm.getNode(view.id, folder.id)!;
		expect(after.apiSource).toEqual(makeSource());
		expect(after.csvSource).toBeUndefined();
		expect(after.apiCache).toBeUndefined();
		expect(after.apiAwaitingConfirmation).toBeUndefined();
	});

	it("leftover static rows (apiItemState/apiItemOrder) survive switching api->csv, same as a plain removal", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "One", explicitStatusId: "done" } };
		node.apiItemOrder = ["1"];

		vm.setCsvSource(view.id, folder.id, makeCsvSource());

		const after = vm.getNode(view.id, folder.id)!;
		expect(after.apiItemState).toEqual({ "1": { id: "1", label: "One", explicitStatusId: "done" } });
		expect(after.apiItemOrder).toEqual(["1"]);
	});

	it("removing a CSV source untouched by any prior API source does not disturb apiSource (stays undefined, no-op clear)", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder")!;
		vm.setCsvSource(view.id, folder.id, makeCsvSource());

		vm.setCsvSource(view.id, folder.id, undefined);

		const after = vm.getNode(view.id, folder.id)!;
		expect(after.csvSource).toBeUndefined();
		expect(after.apiSource).toBeUndefined();
	});
});

describe("G7 — Duplicate Folder deep-copies source, never cache, with no shared references", () => {
	it("a duplicate of an API-sourced Folder gets its own deep-copied source, a fresh grey dot, and no rows yet", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const original = vm.getNode(view.id, folder.id)!;
		original.apiItemState = { "1": { id: "1", label: "One" } };
		original.apiItemOrder = ["1"];
		original.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [{ id: "1", label: "One" }], skippedCount: 0, truncated: false };

		vm.duplicateNode(view.id, folder.id);
		const view2 = vm.getViews()[0];
		const clone = view2.root.find((n) => n.id !== folder.id)!;

		expect(clone.apiSource).toEqual(original.apiSource);
		expect(clone.apiCache).toBeUndefined();
		expect(clone.apiItemState).toEqual({});
		expect(clone.apiItemOrder).toEqual([]);
	});

	it("the duplicate's source is a genuinely independent copy — editing one never edits the other", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		vm.duplicateNode(view.id, folder.id);
		const clone = view.root.find((n) => n.id !== folder.id)!;

		clone.apiSource!.mapping.labelField = "changed";
		clone.apiSource!.url = "https://changed.example.com";

		const original = vm.getNode(view.id, folder.id)!;
		expect(original.apiSource!.mapping.labelField).toBe("name");
		expect(original.apiSource!.url).toBe("https://api.example.com/items");
	});

	it("a duplicate's cache mutation never reaches back into the original (no shared cache object either)", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const original = vm.getNode(view.id, folder.id)!;
		original.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false };

		vm.duplicateNode(view.id, folder.id);
		const clone = view.root.find((n) => n.id !== folder.id)!;
		clone.apiCache = { fetchedAt: 2, ok: false, error: "boom", rows: [], skippedCount: 0, truncated: false };

		expect(vm.getNode(view.id, folder.id)!.apiCache?.fetchedAt).toBe(1);
	});

	it("G4 extension: a Folder with leftover static rows but no source still gets its own independent copy of them", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Static folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const before = vm.getNode(view.id, folder.id)!;
		before.apiItemState = { "1": { id: "1", label: "One", noteRef: { kind: "file", path: "x.md" } } };
		before.apiItemOrder = ["1"];
		vm.setApiSource(view.id, folder.id, undefined); // now a plain Folder with leftover static rows

		vm.duplicateNode(view.id, folder.id);
		const clone = view.root.find((n) => n.id !== folder.id)!;

		expect(clone.apiSource).toBeUndefined();
		expect(clone.apiItemState).toEqual({ "1": { id: "1", label: "One", noteRef: { kind: "file", path: "x.md" } } });
		expect(clone.apiItemOrder).toEqual(["1"]);

		// Independent copy: mutating the clone's row (or its nested noteRef) must not touch the original.
		clone.apiItemState!["1"].label = "Changed";
		clone.apiItemState!["1"].noteRef!.path = "changed.md";
		const original = vm.getNode(view.id, folder.id)!;
		expect(original.apiItemState!["1"].label).toBe("One");
		expect(original.apiItemState!["1"].noteRef!.path).toBe("x.md");
	});

	it("duplicating a plain Folder with no API involvement at all is unaffected (no apiSource/apiItemState anywhere)", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Plain folder")!;
		vm.duplicateNode(view.id, folder.id);
		const clone = view.root.find((n) => n.id !== folder.id)!;
		expect(clone.apiSource).toBeUndefined();
		expect(clone.apiItemState).toBeUndefined();
		expect(clone.apiItemOrder).toBeUndefined();
	});
});

describe("E6 — deleting a Folder removes its itemState along with source/cache", () => {
	it("deleteMetaFolder removes the node (and therefore every API field on it) entirely", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "One" } };
		node.apiItemOrder = ["1"];

		vm.deleteMetaFolder(view.id, folder.id);

		expect(vm.getNode(view.id, folder.id)).toBeNull();
	});

	it("deleting a Folder promotes its children up one level rather than discarding them (existing invariant, unaffected by API fields)", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const child = vm.addMetaFolder(view.id, folder.id, "Child")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		vm.deleteMetaFolder(view.id, folder.id);

		expect(vm.getNode(view.id, child.id)).not.toBeNull();
	});
});

describe("T2 — a Folder's row-rendering gate must not go false the instant its source is removed", () => {
	it("a live source with no rows yet still counts as having rows to show", () => {
		expect(nodeHasApiRows({ apiSource: undefined, apiItemOrder: undefined })).toBe(false);
	});

	it("a removed source's leftover static rows still count, exactly the G4 regression explorer-view.ts hit", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		const before = vm.getNode(view.id, folder.id)!;
		before.apiItemState = { "1": { id: "1", label: "One" } };
		before.apiItemOrder = ["1"];
		expect(nodeHasApiRows(before)).toBe(true);

		vm.setApiSource(view.id, folder.id, undefined);
		const after = vm.getNode(view.id, folder.id)!;

		// This is the exact condition explorer-view.ts gates rendering on (T2): before the fix it used
		// `node.apiSource` alone, which goes false here even though the static rows survive.
		expect(after.apiSource).toBeUndefined();
		expect(after.apiItemOrder).toEqual(["1"]);
		expect(nodeHasApiRows(after)).toBe(true);
	});

	it("a Folder with neither a source nor any rows has nothing to show", () => {
		const vm = makeManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Plain folder")!;
		expect(nodeHasApiRows(vm.getNode(view.id, folder.id)!)).toBe(false);
	});
});

describe("E7 — Folder converted by promotion: source, cache and mode carry over", () => {
	// Deliberately skipped, not omitted: the meta-Folder-to-real-folder promotion mechanism (ticket
	// 34n6ct71muguncxk) has no implementation anywhere in this repo to exercise — grepped `src/` again
	// for this PR and found only `promoteAndPlace`/`promoteAndPlaceFlow` (explorer-view.ts), which
	// places an already-classified disk unit into a view and never converts a `meta` node into one.
	// Same call PR-2's tester made (PR-2 T5, commit b773e87) and PR-3's own tester (T6/T9) re-confirmed;
	// recorded as a permanent, documented deviation in docs/decisions.md rather than re-raised each
	// round. `ViewNode.apiSource`'s doc comment in src/types.ts is the forward-looking contract: once
	// 34n6ct71muguncxk lands its conversion code, it must copy `apiSource` (incl. this PR's
	// overwrite/guard/refresh-every fields), `apiCache`, `apiItemState` and `apiItemOrder` onto the
	// resulting node unchanged, and leave already-pulled children untouched — at which point this test
	// should be un-skipped and driven against that real conversion function.
	it.skip("a Folder's source, cache and mode carry over when converted by promotion (ticket 34n6ct71muguncxk — not yet implemented anywhere in this repo)", () => {
		expect.unreachable("no promotion-conversion code path exists to exercise yet");
	});
});
