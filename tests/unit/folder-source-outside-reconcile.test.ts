import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ViewsManager } from "../../src/views";
import { diffOutsideChildren } from "../../src/folder-source";
import { FolderSourceConfig, PLACEHOLDER_ROW_KIND, UnitRef, ViewNode, unitRefKey } from "../../src/types";

/** PR-2 (R2-Q2): outside deletes and renames reconcile the same way in every mode, except for what a
 * delete leaves behind (the mode's placeholder). Fixtures are two real node trees over a temp folder,
 * with bare root-relative refs. */

type Mode = "merge" | "append" | "overwrite";
const MODES: Mode[] = ["merge", "append", "overwrite"];

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-reconcile-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Owner "owner" over `dir`, managing `a.pdf` (with a user-nested child and a status) and `b.pdf`. */
function fixture(mode: Mode) {
	const nested: ViewNode = { id: "nested", type: "unit", ref: { kind: "file", path: "Notes/kept.md" }, children: [] };
	const nodeA: ViewNode = {
		id: "node-a",
		type: "unit",
		ref: { kind: "file", path: "a.pdf" },
		children: [nested],
		folderSourceManaged: true,
		folderSourceOwnerId: "owner",
		explicitStatusId: "done",
	};
	const nodeB: ViewNode = {
		id: "node-b",
		type: "unit",
		ref: { kind: "file", path: "b.pdf" },
		children: [],
		folderSourceManaged: true,
		folderSourceOwnerId: "owner",
	};
	const folderSource: FolderSourceConfig = {
		type: "folder",
		location: "outside",
		path: "",
		showFiles: true,
		showFolders: true,
		mode,
	};
	const owner: ViewNode = { id: "owner", type: "meta", label: "Invoices", children: [nodeA, nodeB], folderSource };
	const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", () => {});
	return { vm, owner, nodeA, nodeB };
}

function write(...names: string[]): void {
	for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
}

const childIds = (owner: ViewNode) => owner.children.map((c) => c.id);

describe.each(MODES)("outside reconcile — %s mode", (mode) => {
	it("delete: the row is demoted per mode, and its children lift up in its place", () => {
		write("a.pdf", "b.pdf");
		const { vm, owner, nodeA } = fixture(mode);
		fs.rmSync(path.join(dir, "a.pdf"));

		vm.refreshFolderSource("v1", "owner", dir);

		expect(childIds(owner)).toEqual(["nested", "node-b"]);
		expect(owner.children.some((c) => c.id === nodeA.id)).toBe(false);
		const key = unitRefKey({ kind: "file", path: "a.pdf" });
		const placeholder = owner.apiItemState?.[key];
		if (mode === "overwrite") {
			expect(placeholder).toBeUndefined();
		} else {
			expect(placeholder).toBeDefined();
			expect(placeholder?.kind).toBe(PLACEHOLDER_ROW_KIND);
			expect(placeholder?.folderSourceDeleted).toBe(true);
			expect(placeholder?.label).toBe("a");
			expect(placeholder?.explicitStatusId).toBe("done");
		}
		expect(placeholder?.noteRef).toBeUndefined();
		expect(placeholder?.notFound === true).toBe(mode === "merge");
	});

	it("rename: the same node keeps its children, status and position, and only its ref changes", () => {
		write("a.pdf", "b.pdf");
		const { vm, owner, nodeA } = fixture(mode);
		fs.renameSync(path.join(dir, "a.pdf"), path.join(dir, "c.pdf"));

		vm.refreshFolderSource("v1", "owner", dir);

		expect(childIds(owner)).toEqual(["node-a", "node-b"]);
		expect(owner.children[0]).toBe(nodeA);
		expect(nodeA.ref).toEqual({ kind: "file", path: "c.pdf" });
		expect(nodeA.explicitStatusId).toBe("done");
		expect(nodeA.children.map((c) => c.id)).toEqual(["nested"]);
		expect(owner.apiItemState ?? {}).toEqual({});
	});

	it("rename onto a name that already has a row: no duplicate, and the old row is demoted", () => {
		write("a.pdf", "b.pdf");
		const { vm, owner } = fixture(mode);
		fs.renameSync(path.join(dir, "a.pdf"), path.join(dir, "b.pdf"));

		vm.refreshFolderSource("v1", "owner", dir);

		expect(childIds(owner)).toEqual(["nested", "node-b"]);
		const refs = owner.children.filter((c) => c.folderSourceManaged).map((c) => unitRefKey(c.ref as UnitRef));
		expect(refs).toEqual([unitRefKey({ kind: "file", path: "b.pdf" })]);
		const placeholderOn = Object.values(owner.apiItemState ?? {}).length;
		expect(placeholderOn).toBe(mode === "overwrite" ? 0 : 1);
	});

	it("delete and re-add of the same name between two refreshes: the end state is the untouched row", () => {
		write("a.pdf", "b.pdf");
		const { vm, owner, nodeA } = fixture(mode);
		fs.rmSync(path.join(dir, "a.pdf"));
		write("a.pdf");

		vm.refreshFolderSource("v1", "owner", dir);

		expect(childIds(owner)).toEqual(["node-a", "node-b"]);
		expect(owner.children[0]).toBe(nodeA);
		expect(owner.apiItemState ?? {}).toEqual({});
	});
});

