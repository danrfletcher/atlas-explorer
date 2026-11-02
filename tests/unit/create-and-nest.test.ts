import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { CreateKind, acquireParentLock, createOnDisk, parentExists } from "../../src/create-and-nest";
import { createFromMeta, startCreateFromMeta } from "../../src/create-from-meta";
import { file, folder as folderRef, meta, setup, tMany } from "../integration/create-from-meta-fixtures";
import { flush, heldCount, key, modals } from "../helpers";

const notices = () => Notice.instances.map((n) => n.message);
const KINDS: CreateKind[] = ["block", "file", "module"];

beforeEach(() => {
	Notice.reset();
});

afterEach(async () => {
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
});

describe("shared create: createOnDisk", () => {
	it.each(KINDS)("creates %s on disk, holds the path before the first write, and returns {ref, path, rollback, release}", async (kind) => {
		const s = setup(tMany());
		const before = s.listing();
		const result = await createOnDisk(s.deps, kind, "Field tech");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(typeof result.rollback).toBe("function");
		expect(typeof result.release).toBe("function");
		expect(result.path).toBe(result.ref.path);

		// Still held at this point: a redraw reading getUnits right now must not list it as unplaced.
		expect(heldCount(s.index, result.path)).toBe(1);
		expect(s.index.getUnits().some((u) => u.path === result.path)).toBe(false);
		result.release();
		expect(heldCount(s.index, result.path)).toBe(0);
		expect(s.index.getUnits().some((u) => u.path === result.path)).toBe(true);

		const added = s.listing().filter((p) => !before.includes(p));
		if (kind === "module") {
			expect(added.sort()).toEqual(["Field tech/", "Field tech/Field tech.md"]);
			expect(result.ref).toEqual(folderRef("Field tech"));
			expect(s.contentOf("Field tech/Field tech.md")).toBe("# Field tech\n");
		} else if (kind === "file") {
			expect(added).toEqual(["Field tech.md"]);
			expect(result.ref).toEqual(file("Field tech.md"));
			expect(s.contentOf("Field tech.md")).toBe("# Field tech\n");
		} else {
			expect(added).toHaveLength(1);
			expect(added[0]).toMatch(/^_pool\/\d{14}-[0-9a-z]{4}\.md$/);
			expect(result.ref).toEqual(file(added[0]));
			expect(s.contentOf(added[0])).toBe("# Field tech\n");
		}
	});

	it("block creates the pool folder on demand when it doesn't exist yet", async () => {
		const s = setup(tMany(), { pool: "Fresh pool" });
		const result = await createOnDisk(s.deps, "block", "Field tech");
		expect(result.ok).toBe(true);
		expect(s.app.vault.getAbstractFileByPath("Fresh pool")).not.toBeNull();
		if (result.ok) result.release();
	});

	it("an empty or vault-root pool setting refuses before any write, with no hold taken", async () => {
		const s = setup(tMany());
		for (const pool of ["", " ", "/", "."]) {
			s.deps.getPoolFolder = () => pool;
			const before = s.listing();
			const result = await createOnDisk(s.deps, "block", "Field tech");
			expect(result.ok).toBe(false);
			expect(s.listing()).toEqual(before);
		}
	});
});

