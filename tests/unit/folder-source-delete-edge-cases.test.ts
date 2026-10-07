import type { App } from "obsidian";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { describe, expect, it } from "vitest";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig } from "../../src/types";

function source(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		type: "folder",
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		mode: "merge",
		...overrides,
	};
}

function makeVm(mode: FolderSourceConfig["mode"]) {
	const app = new MockApp();
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/a.md");
	app.vault.seedFile("Projects/b.md");
	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const view = vm.getViews()[0];
	const folder = vm.addMetaFolder(view.id, null, "Projects")!;
	vm.setFolderSource(view.id, folder.id, source({ mode }));
	vm.refreshFolderSource(view.id, folder.id);
	return { vm, view, folder, app };
}

describe("E9: a same-named file recreated after a merge-mode deletion is treated as fresh", () => {
	it("the recreated file produces a brand-new real row, independent of the old last-seen placeholder — no re-link attempt", () => {
		const { vm, view, folder, app } = makeVm("merge");

		vm.onVaultDelete("Projects/a.md");
		const staleEntry = Object.values(vm.getNode(view.id, folder.id)!.apiItemState ?? {})[0];
		expect(staleEntry.notFound).toBe(true);

		// Recreate a file at the same path, then refresh — as if the user undid the deletion or made
		// a new file with the same name.
		app.vault.seedFile("Projects/a.md");
		vm.refreshFolderSource(view.id, folder.id);

		const after = vm.getNode(view.id, folder.id)!;
		const freshRow = after.children.find((n) => n.ref?.path === "Projects/a.md");
		expect(freshRow).toBeTruthy();
		expect(freshRow!.id).not.toBe(staleEntry.id); // a brand-new node, not the demoted one resurrected.

		// The stale last-seen placeholder is untouched — still present, still not-found, no attempt to
		// fold the fresh row back into it.
		expect(after.apiItemState![staleEntry.id]).toEqual(staleEntry);
	});
});

describe("mode is read at reconciliation time, not delete time", () => {
	it("merge-mode deletion, then switch to overwrite before the next refresh: the stale last-seen row is swept away with no warning", () => {
		const { vm, view, folder } = makeVm("merge");

		vm.onVaultDelete("Projects/a.md");
		expect(Object.keys(vm.getNode(view.id, folder.id)!.apiItemState ?? {})).toHaveLength(1);

		vm.setFolderSource(view.id, folder.id, { ...vm.getNode(view.id, folder.id)!.folderSource!, mode: "overwrite" });
		vm.refreshFolderSource(view.id, folder.id);

		expect(vm.getNode(view.id, folder.id)!.apiItemState ?? {}).toEqual({});
	});

	it("append-mode deletion, then switch to merge before the next refresh: the link-cleared row converts to a last-seen placeholder with Remove available", () => {
		const { vm, view, folder } = makeVm("append");

		vm.onVaultDelete("Projects/a.md");
		const appendEntry = Object.values(vm.getNode(view.id, folder.id)!.apiItemState ?? {})[0];
		expect(appendEntry.notFound).toBeFalsy();

		vm.setFolderSource(view.id, folder.id, { ...vm.getNode(view.id, folder.id)!.folderSource!, mode: "merge" });
		vm.refreshFolderSource(view.id, folder.id);

		const converted = vm.getNode(view.id, folder.id)!.apiItemState![appendEntry.id];
		expect(converted.notFound).toBe(true); // "Remove available" is gated on notFound in the explorer menu.
		expect(converted.id).toBe(appendEntry.id);
		expect(converted.label).toBe(appendEntry.label);
	});
});

describe("batch deletion of multiple children from the same Folder source", () => {
	it("each row reconciles independently per the source's single configured mode, no cross-row interference", () => {
		const { vm, view, folder } = makeVm("merge");

		vm.onVaultDelete("Projects/a.md");
		vm.onVaultDelete("Projects/b.md");

		const owner = vm.getNode(view.id, folder.id)!;
		expect(owner.children.some((n) => n.ref?.path === "Projects/a.md" || n.ref?.path === "Projects/b.md")).toBe(false);
		const entries = Object.values(owner.apiItemState ?? {});
		expect(entries).toHaveLength(2);
		expect(entries.every((e) => e.notFound === true)).toBe(true);
		expect(new Set(entries.map((e) => e.id)).size).toBe(2); // distinct ids, no collision/merge of the two.
	});
});

describe("deleting a child of a Folder source that has zero other rows", () => {
	it("merge mode: reconciliation completes cleanly, leaving exactly one last-seen row", () => {
		const app = new MockApp();
		app.vault.seedFolder("Solo");
		app.vault.seedFile("Solo/only.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Solo")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Solo", mode: "merge" }));
		vm.refreshFolderSource(view.id, folder.id);

		vm.onVaultDelete("Solo/only.md");

		const owner = vm.getNode(view.id, folder.id)!;
		expect(owner.children).toHaveLength(0);
		expect(Object.keys(owner.apiItemState ?? {})).toHaveLength(1);
	});

	it("overwrite mode: leaves an empty source with no error", () => {
		const app = new MockApp();
		app.vault.seedFolder("Solo");
		app.vault.seedFile("Solo/only.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Solo")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Solo", mode: "overwrite" }));
		vm.refreshFolderSource(view.id, folder.id);

		expect(() => vm.onVaultDelete("Solo/only.md")).not.toThrow();

		const owner = vm.getNode(view.id, folder.id)!;
		expect(owner.children).toHaveLength(0);
		expect(owner.apiItemState ?? {}).toEqual({});
	});
});
