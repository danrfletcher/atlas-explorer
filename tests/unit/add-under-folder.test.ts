import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "obsidian";
import { ViewsManager } from "../../src/views";
import { ViewNode } from "../../src/types";
import { AddUnderFolderDeps, startAddUnderFolder } from "../../src/add-under-folder";
import { file, meta, unit } from "../integration/create-from-meta-fixtures";

// PR-2.F2: the handler is driven against a real `ViewsManager` over an in-memory view fixture, with
// the `TextPromptModal` constructor mocked so the test can fire its submit/cancel callbacks directly
// instead of simulating real DOM input — same pattern `swap-flow.test.ts`/`swap-source.test.ts` use.
const captured = vi.hoisted(() => ({
	prompts: [] as { title: string; initial: string; onSubmit: (v: string) => void; onCancel?: () => void }[],
}));

vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingPrompt {
		constructor(
			_app: unknown,
			public title: string,
			public initial: string,
			public onSubmit: (v: string) => void,
			public placeholder?: string,
			public onCancel?: () => void
		) {
			captured.prompts.push(this);
		}
		open(): void {}
	}
	return { ...actual, TextPromptModal: RecordingPrompt };
});

const VIEW_ID = "v1";

/** Folder "Projects" containing file row "quarry-drones" and a Folder "Docs", as the spec asks for. */
function tree(): ViewNode[] {
	return [meta("projects", "Projects", [unit("quarry-drones", file("quarry-drones.md")), meta("docs", "Docs")])];
}

function setup(root: ViewNode[] = tree()) {
	const app = new App();
	const vm = new ViewsManager(app as unknown as App, [{ id: VIEW_ID, name: "Default", inboxMode: "view", root }], VIEW_ID, () => {});
	const selection = new Set<string>();
	const tracked = new Set<{ close(): void }>();
	const addMetaFolder = vi.fn((viewId: string, parentId: string | null, label: string) => vm.addMetaFolder(viewId, parentId, label));
	const deps: AddUnderFolderDeps = {
		app: app as unknown as App,
		getNode: (viewId, nodeId) => vm.getNode(viewId, nodeId),
		addMetaFolder: (viewId, parentId, label) => addMetaFolder(viewId, parentId, label),
		expandParent: (viewId, parentId) => vm.setNodeCollapsed(viewId, parentId, false),
		selectOnly: (nodeId) => {
			selection.clear();
			selection.add(nodeId);
		},
		trackPrompt: (prompt) => {
			tracked.add(prompt);
			return () => void tracked.delete(prompt);
		},
	};
	return { app, vm, deps, selection, addMetaFolder, tracked };
}

beforeEach(() => {
	captured.prompts.length = 0;
	Notice.reset();
});

describe("startAddUnderFolder — G4 submit", () => {
	it("gives one new meta child, appended last, with the parent id passed through", async () => {
		const { vm, deps, addMetaFolder } = setup();
		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		expect(captured.prompts).toHaveLength(1);
		expect(captured.prompts[0].title).toBe("New folder");
		expect(captured.prompts[0].initial).toBe("New folder");

		captured.prompts[0].onSubmit("Archive");
		const created = await promise;

		expect(created?.type).toBe("meta");
		expect(created?.label).toBe("Archive");
		expect(addMetaFolder).toHaveBeenCalledWith(VIEW_ID, "projects", "Archive");

		const projects = vm.getNode(VIEW_ID, "projects")!;
		expect(projects.children.map((c) => c.id)).toEqual(["quarry-drones", "docs", created!.id]);
		expect(projects.children.at(-1)).toBe(created);
	});

	it("adds under a deeply nested parent too, and a duplicate label among siblings is allowed with a fresh id", async () => {
		const nested: ViewNode[] = [meta("l0", "Level 0", [meta("l1", "Level 1", [meta("l2", "Level 2", [meta("existing", "Notes")])])])];
		const { vm, deps } = setup(nested);

		const first = startAddUnderFolder(deps, VIEW_ID, "l2");
		captured.prompts[0].onSubmit("Notes");
		const createdFirst = await first;

		const l2 = vm.getNode(VIEW_ID, "l2")!;
		expect(l2.children.map((c) => c.label)).toEqual(["Notes", "Notes"]);
		expect(l2.children[0].id).not.toBe(l2.children[1].id);
		expect(createdFirst!.id).toBe(l2.children[1].id);
	});
});

