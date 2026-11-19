import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App as ObsidianApp } from "obsidian";
import { App } from "../mocks/obsidian";
import { DEFAULT_SETTINGS, type AtlasSettings } from "../../src/settings";
import { SourceDeleteClassifier } from "../../src/source-delete-classifier";
import { existsOnDisk } from "../../src/sources-fs";
import { getPromotedRoots, setPromotedRoots } from "../../src/source-links";
import type { ViewsManager } from "../../src/views";
import { seedPaths } from "../sources-vault";
import { wirePluginVaultEvents } from "../sources-plugin-wiring";

// PR-12 (E5, R3-4): a promoted source's folder deleted or unplugged. Deletes under it arrive as vault `delete`
// events; the real `AtlasPlugin.onVaultDeleteEvent` must treat them as "missing", not as the user deleting notes:
// the view node's placeholder `noteRef` and the graduation state stay, and nothing pairs a later create as a move.
// Real: the classifier, the plugin handler, `ViewsManager`, `UnitIndex`, the disk probe (a temp tree). The
// promoted root is what `source.list` gave (`getPromotedRoots()`).

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "atlas-promoted-delete-"));
});
afterEach(() => {
	setPromotedRoots([]);
	rmSync(tmp, { recursive: true, force: true }); // only the temp dir this test made
});

const FILES = ["Sources/tephra/README.md", "Sources/tephra/crates/tephrad/src/registry.rs", "Sources/tephra/crates/tephrad/src/scan.rs", "Sources/tephra/crates/tephrad2/src/other.rs", "Sources/tephra/crates/tephrad/core/a.rs", "Notes/Idea.md"];

function setup() {
	const tephra = join(tmp, "Tephra");
	for (const file of FILES.filter((f) => f.startsWith("Sources/tephra/"))) {
		const real = join(tephra, file.slice("Sources/tephra/".length));
		mkdirSync(join(real, ".."), { recursive: true });
		writeFileSync(real, "x");
	}
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: true, tephraLinks: { tephra } };
	const classifier = new SourceDeleteClassifier({ getLinkTargets: () => settings.tephraLinks, targetExists: existsOnDisk, getPromotedRoots: () => getPromotedRoots() });
	setPromotedRoots([
		{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad", absRoot: join(tephra, "crates/tephrad") },
		{ name: "core", vaultPath: "Sources/tephra/crates/tephrad/core", absRoot: join(tephra, "crates/tephrad/core") },
	]);
	const app = new App();
	seedPaths(app, FILES);
	const ctx = wirePluginVaultEvents(app, settings, classifier);

	/** A view node whose placeholder `noteRef` points at `path`: what a real delete clears. */
	const place = (vm: ViewsManager, path: string) => {
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, `Holder ${path}`)!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "x", kind: "placeholder", noteRef: { kind: "file", path } } as never };
		node.apiItemOrder = ["1"];
		return () => vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef;
	};
	/** Obsidian's delete events for a vanished folder: children first. */
	const deleteAll = async (...paths: string[]) => {
		for (const path of paths) await app.vault.delete(app.vault.getAbstractFileByPath(path)!, true);
	};
	return { tephra, app, classifier, place, deleteAll, ...ctx };
}

describe("E5: a promoted source's folder is gone", () => {
	it("its files' delete events keep the view node's noteRef and graduation state, and pair no move", async () => {
		const s = setup();
		const registry = s.place(s.viewsManager, "Sources/tephra/crates/tephrad/src/registry.rs");
		const scan = s.place(s.viewsManager, "Sources/tephra/crates/tephrad/src/scan.rs");
		const viewsBefore = JSON.stringify(s.viewsManager.getViews());

		rmSync(join(s.tephra, "crates/tephrad"), { recursive: true, force: true }); // deleted or unplugged
		await s.deleteAll("Sources/tephra/crates/tephrad/src/registry.rs", "Sources/tephra/crates/tephrad/src/scan.rs", "Sources/tephra/crates/tephrad/core/a.rs", "Sources/tephra/crates/tephrad/src", "Sources/tephra/crates/tephrad/core", "Sources/tephra/crates/tephrad");

		expect(registry()).toEqual({ kind: "file", path: "Sources/tephra/crates/tephrad/src/registry.rs" });
		expect(scan()).toEqual({ kind: "file", path: "Sources/tephra/crates/tephrad/src/scan.rs" });
		expect(JSON.stringify(s.viewsManager.getViews())).toBe(viewsBefore);
		expect(s.graduationDeletes).toEqual([]);

		// The folder comes back: a same-named file created soon after is not a move out of anywhere.
		s.app.vault.seedFolder("Sources/tephra/crates/tephrad");
		s.app.vault.seedFolder("Sources/tephra/crates/tephrad/src");
		await s.app.vault.create("Sources/tephra/crates/tephrad/src/registry.rs", "x");
		expect(s.renames).toEqual([]);
		expect(registry()).toEqual({ kind: "file", path: "Sources/tephra/crates/tephrad/src/registry.rs" });
	});

	it("Tephra reporting the source missing is enough, even before the probe could say so", async () => {
		const s = setup();
		const registry = s.place(s.viewsManager, "Sources/tephra/crates/tephrad/src/registry.rs");
		s.classifier.setMissingSources(["tephrad"]);
		await s.deleteAll("Sources/tephra/crates/tephrad/src/registry.rs");
		expect(registry()).toEqual({ kind: "file", path: "Sources/tephra/crates/tephrad/src/registry.rs" });
		expect(s.graduationDeletes).toEqual([]);
	});

	it("a promoted folder inside a promoted folder: the outer one gone covers the inner one's files", async () => {
		const s = setup();
		const core = s.place(s.viewsManager, "Sources/tephra/crates/tephrad/core/a.rs");
		rmSync(join(s.tephra, "crates/tephrad"), { recursive: true, force: true });
		await s.deleteAll("Sources/tephra/crates/tephrad/core/a.rs");
		expect(core()).toEqual({ kind: "file", path: "Sources/tephra/crates/tephrad/core/a.rs" });
		expect(s.graduationDeletes).toEqual([]);
	});

	it("the same delete with the folder still there is a real delete: the noteRef clears and graduation hears of it", async () => {
		const s = setup();
		const registry = s.place(s.viewsManager, "Sources/tephra/crates/tephrad/src/registry.rs");
		await s.deleteAll("Sources/tephra/crates/tephrad/src/registry.rs"); // Dan deletes one note; the folder is fine
		expect(registry()).toBeUndefined();
		expect(s.graduationDeletes).toEqual(["Sources/tephra/crates/tephrad/src/registry.rs"]);
	});

	it("whole segments only: crates/tephrad2 is not inside crates/tephrad, so its delete stays real while tephrad is gone", async () => {
		const s = setup();
		const other = s.place(s.viewsManager, "Sources/tephra/crates/tephrad2/src/other.rs");
		rmSync(join(s.tephra, "crates/tephrad"), { recursive: true, force: true });
		await s.deleteAll("Sources/tephra/crates/tephrad2/src/other.rs");
		expect(other()).toBeUndefined();
		expect(s.graduationDeletes).toEqual(["Sources/tephra/crates/tephrad2/src/other.rs"]);
	});

	it("a vault file outside Sources/ is deleted as usual (F10)", async () => {
		const s = setup();
		const idea = s.place(s.viewsManager, "Notes/Idea.md");
		await s.deleteAll("Notes/Idea.md");
		expect(idea()).toBeUndefined();
	});
});
