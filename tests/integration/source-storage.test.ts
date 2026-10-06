import { describe, expect, it } from "vitest";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, View, ViewNode } from "../../src/types";
import type { App } from "obsidian";

/** G3: `mappingMode`/`jsSource` persistence through `ViewsManager`'s load-save round-trip — the JS
 * source lives in synced `data.json` `source` (not device-local, unlike headers, per the spec's own
 * "not a secret" call). Mirrors `api-source-storage.test.ts`'s own conventions/helpers. */

function jsSource(overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
		refreshEveryMinutesEnabled: false,
		refreshEveryMinutes: undefined,
		keepOnEmpty: undefined,
		confirmBeforeDelete: undefined,
		mappingMode: "js",
		jsSource: "(response) => response.map((item) => ({ id: item.id, label: item.name }))",
		...overrides,
	};
}

function makeViewsManager(views: View[] = [], persist: () => void = () => {}) {
	return new ViewsManager({} as App, views, "", persist);
}

describe("Persisted view data — G3: mappingMode/jsSource are plain fields on the node's source", () => {
	it("a js-mode source round-trips through setApiSource/getNode, present in what would be saved to data.json", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, jsSource());

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.apiSource?.mappingMode).toBe("js");
		expect(node.apiSource?.jsSource).toBe(jsSource().jsSource);

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("\"mappingMode\":\"js\"");
		expect(persistedJson).toContain("response.map");
	});

	it("a drag-mode source has no mappingMode/jsSource at all", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, jsSource({ mappingMode: undefined, jsSource: undefined }));

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.apiSource?.mappingMode).toBeUndefined();
		expect(node.apiSource?.jsSource).toBeUndefined();
	});
});

describe("Loading a persisted js-mode source (sanitizeApiFields) — G3: valid on jsSource, not drag mapping", () => {
	function nodeWithApiSource(overrides: Partial<ViewNode> = {}): ViewNode {
		return { id: "n1", type: "meta", label: "API folder", children: [], apiSource: jsSource(), ...overrides };
	}

	function loadedNode(node: ViewNode): ViewNode {
		const views: View[] = [{ id: "v1", name: "V", root: [node], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		return vm.getNode("v1", "n1")!;
	}

	it("a well-formed js-mode source round-trips unchanged", () => {
		const sanitized = loadedNode(nodeWithApiSource());
		expect(sanitized.apiSource?.mappingMode).toBe("js");
		expect(sanitized.apiSource?.jsSource).toBe(jsSource().jsSource);
	});

	it("a js-mode source is kept even though its drag `mapping` was never touched (defaulted to empty fields)", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com", mappingMode: "js", jsSource: "(response) => []" } as unknown as ApiSourceConfig,
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeDefined();
		expect(sanitized.apiSource?.mappingMode).toBe("js");
		expect(sanitized.apiSource?.mapping).toEqual({ idField: "", labelField: "", secondaryField: undefined, arrayField: undefined });
	});

	it("a js-mode source with a non-string jsSource is dropped entirely (not usable)", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com", mapping: { idField: "id", labelField: "name" }, mappingMode: "js", jsSource: 12345 } as unknown as ApiSourceConfig,
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeUndefined();
	});

	it("switching mappingMode back to drag on load keeps whatever drag mapping was last set, jsSource retained as-is", () => {
		const node = nodeWithApiSource({
			apiSource: { ...jsSource(), mappingMode: undefined, mapping: { idField: "id", labelField: "name" } },
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource?.mappingMode).toBeUndefined();
		expect(sanitized.apiSource?.mapping).toEqual({ idField: "id", labelField: "name", secondaryField: undefined, arrayField: undefined });
		// jsSource is retained (not cleared) so switching back to js in the modal restores it.
		expect(sanitized.apiSource?.jsSource).toBe(jsSource().jsSource);
	});

	it("a drag-mode source (no mappingMode) with no mapping object at all is still dropped, same as before PR-4", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com" } as unknown as ApiSourceConfig,
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeUndefined();
	});
});