describe("startAddUnderFolder — G4 label fallback (differs from the toolbar's empty-label guard)", () => {
	it.each([
		["", "New folder"],
		["   ", "New folder"],
		[" Archive ", "Archive"],
	])("label %j becomes %j", async (typed, expected) => {
		const { deps, addMetaFolder } = setup();
		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onSubmit(typed);
		const created = await promise;
		expect(created?.label).toBe(expected);
		// The add-under path must call addMetaFolder unconditionally — never gate on label.trim()
		// the way the toolbar's own addMetaFolder wrapper does.
		expect(addMetaFolder).toHaveBeenCalledWith(VIEW_ID, "projects", typed);
	});
});

describe("startAddUnderFolder — E1 cancel", () => {
	it("makes no addMetaFolder call and releases the lock", async () => {
		const { deps, addMetaFolder } = setup();
		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onCancel!();
		const result = await promise;

		expect(result).toBeNull();
		expect(addMetaFolder).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(0);

		// Lock released: a second add-under on the same parent can open right away.
		const second = startAddUnderFolder(deps, VIEW_ID, "projects");
		expect(captured.prompts).toHaveLength(2);
		captured.prompts[1].onCancel!();
		await second;
	});
});

describe("startAddUnderFolder — E4 parent-exists checks", () => {
	it("a parent that never existed: Notice, no prompt, no node", async () => {
		const { deps } = setup();
		const result = await startAddUnderFolder(deps, VIEW_ID, "does-not-exist");
		expect(result).toBeNull();
		expect(captured.prompts).toHaveLength(0);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");
	});

	// The real scenario: the row existed when the menu was built (the caller holds its node), and was
	// removed between that and the choice in the second menu.
	it.each([
		["a Folder row", "docs", (vm: ViewsManager) => vm.deleteMetaFolder(VIEW_ID, "docs")],
		["a unit row", "quarry-drones", (vm: ViewsManager) => vm.unplaceNode(VIEW_ID, "quarry-drones")],
	])("%s removed after the menu was built, before the choice: Notice, no prompt, no addMetaFolder, nothing planted at the root", async (_name, parentId, remove) => {
		const { vm, deps, addMetaFolder, selection } = setup();
		const menuTimeNode = vm.getNode(VIEW_ID, parentId);
		expect(menuTimeNode).not.toBeNull(); // it was there when the menu was built
		const rootBefore = vm.getViews()[0].root.map((n) => n.id);
		const projectsBefore = vm.getNode(VIEW_ID, "projects")!.children.map((c) => c.id);

		remove(vm);
		const result = await startAddUnderFolder(deps, VIEW_ID, parentId);

		expect(result).toBeNull();
		expect(captured.prompts).toHaveLength(0);
		expect(addMetaFolder).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(rootBefore);
		expect(vm.getNode(VIEW_ID, "projects")!.children.map((c) => c.id)).toEqual(projectsBefore.filter((id) => id !== parentId));
		expect([...selection]).toEqual([]);
	});

	it("parent removed while the prompt is open: on confirm, Notice, no node, not added at the view root", async () => {
		const { vm, deps, addMetaFolder } = setup();
		const promise = startAddUnderFolder(deps, VIEW_ID, "docs");
		expect(captured.prompts).toHaveLength(1);

		vm.deleteMetaFolder(VIEW_ID, "docs");
		captured.prompts[0].onSubmit("Archive");
		const result = await promise;

		expect(result).toBeNull();
		expect(addMetaFolder).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");
		// addMetaFolder's own silent view-root fallback must never be reached from here.
		expect(vm.getViews()[0].root.some((n) => n.label === "Archive")).toBe(false);
	});
});

describe("startAddUnderFolder — E5 selection and expansion", () => {
	it("expands the parent and selects exactly the new node, from a multi-row starting selection", async () => {
		const { vm, deps, selection } = setup();
		selection.add("quarry-drones");
		selection.add("docs");
		vm.setNodeCollapsed(VIEW_ID, "projects", true);

		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onSubmit("Archive");
		const created = await promise;

		expect(vm.getNode(VIEW_ID, "projects")!.collapsed).toBe(false);
		expect([...selection]).toEqual([created!.id]);
	});

	it("a failed or cancelled add leaves the selection unchanged", async () => {
		const { deps, selection } = setup();
		selection.add("quarry-drones");
		selection.add("docs");

		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onCancel!();
		await promise;

		expect([...selection]).toEqual(["quarry-drones", "docs"]);
	});
});