describe("rollback: createOnDisk undoes exactly what it made and always releases the hold", () => {
	it("file: the create throws — nothing written, hold count zero", async () => {
		const s = setup(tMany());
		const before = s.listing();
		vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("disk says no"));
		const result = await createOnDisk(s.deps, "file", "Field tech");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toContain("disk says no");
		expect(s.listing()).toEqual(before);
		expect(heldCount(s.index, "Field tech.md")).toBe(0);
	});

	it("module: the folder itself can't be made — nothing written, hold count zero", async () => {
		const s = setup(tMany());
		const before = s.listing();
		vi.spyOn(s.app.vault, "createFolder").mockRejectedValue(new Error("disk says no"));
		const result = await createOnDisk(s.deps, "module", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.listing()).toEqual(before);
		expect(heldCount(s.index, "Field tech")).toBe(0);
	});

	it("module: the folder is made, the note throws — the now-empty folder is removed again, hold count zero", async () => {
		const s = setup(tMany());
		const before = s.listing();
		vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("disk says no"));
		const result = await createOnDisk(s.deps, "module", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.listing()).toEqual(before);
		expect(s.app.vault.getAbstractFileByPath("Field tech")).toBeNull();
		expect(heldCount(s.index, "Field tech")).toBe(0);
	});

	it("block: the pool folder can't be made — nothing written, hold count zero", async () => {
		const s = setup(tMany(), { pool: "Pool2" });
		const before = s.listing();
		vi.spyOn(s.app.vault, "createFolder").mockRejectedValue(new Error("disk says no"));
		const result = await createOnDisk(s.deps, "block", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.listing()).toEqual(before);
	});

	it("block: the pool folder is made, the file write throws — the now-empty pool is removed again, hold count zero", async () => {
		const s = setup(tMany(), { pool: "Pool2" });
		const before = s.listing();
		const now = new Date(2026, 8, 25, 14, 30, 12);
		vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("disk says no"));
		const result = await createOnDisk({ ...s.deps, now: () => now, random: () => 0 }, "block", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.listing()).toEqual(before);
		expect(s.app.vault.getAbstractFileByPath("Pool2")).toBeNull();
		expect(heldCount(s.index, "Pool2/20260925143012-0000.md")).toBe(0);
	});

	it.each(KINDS)("nest step fails after a successful %s disk create: the caller's rollback() undoes it and release() clears the hold", async (kind) => {
		const s = setup(tMany());
		const before = s.listing();
		const made = await createOnDisk(s.deps, kind, "Field tech");
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error("unreachable");
		// Simulates the caller's own nest step refusing (parent gone, placeUnit/addMetaFolder failed,
		// replaceMetaNodeWithUnit returned false) — the caller is responsible for calling these two.
		const leftover = await made.rollback();
		made.release();
		expect(leftover).toBe("");
		expect(s.listing()).toEqual(before);
		expect(heldCount(s.index, made.path)).toBe(0);
	});

	it("a non-empty module folder left behind after rollback is reported in `leftover`, and the hold still clears", async () => {
		const s = setup(tMany());
		const made = await createOnDisk(s.deps, "module", "Field tech");
		if (!made.ok) throw new Error("unreachable");
		// Something else (not this run) adds a second file into the module folder before rollback runs.
		await s.app.vault.create("Field tech/extra.md", "");
		const leftover = await made.rollback();
		made.release();
		expect(leftover).toContain("isn't empty");
		expect(s.app.vault.getAbstractFileByPath("Field tech")).not.toBeNull();
		expect(heldCount(s.index, "Field tech")).toBe(0);
	});
});

describe("parent guard: parentExists", () => {
	it("true for a unit row and for a Folder that both still exist", () => {
		const s = setup(tMany());
		expect(parentExists(s.deps, "default", "ft")).toBe(true); // Folder (meta)
		expect(parentExists(s.deps, "default", "c-existing")).toBe(true); // unit
	});

	it("false once gone, for a unit parent and for a Folder parent", () => {
		const s = setup(tMany());
		// A Folder parent, deleted.
		s.views.deleteMetaFolder("default", "c-sub");
		expect(parentExists(s.deps, "default", "c-sub")).toBe(false);
		// A unit-row parent, removed from the view.
		s.views.unplaceNode("default", "c-existing");
		expect(parentExists(s.deps, "default", "c-existing")).toBe(false);
		// The flow-level proof that every add kind actually calls this guard before nesting (placeUnit,
		// placeNewUnit and addMetaFolder spied on) lives in add-under-lifecycle.test.ts.
	});

	it("without the guard, placeUnit/addMetaFolder silently fall back to the view root instead of refusing — exactly the bug the guard exists to prevent", () => {
		const s = setup(tMany());
		s.views.unplaceNode("default", "c-existing");
		const rootLenBefore = s.views.getView("default")!.root.length;
		s.views.placeUnit("default", file("New.md"), "c-existing"); // parent id gone, un-gated
		expect(s.views.getView("default")!.root).toHaveLength(rootLenBefore + 1);
	});

	it("false for an id that never existed", () => {
		const s = setup(tMany());
		expect(parentExists(s.deps, "default", "never-existed")).toBe(false);
	});
});

