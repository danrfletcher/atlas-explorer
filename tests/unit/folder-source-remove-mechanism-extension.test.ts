import type { App } from "obsidian";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

/** Fence: "PR-2's Remove mechanism, originally built for the general placeholder-row type tag
 * (API/Table stale items), is genuinely extended rather than duplicated — the same code path now
 * accepts a former-real-unit row produced by a Folder-source merge-mode deletion." `removeApiItem`
 * (G26/G29) is PR-2's own mechanism, gated only on the shared `PLACEHOLDER_ROW_KIND` tag plus
 * `notFound` in `explorer-view.ts`'s menu — never reimplemented here. */
function setupMergeModeDeletedChild() {
	const persist = vi.fn();
	const app = new MockApp();
	app.vault.seedFolder("Projects"); // the file has already been deleted from disk — only the folder remains.
	const folderSource: FolderSourceConfig = {
		type: "folder",
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		mode: "merge",
	};
	const child: ViewNode = {
		id: "child-1",
		type: "unit",
		ref: { kind: "file", path: "Projects/a.md" },
		children: [],
		folderSourceManaged: true,
		folderSourceOwnerId: "owner",
	};
	const owner: ViewNode = { id: "owner", type: "meta", label: "Projects", children: [child], folderSource };
	const vm = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", persist);
	vm.onVaultDelete("Projects/a.md");
	const itemId = Object.keys(vm.getNode("v1", "owner")!.apiItemState!)[0];
	persist.mockClear();
	return { vm, persist, itemId };
}

describe("ViewsManager.removeApiItem extended to a Folder-source merge-mode-deleted row", () => {
	it("accepts the former-real-unit row's own id, same as any API/Table placeholder", () => {
		const { vm, itemId } = setupMergeModeDeletedChild();
		const before = vm.getNode("v1", "owner")!.apiItemState![itemId];
		expect(before.kind).toBe(PLACEHOLDER_ROW_KIND);
		expect(before.notFound).toBe(true);

		vm.removeApiItem("v1", "owner", itemId);

		expect(vm.getNode("v1", "owner")!.apiItemState).not.toHaveProperty(itemId);
	});

	it("removal is unconditional (G26: never re-gates on notFound itself) and leaves no residue in apiItemOrder", () => {
		const { vm, itemId } = setupMergeModeDeletedChild();

		vm.removeApiItem("v1", "owner", itemId);

		const owner = vm.getNode("v1", "owner")!;
		expect(owner.apiItemOrder).not.toContain(itemId);
		expect(Object.keys(owner.apiItemState!)).toHaveLength(0);
	});

	it("persists the removal (F4: no undo)", () => {
		const { vm, persist, itemId } = setupMergeModeDeletedChild();

		vm.removeApiItem("v1", "owner", itemId);

		expect(persist).toHaveBeenCalled();
	});

	it("no residue on next refresh: the file stays deleted, so reconciling the source again never re-renders the removed row", () => {
		const { vm, itemId } = setupMergeModeDeletedChild();
		vm.removeApiItem("v1", "owner", itemId);

		vm.refreshFolderSource("v1", "owner");

		const owner = vm.getNode("v1", "owner")!;
		expect(owner.apiItemState).toEqual({});
		expect(owner.children.some((n) => n.ref?.path === "Projects/a.md")).toBe(false);
	});
});