describe("startAddUnderFolder — E6 the shared per-parent lock", () => {
	it("a held lock gives a Notice and no second prompt", async () => {
		const { deps } = setup();
		const first = startAddUnderFolder(deps, VIEW_ID, "projects");
		expect(captured.prompts).toHaveLength(1);

		const second = startAddUnderFolder(deps, VIEW_ID, "projects");
		const secondResult = await second;

		expect(secondResult).toBeNull();
		expect(captured.prompts).toHaveLength(1);
		expect(Notice.instances.some((n) => n.message.toLowerCase().includes("already adding"))).toBe(true);

		captured.prompts[0].onCancel!();
		await first;
	});

	it("the same parent can run again once the first run has finished", async () => {
		const { deps } = setup();
		const first = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onCancel!();
		await first;

		const second = startAddUnderFolder(deps, VIEW_ID, "projects");
		expect(captured.prompts).toHaveLength(2);
		captured.prompts[1].onSubmit("Archive");
		const created = await second;
		expect(created?.label).toBe("Archive");
	});
});

describe("startAddUnderFolder — G4/GP7 no disk change; F4/F5 no sibling-insert, no move", () => {
	it("the vault adapter mock records zero create, modify or rename calls", async () => {
		const { app, deps } = setup();
		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onSubmit("Archive");
		await promise;
		expect((app.vault as unknown as { calls: string[] }).calls).toEqual([]);
	});

	it("the sibling count grows by exactly one and existing children keep their order", async () => {
		const { vm, deps } = setup();
		const before = vm.getNode(VIEW_ID, "projects")!.children.map((c) => c.id);
		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onSubmit("Archive");
		const created = await promise;
		const after = vm.getNode(VIEW_ID, "projects")!.children;
		expect(after).toHaveLength(before.length + 1);
		expect(after.slice(0, before.length).map((c) => c.id)).toEqual(before);
		expect(after.at(-1)!.id).toBe(created!.id);
	});

	it("the clicked row's own level and position are unchanged: the new Folder is a child, never a sibling", async () => {
		const { vm, deps } = setup();
		const rootBefore = vm.getViews()[0].root.map((n) => n.id);
		const levelBefore = vm.getNode(VIEW_ID, "projects")!.children.map((c) => c.id);
		const clickedIndexBefore = levelBefore.indexOf("docs");

		const promise = startAddUnderFolder(deps, VIEW_ID, "docs");
		captured.prompts[0].onSubmit("Archive");
		const created = await promise;

		// The root level and the clicked row's own level (its siblings) are exactly as they were...
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(rootBefore);
		const levelAfter = vm.getNode(VIEW_ID, "projects")!.children.map((c) => c.id);
		expect(levelAfter).toEqual(levelBefore);
		expect(levelAfter.indexOf("docs")).toBe(clickedIndexBefore);
		// ...and the new Folder is nested inside the clicked row, nowhere else.
		expect(vm.getNode(VIEW_ID, "docs")!.children.map((c) => c.id)).toEqual([created!.id]);
		expect(vm.getNode(VIEW_ID, "projects")!.children.some((c) => c.id === created!.id)).toBe(false);
		expect(vm.getViews()[0].root.some((n) => n.id === created!.id)).toBe(false);
	});

	it("adding under a root-level row leaves the other root rows and its own index alone", async () => {
		const root: ViewNode[] = [meta("first", "First"), ...tree(), meta("last", "Last")];
		const { vm, deps } = setup(root);
		const rootBefore = vm.getViews()[0].root.map((n) => n.id);

		const promise = startAddUnderFolder(deps, VIEW_ID, "projects");
		captured.prompts[0].onSubmit("Archive");
		await promise;

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(rootBefore);
		expect(vm.getViews()[0].root.indexOf(vm.getNode(VIEW_ID, "projects")!)).toBe(1);
	});
});
