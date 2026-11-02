import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { UnitRef, View, ViewNode, unitRefKey, unitToRef } from "../../src/types";
import { button, flush, heldCount, key, modals, seedRoot, type } from "../helpers";
import { file, meta, unit } from "../integration/create-from-meta-fixtures";

// PR-3.F2 (T1 fix): every other add-under-file.test.ts case drives `startAddUnderFile` with a
// stand-in `getParentLabel` that never resolves a ref against a real vault (`node.type === "meta"
// ? node.label : "quarry-drones"`, hard-coded). The reviewer's own R3 finding flagged this as the
// one piece of the flow with zero coverage of the real resolver — `addUnderFileDeps().getParentLabel`
// at explorer-view.ts, which for a plain unit row falls through to `this.resolveRef`, which in turn
// reads `this.unitsByRefKey` (only ever populated by a real `render()` pass). This suite drives the
// real dispatcher (`startAddUnder`) with the real resolver wired up exactly as `AtlasExplorerView`
// wires it, against a real `ViewsManager`/`UnitIndex`, and proves the real dialog actually opens for
// both a Folder (meta) parent and a plain unit-file parent — the two cases live testing (T1) found
// broken were in fact reachable all along; this is the regression test closing that gap.
describe("PR-3.F2 — Add under > File: real flow, wired through startAddUnder, with the real getParentLabel resolver", () => {
	function host() {
		const app = new App();
		seedRoot(app, ["quarry-drones.md"], []);
		const vm = new ViewsManager(
			app as unknown as App,
			[{ id: "v1", name: "Default", inboxMode: "view", root: [meta("projects", "Projects", [unit("quarry-drones", file("quarry-drones.md"))])] }],
			"v1",
			() => {}
		);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, poolFolder: "_pool", excludedFolders: ["_pool"] }, []);
		index.rebuild();
		app.vault.on("create", (f) => index.onVaultCreate(f));
		app.vault.on("delete", (f) => index.onVaultDelete(f.path));
		const liveView = vm.getViews()[0];

		const fakeThis = {
			plugin: {
				app,
				viewsManager: vm,
				unitIndex: index,
				settings: { poolFolder: "_pool", excludedFolders: ["_pool"] },
				freeBlockTextCache: undefined,
				// `runAddUnderFile`'s own post-create step hands off to `addUnderHiddenSignals`, which
				// reads this — a plain no-op stand-in, same shape `add-under-block`/`add-under-folder`'s
				// own real-flow tests already use, so nothing here governs and no Notice fires.
				statusesManager: { findGoverningAncestor: () => null, resolveNodeStatus: () => null },
			},
			filterText: "",
			bucketListEl: document.createElement("div"),
			selectedBucketNodeIds: new Set<string>(),
			selectedInboxRefKeys: new Set<string>(),
			selectionAnchor: null as string | null,
			selectionAnchorScope: null as "bucket" | "inbox" | null,
			// The real render() pass is what normally fills this in (explorer-view.ts:1483) — a row
			// the user can actually right-click has already rendered at least once, so this is always
			// populated by the time "Add under" runs live. Reproduced here rather than skipped.
			unitsByRefKey: new Map(index.getUnits().map((u) => [unitRefKey(unitToRef(u)), u])),
			render: vi.fn(() => Promise.resolve()),
			awaitRenderSettled: vi.fn(() => Promise.resolve()),
		};
		const proto = AtlasExplorerView.prototype as unknown as {
			startAddUnder(this: unknown, kind: string, view: View, node: ViewNode): void;
			runAddUnderFile(this: unknown, view: View, node: ViewNode): Promise<void>;
			addUnderFileDeps(this: unknown): unknown;
			addUnderParentLabel(this: unknown, ...a: unknown[]): unknown;
			expandAddUnderParent(this: unknown, ...a: unknown[]): unknown;
			addUnderHiddenSignals(this: unknown, ...a: unknown[]): unknown;
			ancestorsForNode(this: unknown, ...a: unknown[]): unknown;
			matchesFilter(this: unknown, text: string): boolean;
			isOutsideManagedUnit(this: unknown, view: View, node: ViewNode): boolean;
			resolveOutsideManagedRowInfo(this: unknown, ref: UnitRef): unknown;
			resolveRef(this: unknown, ref: UnitRef): unknown;
		};
		for (const name of [
			"startAddUnder",
			"runAddUnderFile",
			"addUnderFileDeps",
			"addUnderParentLabel",
			"expandAddUnderParent",
			"addUnderHiddenSignals",
			"ancestorsForNode",
			"matchesFilter",
			"isOutsideManagedUnit",
			"resolveOutsideManagedRowInfo",
			"resolveRef",
		] as const) {
			(fakeThis as Record<string, unknown>)[name] = proto[name];
		}

		return { fakeThis, proto, liveView, vm, index };
	}

	// `addUnderHiddenSignals`'s own `classifyHiddenReason` uses `CSS.escape` to build its selector,
	// same gap `add-under-block`/`add-under-folder`'s real-flow tests in explorer-view-menu.test.ts
	// already cover with this exact stub — jsdom has no `CSS` global at all.
	let originalCSS: unknown;
	beforeEach(() => {
		originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
	});

	afterEach(async () => {
		if (modals().length) key("Escape");
		await flush();
		document.body.innerHTML = "";
		(globalThis as { CSS?: unknown }).CSS = originalCSS;
	});

	it("on a Folder (meta) parent, the real dialog opens titled with the Folder's own label", async () => {
		const { fakeThis, proto, liveView, vm } = host();
		const parentNode = vm.getNode("v1", "projects")!;

		proto.startAddUnder.call(fakeThis, "file", liveView, parentNode);
		await flush();

		expect(modals()).toHaveLength(1);
		expect(document.querySelector(".modal-title")!.textContent).toBe("Add file under Projects");
	});

	it("on a plain unit-file parent, the real dialog opens titled with the unit's resolved display text", async () => {
		const { fakeThis, proto, liveView, vm } = host();
		const parentNode = vm.getNode("v1", "quarry-drones")!;

		proto.startAddUnder.call(fakeThis, "file", liveView, parentNode);
		await flush();

		expect(modals()).toHaveLength(1);
		expect(document.querySelector(".modal-title")!.textContent).toBe("Add file under quarry-drones");
	});

	it("end to end: typing a name and confirming actually creates and nests the file under a real unit-file parent, selected", async () => {
		const { fakeThis, proto, liveView, vm, index } = host();
		const parentNode = vm.getNode("v1", "quarry-drones")!;

		proto.startAddUnder.call(fakeThis, "file", liveView, parentNode);
		await flush();
		expect(modals()).toHaveLength(1);

		type("Quarry Notes");
		expect(button("Add").disabled).toBe(false);
		key("Enter");
		await flush();

		expect(modals()).toHaveLength(0);
		const children = vm.getNode("v1", "quarry-drones")!.children;
		expect(children).toHaveLength(1);
		expect(heldCount(index, "Quarry Notes.md")).toBe(0);
		expect([...fakeThis.selectedBucketNodeIds]).toEqual([children[0].id]);
	});

	it("G8/E1 cancel (Escape): nothing created, no node, lock released so a second attempt proceeds", async () => {
		const { fakeThis, proto, liveView, vm, index } = host();
		const parentNode = vm.getNode("v1", "quarry-drones")!;

		proto.startAddUnder.call(fakeThis, "file", liveView, parentNode);
		await flush();
		expect(modals()).toHaveLength(1);

		key("Escape");
		await flush();

		expect(modals()).toHaveLength(0);
		expect(vm.getNode("v1", "quarry-drones")!.children).toHaveLength(0);
		expect(index.getUnits().some((u) => u.path === "Quarry Notes.md")).toBe(false);
		expect(fakeThis.selectedBucketNodeIds.size).toBe(0);

		// Lock released: a second attempt on the same parent opens its own real dialog right away.
		proto.startAddUnder.call(fakeThis, "file", liveView, parentNode);
		await flush();
		expect(modals()).toHaveLength(1);
		type("Quarry Notes");
		key("Enter");
		await flush();
		expect(vm.getNode("v1", "quarry-drones")!.children).toHaveLength(1);
	});
});
