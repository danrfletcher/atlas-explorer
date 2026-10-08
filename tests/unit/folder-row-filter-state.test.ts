import { describe, expect, it, vi } from "vitest";
import { folderRowFilterState } from "../../src/folder-filter";
import { ViewNode } from "../../src/types";
import { StatusesManager } from "../../src/statuses";
import { makeFakeExplorer, makeStatusesManager } from "./explorer-view-sort-truncate-helpers";

/** PR-1.F2: the render-time filter state of a managed folder row. Pure, so the whole table is listed. */
describe("folderRowFilterState", () => {
	const modes = ["append", "merge", "overwrite"] as const;

	for (const mode of modes) {
		it(`${mode}: a matching row is shown whatever its flag`, () => {
			expect(folderRowFilterState({}, mode, true)).toBe("shown");
			expect(folderRowFilterState({ folderSourceHiddenAtSave: true }, mode, true)).toBe("shown");
		});
	}

	it("append: a non-matching row is always shown", () => {
		expect(folderRowFilterState({}, "append", false)).toBe("shown");
		expect(folderRowFilterState({ folderSourceHiddenAtSave: true }, "append", false)).toBe("shown");
	});

	it("merge: a non-matching row that was live is filtered out, not hidden", () => {
		expect(folderRowFilterState({}, "merge", false)).toBe("filteredOut");
	});

	it("overwrite: a non-matching row that was live is hidden", () => {
		expect(folderRowFilterState({}, "overwrite", false)).toBe("hidden");
	});

	it("merge and overwrite: a non-matching row flagged hidden-at-save is hidden", () => {
		expect(folderRowFilterState({ folderSourceHiddenAtSave: true }, "merge", false)).toBe("hidden");
		expect(folderRowFilterState({ folderSourceHiddenAtSave: true }, "overwrite", false)).toBe("hidden");
	});
});

/** PR-1.F2 unit: the explorer's hide/lift pass. Hidden rows are skipped before truncate/sort, their
 * children are lifted one level under them, and a hidden row's selection is pruned. */
describe("visibleFolderSourceRows", () => {
	function unit(id: string, children: ViewNode[] = []): ViewNode {
		return { id, type: "unit", label: id, children, ref: { kind: "file", path: `${id}.md` } } as unknown as ViewNode;
	}

	function explorerWith(hidden: Set<string>) {
		const sm: StatusesManager = makeStatusesManager();
		const fake = makeFakeExplorer(sm, {
			plugin: {
				statusesManager: sm,
				settings: undefined as never,
				viewsManager: {
					setApiItemStatus: vi.fn(),
					managedRowFilterState: vi.fn((_viewId: string, node: ViewNode) => (hidden.has(node.id) ? "hidden" : "shown")),
				},
			} as never,
		});
		(fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([...hidden]);
		return fake as unknown as {
			visibleFolderSourceRows: (nodes: ViewNode[], view: { id: string }, ancestors: unknown[]) => { node: ViewNode; ancestors: unknown[] }[];
			selectedBucketNodeIds: Set<string>;
		};
	}

	it("drops a hidden row and keeps the shown ones in order", () => {
		const fake = explorerWith(new Set(["b"]));
		const rows = fake.visibleFolderSourceRows([unit("a"), unit("b"), unit("c")], { id: "v" }, []);
		expect(rows.map((r) => r.node.id)).toEqual(["a", "c"]);
	});

	it("lifts a hidden row's shown children, with the hidden row added to their ancestors", () => {
		const fake = explorerWith(new Set(["parent"]));
		const child = unit("child");
		const rows = fake.visibleFolderSourceRows([unit("parent", [child])], { id: "v" }, []);
		expect(rows).toHaveLength(1);
		expect(rows[0].node).toBe(child);
		expect(rows[0].ancestors).toHaveLength(1);
	});

	it("drops a lifted child that is itself hidden, with nothing under it", () => {
		const fake = explorerWith(new Set(["parent", "child"]));
		const rows = fake.visibleFolderSourceRows([unit("parent", [unit("child", [unit("grand")])])], { id: "v" }, []);
		expect(rows).toEqual([]);
	});

	it("prunes the selection of a row that is hidden", () => {
		const fake = explorerWith(new Set(["b"]));
		fake.selectedBucketNodeIds = new Set(["a", "b"]);
		fake.visibleFolderSourceRows([unit("a"), unit("b")], { id: "v" }, []);
		expect([...fake.selectedBucketNodeIds]).toEqual(["a"]);
	});
});
