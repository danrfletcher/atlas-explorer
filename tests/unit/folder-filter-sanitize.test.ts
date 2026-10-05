import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ViewsManager } from "../../src/views";
import { createEmptyView, FolderSourceConfig, ViewNode, View } from "../../src/types";

/** `sanitizeFolderSource` is private: it runs on every `data.json` load through the `ViewsManager`
 * constructor, which is the path these cases must hold on. */
function loadFolderSource(folderSource: unknown): FolderSourceConfig | undefined {
	const view = createEmptyView("v1", "View");
	const node = { id: "n1", type: "meta", label: "Job search", children: [], folderSource } as unknown as ViewNode;
	view.root.push(node);
	const vm = new ViewsManager({} as App, [view], "v1", () => {});
	return vm.getViews()[0].root[0].folderSource;
}

function folderSourceWith(filters: unknown): FolderSourceConfig {
	return { type: "folder", location: "inside", path: "Jobs", showFiles: true, showFolders: false, refreshOnViewLoad: false, mode: "merge", filters } as FolderSourceConfig;
}

describe("sanitizeFolderSource — filters", () => {
	it("keeps valid rules", () => {
		const source = loadFolderSource(folderSourceWith({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } }));
		expect(source?.filters).toEqual({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } });
	});

	it("trims the key, and trims the value so a whitespace value becomes empty", () => {
		const source = loadFolderSource(
			folderSourceWith({ files: { yaml: { rules: [{ key: "  status ", value: " active " }, { key: "tags", value: "   " }] } } })
		);
		expect(source?.filters?.files?.yaml?.rules).toEqual([
			{ key: "status", value: "active" },
			{ key: "tags", value: "" },
		]);
	});

	it("drops malformed rules and keeps the valid ones", () => {
		const source = loadFolderSource(
			folderSourceWith({
				files: {
					yaml: {
						rules: [
							{ key: 1, value: "x" },
							{ key: "a", value: 2 },
							null,
							"status=active",
							["status", "active"],
							{ key: "  ", value: "x" },
							{ key: "status", value: "active" },
						],
					},
				},
			})
		);
		expect(source?.filters).toEqual({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } });
	});

	it("omits filters entirely when every rule is malformed", () => {
		const source = loadFolderSource(folderSourceWith({ files: { yaml: { rules: [{ key: "", value: "x" }, { key: 3 }] } } }));
		expect(source).toBeDefined();
		expect("filters" in source!).toBe(false);
	});

	it("omits filters when the field is absent", () => {
		const source = loadFolderSource(folderSourceWith(undefined));
		expect("filters" in source!).toBe(false);
	});

	it.each([
		["non-array rules", { files: { yaml: { rules: "status=active" } } }],
		["null rules", { files: { yaml: { rules: null } } }],
		["null filters", null],
		["string filters", "status=active"],
		["filters with no files", { folders: { rules: [] } }],
		["files with no yaml", { files: {} }],
	])("%s returns an unfiltered source without throwing", (_name, filters) => {
		let source: FolderSourceConfig | undefined;
		expect(() => (source = loadFolderSource(folderSourceWith(filters)))).not.toThrow();
		expect(source?.path).toBe("Jobs");
		expect("filters" in source!).toBe(false);
	});

	it("drops a reserved folders slot instead of storing it", () => {
		const source = loadFolderSource(
			folderSourceWith({ folders: { rules: [{ key: "a", value: "b" }] }, files: { yaml: { rules: [{ key: "status", value: "active" }] } } })
		);
		expect(Object.keys(source!.filters!)).toEqual(["files"]);
	});

	it("keeps an empty-value rule (key present)", () => {
		const source = loadFolderSource(folderSourceWith({ files: { yaml: { rules: [{ key: "status", value: "" }] } } }));
		expect(source?.filters?.files?.yaml?.rules).toEqual([{ key: "status", value: "" }]);
	});
});

describe("duplicateNode — filters", () => {
	function setup(): { vm: ViewsManager; viewId: string; nodeId: string } {
		const view: View = createEmptyView("v1", "View");
		const node = {
			id: "n1",
			type: "meta",
			label: "Job search",
			children: [],
			folderSource: folderSourceWith({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } }),
		} as unknown as ViewNode;
		view.root.push(node);
		const vm = new ViewsManager({} as App, [view], "v1", () => {});
		return { vm, viewId: "v1", nodeId: "n1" };
	}

	it("deep-copies filters so the copy shares no rule objects with the original", () => {
		const { vm, viewId, nodeId } = setup();
		const clone = vm.duplicateNode(viewId, nodeId)!;
		const original = vm.getViews()[0].root[0];
		expect(clone.folderSource?.filters).toEqual(original.folderSource?.filters);
		expect(clone.folderSource?.filters?.files?.yaml?.rules[0]).not.toBe(original.folderSource?.filters?.files?.yaml?.rules[0]);

		clone.folderSource!.filters!.files!.yaml!.rules[0].value = "done";
		clone.folderSource!.filters!.files!.yaml!.rules.push({ key: "extra", value: "x" });

		expect(original.folderSource?.filters).toEqual({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } });
	});

	it("does not share the removedRefs list with the original", () => {
		const { vm, viewId, nodeId } = setup();
		const original = vm.getViews()[0].root[0];
		original.folderSource!.removedRefs = ["file:Jobs/a.md"];
		const clone = vm.duplicateNode(viewId, nodeId)!;
		clone.folderSource!.removedRefs!.push("file:Jobs/b.md");
		expect(original.folderSource!.removedRefs).toEqual(["file:Jobs/a.md"]);
	});
});

describe("filters persist through data.json load and save", () => {
	it("round-trips the rules through JSON without loss", () => {
		const persist = vi.fn();
		const view = createEmptyView("v1", "View");
		const vm = new ViewsManager({} as App, [view], "v1", persist);
		const folder = vm.addMetaFolder("v1", null, "Job search")!;
		const source = folderSourceWith({ files: { yaml: { rules: [{ key: "status", value: "active" }, { key: "company", value: "[[Gamma Ltd]]" }] } } });
		vm.setFolderSource("v1", folder.id, source);
		expect(persist).toHaveBeenCalled();

		const saved = JSON.parse(JSON.stringify(vm.getViews()));
		const reloaded = new ViewsManager({} as App, saved, "v1", () => {});
		const reloadedSource = reloaded.getViews()[0].root[0].folderSource;
		expect(reloadedSource?.filters).toEqual(source.filters);
	});
});