describe("lock: acquireParentLock, keyed on viewId:parentId, shared by Create and every later add kind", () => {
	// Each add kind taking this lock through its own entry point (block/file/module/folder) is covered
	// in add-under-lifecycle.test.ts; Create's is covered below. These are the lock's own rules.
	it("a second acquire for the same view+parent is refused while the first holds it; release lets a third run", () => {
		const release1 = acquireParentLock("default", "ft", false);
		expect(release1).not.toBeNull();
		expect(acquireParentLock("default", "ft", false)).toBeNull();
		release1!();
		const release3 = acquireParentLock("default", "ft", false);
		expect(release3).not.toBeNull();
		release3!();
	});

	it("the same parent id in a different view is not blocked", () => {
		const release1 = acquireParentLock("default", "ft", false)!;
		const releaseOtherView = acquireParentLock("second", "ft", false);
		expect(releaseOtherView).not.toBeNull();
		release1();
		releaseOtherView!();
	});

	it("a different parent in the same view is not blocked", () => {
		const release1 = acquireParentLock("default", "ft", false)!;
		const releaseOtherParent = acquireParentLock("default", "other", false);
		expect(releaseOtherParent).not.toBeNull();
		release1();
		releaseOtherParent!();
	});

	it("shows a Notice only when the caller passes notifyBusy: true", () => {
		const release = acquireParentLock("default", "ft", false)!;
		expect(acquireParentLock("default", "ft", false)).toBeNull();
		expect(notices()).toEqual([]);
		expect(acquireParentLock("default", "ft", true)).toBeNull();
		expect(notices()).toHaveLength(1);
		release();
	});

	it("release is idempotent: calling it twice doesn't free the key an extra time or throw", () => {
		const release = acquireParentLock("default", "ft", false)!;
		release();
		release();
		const again = acquireParentLock("default", "ft", false);
		expect(again).not.toBeNull();
		again!();
	});

	it("Create takes its lock from the exact same set: a raw lock on the key silently blocks Create (no dialog, no Notice), and Create's own lock blocks a raw acquire until it finishes", async () => {
		const s = setup(tMany());
		const raw = acquireParentLock("default", "ft", false)!;
		await startCreateFromMeta(s.deps, "file", "default", "ft");
		expect(modals()).toHaveLength(0);
		expect(notices()).toEqual([]);
		raw();

		const done = startCreateFromMeta(s.deps, "file", "default", "ft");
		expect(modals()).toHaveLength(1);
		expect(acquireParentLock("default", "ft", false)).toBeNull();
		expect(acquireParentLock("default", "other", false)).not.toBeNull();
		key("Escape");
		await done;
		const afterCreate = acquireParentLock("default", "ft", false);
		expect(afterCreate).not.toBeNull();
		afterCreate!();
	});

	it("the lock releases after Create succeeds, after it fails, and after it is cancelled, so the same parent can run again each time", async () => {
		const s = setup(tMany());

		const ok = startCreateFromMeta(s.deps, "file", "default", "ft");
		key("Enter");
		await ok;
		expect(s.views.getNode("default", "ft")!.type).toBe("unit");
		acquireParentLock("default", "ft", false)!();

		s.views.getView("default")!.root.push(meta("ft2", "Field tech 2"));
		const failing = vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("disk says no"));
		const failed = startCreateFromMeta(s.deps, "file", "default", "ft2");
		key("Enter");
		await failed;
		failing.mockRestore();
		expect(s.views.getNode("default", "ft2")!.type).toBe("meta");
		acquireParentLock("default", "ft2", false)!();

		s.views.getView("default")!.root.push(meta("ft3", "Field tech 3"));
		const cancelled = startCreateFromMeta(s.deps, "file", "default", "ft3");
		key("Escape");
		await cancelled;
		acquireParentLock("default", "ft3", false)!();
	});
});

