import type { App } from "obsidian";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

/** A MockApp-backed fixture (unlike `setup()` below, which uses `{} as App` since it never calls
 * anything that touches the vault) — needed by the R1/R2 tests here because they call
 * `refreshFolderSource`, which does read `app.vault` to rebuild real children. */
function setupWithVault(mode: "append" | "merge" | "overwrite") {
	const app = new MockApp();
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/a.md");
	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const view = vm.getViews()[0];
	const folder = vm.addMetaFolder(view.id, null, "Projects")!;
	vm.setFolderSource(view.id, folder.id, {
		type: "folder",
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		mode,
	});
	vm.refreshFolderSource(view.id, folder.id);
	return { vm, viewId: view.id, ownerId: folder.id };
}

/** One meta "Folder" node owning a Folder source in `mode`, with one managed real-unit child at
 * `Projects/a.md` — the minimal fixture every G12/G13/G14 case starts from. */
function setup(mode: "append" | "merge" | "overwrite", childOverrides: Partial<ViewNode> = {}) {
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
		...childOverrides,
	};
	const owner: ViewNode = {
		id: "owner",
		type: "meta",
		label: "Projects",
		children: [child],
		folderSource,
	};
	const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", persist);
	persist.mockClear();
	return { vm, persist, ownerId: "owner", childId: "child-1" };
}