describe("diffOutsideChildren (pure rename detection)", () => {
	const file = (name: string): UnitRef => ({ kind: "file", path: name });
	const folder = (name: string): UnitRef => ({ kind: "folder", path: name });

	it("one gone and one new of the same kind is a rename", () => {
		expect(diffOutsideChildren([file("a.pdf")], [file("c.pdf")], new Set())).toEqual({
			renamed: [{ from: file("a.pdf"), to: file("c.pdf") }],
			gone: [],
		});
	});

	it("two simultaneous renames are ambiguous, so both are reported as gone and the adds stand alone", () => {
		const result = diffOutsideChildren([file("a.pdf"), file("b.pdf")], [file("c.pdf"), file("d.pdf")], new Set());
		expect(result.renamed).toEqual([]);
		expect(result.gone).toEqual([file("a.pdf"), file("b.pdf")]);
	});

	it("a rename alongside an unrelated add is ambiguous, so it is a delete", () => {
		const result = diffOutsideChildren([file("a.pdf")], [file("c.pdf"), file("new.pdf")], new Set());
		expect(result.renamed).toEqual([]);
		expect(result.gone).toEqual([file("a.pdf")]);
	});

	it("a rename never crosses kinds: a file gone and a folder appearing is a delete plus an add", () => {
		const result = diffOutsideChildren([file("a.pdf")], [folder("a.pdf")], new Set());
		expect(result.renamed).toEqual([]);
		expect(result.gone).toEqual([file("a.pdf")]);
	});

	it("a user-removed ref that shows up again is not counted as a rename target", () => {
		const removed = new Set([unitRefKey(file("c.pdf"))]);
		expect(diffOutsideChildren([file("a.pdf")], [file("c.pdf")], removed)).toEqual({ renamed: [], gone: [file("a.pdf")] });
	});

	it("nothing changed yields no renames and no deletes", () => {
		expect(diffOutsideChildren([file("a.pdf")], [file("a.pdf")], new Set())).toEqual({ renamed: [], gone: [] });
	});
});

describe("PR-1 R2: a managed row re-nested elsewhere in the view still gets its rename persisted", () => {
	it("saves (not just notifies) when reconcileOutsideChildChanges renames a node outside the owner's own subtree", () => {
		write("a.pdf", "b.pdf");
		const nodeA: ViewNode = {
			id: "node-a",
			type: "unit",
			ref: { kind: "file", path: "a.pdf" },
			children: [],
			folderSourceManaged: true,
			folderSourceOwnerId: "owner",
		};
		const nodeB: ViewNode = {
			id: "node-b",
			type: "unit",
			ref: { kind: "file", path: "b.pdf" },
			children: [],
			folderSourceManaged: true,
			folderSourceOwnerId: "owner",
		};
		// `nodeA` is managed by "owner" but lives under an unrelated sibling node the user dragged it
		// into, nowhere inside owner's own children — the scenario collectManagedMatches already walks
		// the whole view root for, but refreshFolderSource's old before/after snapshot missed.
		const elsewhere: ViewNode = { id: "elsewhere", type: "meta", label: "Elsewhere", children: [nodeA] };
		const folderSource: FolderSourceConfig = { type: "folder", location: "outside", path: "", showFiles: true, showFolders: true, mode: "merge" };
		const owner: ViewNode = { id: "owner", type: "meta", label: "Invoices", children: [nodeB], folderSource };
		const persist = vi.fn();
		const vm = new ViewsManager(
			{} as App,
			[{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner, elsewhere] }],
			"v1",
			persist
		);

		fs.renameSync(path.join(dir, "a.pdf"), path.join(dir, "c.pdf"));
		vm.refreshFolderSource("v1", "owner", dir);

		expect(nodeA.ref).toEqual({ kind: "file", path: "c.pdf" });
		expect(persist).toHaveBeenCalledTimes(1);
	});
});