describe("inbox hold: the shared disk-create helper on a real UnitIndex", () => {
	it.each(KINDS)("a getUnits spy sampled on every index change between create and release never shows the new %s as unplaced", async (kind) => {
		const s = setup(tMany());
		const spy = vi.spyOn(s.index, "getUnits");
		const baseline = s.index.getUnits().map((u) => u.path);
		const samples: (string | undefined)[][] = [];
		const unsub = s.index.onChange(() => samples.push(s.index.getUnits().map((u) => u.path)));

		const made = await createOnDisk(s.deps, kind, "Field tech");
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error("unreachable");

		expect(samples.length).toBeGreaterThan(0);
		for (const sample of samples) expect(sample, kind).toEqual(baseline);
		// Right here — between create and the caller's nest step — a read must still see the baseline.
		expect(s.index.getUnits().map((u) => u.path)).toEqual(baseline);

		made.release();
		expect(s.index.getUnits().some((u) => u.path === made.path)).toBe(true);
		expect(spy).toHaveBeenCalled();
		unsub();
	});
});

describe("E7: createFromMeta leaves the hold count at zero after every outcome", () => {
	// The unit's path for each kind: Field tech.md for a file, the folder for a module, and the pool
	// path (fixed clock and random) for a block.
	const NOW = new Date(2026, 8, 25, 14, 30, 12);
	const PATHS: Record<CreateKind, string> = { block: "_pool/20260925143012-0000.md", file: "Field tech.md", module: "Field tech" };

	it.each(KINDS)("%s: success", async (kind) => {
		const s = setup(tMany());
		const result = await createFromMeta({ ...s.deps, now: () => NOW, random: () => 0 }, kind, "default", "ft", "Field tech");
		expect(result.ok).toBe(true);
		expect(heldCount(s.index, PATHS[kind])).toBe(0);
	});

	it.each(KINDS)("%s: the folder is gone before the swap — rolled back, hold zero", async (kind) => {
		const s = setup(tMany());
		const before = s.listing();
		const original = s.app.vault.create.bind(s.app.vault);
		// The meta folder disappears while the disk step runs (a data sync).
		vi.spyOn(s.app.vault, "create").mockImplementation(async (...args: Parameters<typeof original>) => {
			s.views.deleteMetaFolder("default", "ft");
			return original(...args);
		});
		const result = await createFromMeta({ ...s.deps, now: () => NOW, random: () => 0 }, kind, "default", "ft", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.listing()).toEqual(before);
		expect(heldCount(s.index, PATHS[kind])).toBe(0);
		expect(notices().some((m) => m.includes("the folder no longer exists"))).toBe(true);
	});

	it.each(KINDS)("%s: the swap is refused — rolled back, hold zero", async (kind) => {
		const s = setup(tMany());
		const before = s.listing();
		s.deps.replaceMetaNodeWithUnit = () => false;
		const result = await createFromMeta({ ...s.deps, now: () => NOW, random: () => 0 }, kind, "default", "ft", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.listing()).toEqual(before);
		expect(heldCount(s.index, PATHS[kind])).toBe(0);
	});

	it.each(KINDS)("%s: the save fails — the item stays, reported, hold zero (released before the save)", async (kind) => {
		const s = setup(tMany());
		s.deps.save = async () => {
			// Already released by now: release runs before save.
			expect(heldCount(s.index, PATHS[kind])).toBe(0);
			throw new Error("disk full");
		};
		const result = await createFromMeta({ ...s.deps, now: () => NOW, random: () => 0 }, kind, "default", "ft", "Field tech");
		expect(result.ok).toBe(true);
		expect(notices().some((m) => m.includes("saving the views failed: disk full"))).toBe(true);
		expect(heldCount(s.index, PATHS[kind])).toBe(0);
		expect(s.views.getNode("default", "ft")!.type).toBe("unit");
	});

	it.each(KINDS)("%s: the disk create fails — hold zero", async (kind) => {
		const s = setup(tMany());
		vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("disk says no"));
		vi.spyOn(s.app.vault, "createFolder").mockRejectedValue(new Error("disk says no"));
		const result = await createFromMeta({ ...s.deps, now: () => NOW, random: () => 0 }, kind, "default", "ft", "Field tech");
		expect(result.ok).toBe(false);
		expect(heldCount(s.index, PATHS[kind])).toBe(0);
	});
});