describe("Cache shape is unchanged by JS mode — G3: fetchedAt/ok/error/rows/skippedCount/truncated/lastSuccessAt", () => {
	it("a js-mode node's apiCache has the exact same shape as a drag-mode node's", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, jsSource());

		const node = vm.getNode(view.id, folder.id)!;
		node.apiCache = {
			fetchedAt: 123,
			ok: true,
			error: null,
			rows: [{ id: "1", label: "One", extra: { count: 1 } }],
			skippedCount: 0,
			truncated: false,
			lastSuccessAt: 123,
		};

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("\"fetchedAt\":123");
		expect(persistedJson).toContain("\"extra\":{\"count\":1}");
	});
});

// PR-1 (GP5a, F2a/b, E-f): a node that holds a source keeps its rows, statuses, notes, order and
// refresh when Create turns it into a unit, with the same node id; and a sourced unit duplicates with
// its source. Data layer only: the device-local stores are keyed by this same id, so nothing moves.
describe("PR-1 GP5a/F2 — a sourced node keeps its rows through Create (meta -> unit, same id)", () => {
	function seededSource(): ApiSourceConfig {
		return { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false };
	}

	it("40 rows keep their statuses, notes and order, and the node id, after Create turns it into a file unit", () => {
		const vm = new ViewsManager({} as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Linear issues")!;
		vm.setApiSource(view.id, folder.id, seededSource());
		const node = vm.getNode(view.id, folder.id)!;
		const ids = Array.from({ length: 40 }, (_, i) => `row-${i}`);
		node.apiItemState = Object.fromEntries(
			ids.map((id, i) => [id, { id, label: `Issue ${i}`, explicitStatusId: i % 2 ? "doing" : "todo", noteRef: { kind: "file" as const, path: `Notes/${id}.md` } }])
		);
		node.apiItemOrder = [...ids];

		expect(vm.replaceMetaNodeWithUnit(view.id, folder.id, { kind: "file", path: "Linear issues.md" })).toBe(true);

		const after = vm.getNode(view.id, folder.id)!;
		expect(after.id).toBe(folder.id);
		expect(after.type).toBe("unit");
		expect(after.label).toBeUndefined();
		expect(after.apiSource).toEqual(seededSource());
		expect(after.apiItemOrder).toEqual(ids);
		expect(Object.keys(after.apiItemState!)).toHaveLength(40);
		expect(after.apiItemState!["row-3"]).toMatchObject({ explicitStatusId: "doing", noteRef: { kind: "file", path: "Notes/row-3.md" } });
	});

	it("a refresh of the converted unit still reaches it: its managed folder-source children are rebuilt from the vault", () => {
		const app = new MockApp();
		app.vault.seedFolder("Projects");
		app.vault.seedFile("Projects/a.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, { location: "inside", path: "Projects", showFiles: true, showFolders: true, refreshOnViewLoad: false });
		expect(vm.replaceMetaNodeWithUnit(view.id, folder.id, { kind: "file", path: "Folder source.md" })).toBe(true);
		vm.refreshFolderSource(view.id, folder.id);
		expect(vm.getNode(view.id, folder.id)!.children.some((c) => c.folderSourceManaged && c.ref.kind === "file" && c.ref.path === "Projects/a.md")).toBe(true);
	});

	it("duplicating a sourced unit copies its source to the clone, with a new id", () => {
		const vm = new ViewsManager({} as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Linear issues")!;
		vm.setApiSource(view.id, folder.id, seededSource());
		vm.replaceMetaNodeWithUnit(view.id, folder.id, { kind: "file", path: "Linear issues.md" });
		const clone = vm.duplicateNode(view.id, folder.id)!;
		expect(clone.id).not.toBe(folder.id);
		expect(clone.apiSource).toEqual(seededSource());
	});
});
