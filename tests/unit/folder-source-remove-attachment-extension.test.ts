import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

/** Fence: "PR-2's Remove-attachment / stale-reference-clearing mechanism is genuinely reused for
 * append-mode Folder-source deletions, not reimplemented separately for Folder sources." The actual
 * clearing happens via G27's existing `clearNoteRefsForPath` sweep inside `onVaultDelete` itself —
 * these tests prove that reuse directly, plus exercise `clearApiItemNoteRef` (G28, PR-2's manual
 * backstop) against the same row shape. */
function setup(mode: "append" | "merge" | "overwrite") {
	const persist = vi.fn();
	const folderSource: FolderSourceConfig = {
		type: "folder",
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		mode,
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
	const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", persist);
	return { vm, persist };
}

describe("append-mode deletion genuinely reuses G27's existing noteRef-clearing sweep", () => {
	it("a sibling placeholder's unrelated noteRef pointed at the SAME deleted path is cleared in the SAME onVaultDelete call", () => {
		// An unrelated, pre-existing API placeholder (nothing to do with this Folder source) that
		// happens to point its own noteRef at the exact path about to be deleted — a single shared
		// sweep clears both this one and the Folder-source row created in the same call, since
		// there is only one mechanism in play, not two.
		const { vm } = setup("append");
		const owner = vm.getNode("v1", "owner")!;
		owner.apiItemState = { preexisting: { id: "preexisting", label: "Pre-existing", kind: PLACEHOLDER_ROW_KIND, noteRef: { kind: "file", path: "Projects/a.md" } } };
		owner.apiItemOrder = ["preexisting"];

		vm.onVaultDelete("Projects/a.md");

		const afterOwner = vm.getNode("v1", "owner")!;
		expect(afterOwner.apiItemState!["preexisting"].noteRef).toBeUndefined();
		const demoted = Object.values(afterOwner.apiItemState!).find((i) => i.id !== "preexisting")!;
		expect(demoted.noteRef).toBeUndefined();
	});

	it("G28 manual backstop (clearApiItemNoteRef) still works standalone on a Folder-source-produced row, independent of whether G27 already ran", () => {
		const { vm } = setup("append");
		const owner = vm.getNode("v1", "owner")!;
		// Simulate a row that was demoted but, for some other reason, still carries a noteRef —
		// clearApiItemNoteRef (PR-2's own manual backstop) must still apply to it unmodified.
		owner.apiItemState = { "file:Projects/a.md": { id: "file:Projects/a.md", label: "a.md", kind: PLACEHOLDER_ROW_KIND, noteRef: { kind: "file", path: "Elsewhere.md" } } };
		owner.apiItemOrder = ["file:Projects/a.md"];

		vm.clearApiItemNoteRef("v1", "owner", "file:Projects/a.md");

		expect(vm.getNode("v1", "owner")!.apiItemState!["file:Projects/a.md"].noteRef).toBeUndefined();
	});

	it("merge mode never attaches a noteRef in the first place — nothing for the clearing mechanism to do", () => {
		const { vm } = setup("merge");

		vm.onVaultDelete("Projects/a.md");

		const entry = Object.values(vm.getNode("v1", "owner")!.apiItemState!)[0];
		expect(entry.noteRef).toBeUndefined();
		expect(entry.notFound).toBe(true);
	});

	it("overwrite mode never creates a row, so no noteRef ever exists to clear", () => {
		const { vm } = setup("overwrite");

		vm.onVaultDelete("Projects/a.md");

		expect(vm.getNode("v1", "owner")!.apiItemState ?? {}).toEqual({});
	});
});