describe("ViewsManager.onVaultDelete — PR-6 mode-reconciliation rule (G12/G13/G14)", () => {
	it.each([
		{ mode: "merge" as const, expectRow: true, expectNotFound: true },
		{ mode: "append" as const, expectRow: true, expectNotFound: false },
		{ mode: "overwrite" as const, expectRow: false, expectNotFound: false },
	])("mode=$mode: deleting the managed child's file produces exactly the G12/G13/G14 outcome", ({ mode, expectRow, expectNotFound }) => {
		const { vm, ownerId, childId } = setup(mode);

		vm.onVaultDelete("Projects/a.md");

		const owner = vm.getNode("v1", ownerId)!;
		// The real ViewNode is always removed from the tree — all three modes reconcile the *row*,
		// never leave the stale real unit sitting there.
		expect(owner.children.some((n) => n.id === childId)).toBe(false);

		const entries = Object.values(owner.apiItemState ?? {});
		if (!expectRow) {
			expect(entries).toHaveLength(0); // G14: overwrite leaves no placeholder at all.
			return;
		}
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.kind).toBe(PLACEHOLDER_ROW_KIND);
		expect(!!entry.notFound).toBe(expectNotFound);
		if (expectNotFound) {
			expect(entry.lastSeenAt).toBeTruthy();
		} else {
			// G13: append mode's row carries no attachment once G27's existing clear sweep (run in the
			// same onVaultDelete call) picks up the noteRef this rule deliberately pointed at the
			// just-deleted path.
			expect(entry.noteRef).toBeUndefined();
		}
	});

	it("merge-mode last-seen row matches PR-2's stale-placeholder shape exactly, plus the PR-6 demotion marker/position (R2/R3 fixes)", () => {
		const { vm, ownerId } = setup("merge");

		vm.onVaultDelete("Projects/a.md");

		const owner = vm.getNode("v1", ownerId)!;
		const entry = Object.values(owner.apiItemState ?? {})[0];
		// R3 fix: the title is the basename without extension ("a"), matching what the row displayed
		// while "Projects/a.md" still existed — not the raw path segment ("a.md").
		expect(entry).toEqual({
			id: "file:Projects/a.md",
			label: "a",
			kind: PLACEHOLDER_ROW_KIND,
			notFound: true,
			lastSeenAt: entry.lastSeenAt,
			explicitStatusId: undefined,
			secondary: undefined,
			noteRef: undefined,
			position: 0, // R3 fix: "a.md" was the owner's only (so 0th) child at the moment it was deleted.
			folderSourceDeleted: true, // R2 fix: marks this row as the sweep's own, not a genuine API row.
		});
	});

	it("append-mode row retains non-attachment fields (title, explicitStatusId, position) after link clearing — only noteRef mutates (R3 fix)", () => {
		const { vm, ownerId } = setup("append", { explicitStatusId: "in-progress" });

		vm.onVaultDelete("Projects/a.md");

		const owner = vm.getNode("v1", ownerId)!;
		const entry = Object.values(owner.apiItemState ?? {})[0];
		expect(entry.label).toBe("a"); // R3 fix: was "a.md".
		expect(entry.explicitStatusId).toBe("in-progress");
		expect(entry.noteRef).toBeUndefined();
		expect(entry.notFound).toBeFalsy();
		expect(entry.position).toBe(0); // R3 fix: retains the slot it occupied among the owner's children.
	});

	it("overwrite-mode deletion persists silently — no placeholder, and persist is still called once (no dialog/confirm in this layer)", () => {
		const { vm, persist, ownerId } = setup("overwrite");

		vm.onVaultDelete("Projects/a.md");

		expect(vm.getNode("v1", ownerId)!.apiItemState ?? {}).toEqual({});
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("absent mode defaults to merge (same default as a freshly-sanitized FolderSourceConfig)", () => {
		const persist = vi.fn();
		const folderSource = {
			type: "folder" as const,
			location: "inside" as const,
			path: "Projects",
			showFiles: true,
			showFolders: true,
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

		vm.onVaultDelete("Projects/a.md");

		const entry = Object.values(vm.getNode("v1", "owner")!.apiItemState ?? {})[0];
		expect(entry.notFound).toBe(true);
	});
});

describe("R1 fix: a sweep never drops noteRef/secondary a demoted row has since picked up", () => {
	it("merge mode: a noteRef/secondary manually attached after the delete survives a later refresh-triggered sweep", () => {
		const { vm, viewId, ownerId } = setupWithVault("merge");

		vm.onVaultDelete("Projects/a.md");
		const owner = vm.getNode(viewId, ownerId)!;
		const entryId = Object.keys(owner.apiItemState ?? {})[0];
		// Simulate "Add note"/manual attachment happening after the delete-time demotion — exactly
		// what the old sweep (which only ever reconstructed 4 fields) silently discarded.
		owner.apiItemState![entryId].noteRef = { kind: "file", path: "Elsewhere.md" };
		owner.apiItemState![entryId].secondary = "extra detail";

		vm.refreshFolderSource(viewId, ownerId);

		const after = vm.getNode(viewId, ownerId)!.apiItemState![entryId];
		expect(after.noteRef).toEqual({ kind: "file", path: "Elsewhere.md" });
		expect(after.secondary).toBe("extra detail");
	});

	it("append mode: a noteRef re-attached after the delete-time clear survives a later sweep instead of being wiped back to undefined", () => {
		const { vm, viewId, ownerId } = setupWithVault("append");

		vm.onVaultDelete("Projects/a.md");
		const owner = vm.getNode(viewId, ownerId)!;
		const entryId = Object.keys(owner.apiItemState ?? {})[0];
		expect(owner.apiItemState![entryId].noteRef).toBeUndefined(); // cleared by G27's sweep, same call.
		owner.apiItemState![entryId].noteRef = { kind: "file", path: "Reattached.md" };

		vm.refreshFolderSource(viewId, ownerId);

		expect(vm.getNode(viewId, ownerId)!.apiItemState![entryId].noteRef).toEqual({ kind: "file", path: "Reattached.md" });
	});
});

describe("R2 fix: the sweep only ever touches entries it itself demoted, never a coexisting genuine API-sourced row", () => {
	it("a node with both apiSource leftovers and a folderSource is swept without corrupting the apiSource's own apiItemState entries", () => {
		const { vm, viewId, ownerId } = setupWithVault("merge");
		const owner = vm.getNode(viewId, ownerId)!;
		// Simulate the exact R2 repro: this node still carries a genuine, unmarked API-sourced row
		// (e.g. left over from when it was an apiSource before being switched to a folderSource) —
		// `setApiSource`/`setFolderSource` each leave the other's state alone by design.
		owner.apiItemState = {
			...owner.apiItemState,
			"api-leftover": { id: "api-leftover", label: "Leftover API row", kind: PLACEHOLDER_ROW_KIND, lastSeenAt: "2025-01-01T00:00:00.000Z" },
		};
		owner.apiItemOrder = [...(owner.apiItemOrder ?? []), "api-leftover"];

		vm.onVaultDelete("Projects/a.md");
		vm.refreshFolderSource(viewId, ownerId); // triggers sweepFolderSourceDeletedPlaceholders

		const after = vm.getNode(viewId, ownerId)!;
		expect(after.apiItemState!["api-leftover"]).toEqual({
			id: "api-leftover",
			label: "Leftover API row",
			kind: PLACEHOLDER_ROW_KIND,
			lastSeenAt: "2025-01-01T00:00:00.000Z",
		});
	});
});
