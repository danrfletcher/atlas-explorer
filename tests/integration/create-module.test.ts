import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, Notice, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { UnitRef, View, ViewNode } from "../../src/types";
import { createModule } from "../../src/create-module";
import { GraduationController } from "../../src/graduation";
import { LINKS_NOT_UPDATED_MESSAGE, noticeIfLinksNotUpdated } from "../../src/links-notice";

const file = (path: string): UnitRef => ({ kind: "file", path });
const folder = (path: string): UnitRef => ({ kind: "folder", path });
const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });
const meta = (id: string, label: string, children: ViewNode[] = []): ViewNode => ({ id, type: "meta", label, children, collapsed: false });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** FX-VIEWS: Multi.md placed four times, plus a block node and children. */
function fixtureViews(): View[] {
	return [
		{
			id: "default",
			name: "Default",
			inboxMode: "view",
			root: [
				meta("m1", "Field tech", [
					unit("a", file("A.md")),
					unit("q", file("Quarry drone LiDAR.md"), { collapsed: true, explicitStatusId: "s-doing", statusEnabled: true, statusSetId: "set1", applyTo: { file: true, module: false } }),
					unit("b", file("B.md")),
					meta("sub", "Sub meta", [unit("m-sub", file("Multi.md"))]),
				]),
				unit("m-top", file("Multi.md"), {
					collapsed: false,
					children: [unit("alpha", folder("Alpha")), unit("reading", file("Reading list.md"))],
				}),
				unit("beta", folder("Beta"), { children: [unit("m-beta", file("Multi.md"))] }),
				unit("blk", { kind: "block", path: "Multi.md", subpath: "^abc123" }),
			],
		},
		{
			id: "second",
			name: "Second",
			inboxMode: "view",
			root: [unit("gov", folder("Alpha"), { statusEnabled: true, statusSetId: "set1", children: [unit("m-second", file("Multi.md"))] })],
		},
	];
}

function setup(links: boolean | undefined = true) {
	const app = new App();
	for (const f of ["Quarry drone LiDAR.md", "Multi.md", "A.md", "B.md", "Reading list.md", "Snail.md", "Draft [v2].md", "Linker.md"]) app.vault.seedFile(f);
	for (const d of ["Alpha", "Beta", "_pool"]) app.vault.seedFolder(d);
	for (const f of ["Alpha/Alpha.md", "Alpha/Sub/Doc.md", "Beta/Deep.md"]) {
		if (f.includes("Sub/")) app.vault.seedFolder("Alpha/Sub");
		app.vault.seedFile(f);
	}
	app.vault.config.alwaysUpdateLinks = links;
	const persist = vi.fn();
	const saved: View[][] = [];
	const views = new ViewsManager(app, fixtureViews(), "default", persist);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, excludedFolders: ["_pool"] }, [file("Multi.md"), file("Alpha/Sub/Doc.md"), file("Alpha/Alpha.md")]);
	index.rebuild();
	// What Atlas's main.ts does on a vault rename/create.
	const renames: Array<[string, string]> = [];
	app.vault.on("create", (f) => index.onVaultCreate(f));
	app.vault.on("rename", (f, oldPath) => {
		renames.push([oldPath, f.path]);
		index.onVaultRename(f, oldPath);
		views.onVaultRename(oldPath, f.path);
	});
	const deps = {
		app,
		convert: (from: string, to: string) => void views.convertFileNodesToModule(from, to, index),
		// What data.json would hold at the moment of the flush.
		save: async () => void saved.push(JSON.parse(JSON.stringify(views.getViews())) as View[]),
		afterMove: () => void noticeIfLinksNotUpdated(app),
	};
	const listing = () => [...app.vault.getFiles().map((f) => f.path), ...[...app.vault.getRoot().children].filter((c) => "children" in c).map((c) => c.path + "/")].sort();
	return { app, views, index, deps, renames, persist, saved, listing };
}

const refs = (views: View[]): UnitRef[] => {
	const out: UnitRef[] = [];
	const walk = (nodes: ViewNode[]) => nodes.forEach((n) => (n.ref && out.push(n.ref), walk(n.children)));
	views.forEach((v) => walk(v.root));
	return out;
};
const find = (views: View[], id: string): ViewNode => {
	let found: ViewNode | undefined;
	const walk = (nodes: ViewNode[]) => nodes.forEach((n) => (n.id === id ? (found = n) : walk(n.children)));
	views.forEach((v) => walk(v.root));
	return found!;
};
const notices = () => Notice.instances.map((n) => n.message);

beforeEach(() => Notice.reset());

describe("Create Module end to end (mock vault, real views and index)", () => {
	it("AC-5 keeps id, index, fold state and status fields; only ref changes to a folder ref", async () => {
		const s = setup();
		const before = clone(s.views.getViews());
		const target = s.app.vault.getAbstractFileByPath("Quarry drone LiDAR.md") as TFile;
		const result = await createModule(s.deps, target, target.path, "Quarry drone LiDAR");
		expect(result.ok).toBe(true);
		const after = s.views.getViews();
		const siblings = find(after, "m1").children.map((c) => c.id);
		expect(siblings).toEqual(["a", "q", "b", "sub"]);
		expect(find(after, "q")).toEqual({ ...find(before, "q"), ref: folder("Quarry drone LiDAR") });
		expect(s.listing()).toContain("Quarry drone LiDAR/Quarry drone LiDAR.md");
		expect(s.listing()).not.toContain("Quarry drone LiDAR.md");
	});

	it("EC-17 the views are flushed once, after conversion, holding the folder ref and no stale file ref", async () => {
		const s = setup();
		const target = s.app.vault.getAbstractFileByPath("Quarry drone LiDAR.md") as TFile;
		await createModule(s.deps, target, target.path, "Quarry drone LiDAR");
		expect(s.saved).toHaveLength(1);
		const flushed = refs(s.saved[0]);
		expect(find(s.saved[0], "q").ref).toEqual(folder("Quarry drone LiDAR"));
		expect(flushed).not.toContainEqual(file("Quarry drone LiDAR.md"));
	});

	it("AC-6/AC-7/AC-12/EC-16 converts all four nodes, the manual promotion, leaves the block a block, one move", async () => {
		const s = setup();
		const renameFile = vi.spyOn(s.app.fileManager, "renameFile");
		const multi = s.app.vault.getAbstractFileByPath("Multi.md") as TFile;
		await createModule(s.deps, multi, "Multi.md", "Multi");
		expect(renameFile).toHaveBeenCalledTimes(1);
		for (const id of ["m-sub", "m-top", "m-beta", "m-second"]) expect(find(s.views.getViews(), id).ref).toEqual(folder("Multi"));
		expect(s.index.getManualPromotions()).toEqual([folder("Multi"), file("Alpha/Sub/Doc.md"), file("Alpha/Alpha.md")]);
		expect(refs(s.views.getViews())).not.toContainEqual(file("Multi/Multi.md"));
		expect(find(s.views.getViews(), "blk").ref).toEqual({ kind: "block", path: "Multi/Multi.md", subpath: "^abc123" });
		expect(s.index.getUnits().find((u) => u.type === "promoted-file" && u.path === "Multi/Multi.md")).toBeUndefined();
		// children stay nested, in order, untouched on disk
		expect(find(s.views.getViews(), "m-top").children.map((c) => [c.id, c.ref])).toEqual([["alpha", folder("Alpha")], ["reading", file("Reading list.md")]]);
		expect(s.listing()).toEqual(expect.arrayContaining(["Alpha/Alpha.md", "Alpha/Sub/Doc.md", "Beta/Deep.md", "Reading list.md"]));
	});

	it("FR-1/FR-7 the vault diff is one folder and one moved file, the same size with duplicates in play", async () => {
		const s = setup();
		const before = s.listing();
		const multi = s.app.vault.getAbstractFileByPath("Multi.md") as TFile;
		await createModule(s.deps, multi, "Multi.md", "Multi");
		const after = s.listing();
		expect(before.filter((p) => !after.includes(p))).toEqual(["Multi.md"]);
		expect(after.filter((p) => !before.includes(p)).sort()).toEqual(["Multi/", "Multi/Multi.md"]);
		expect(s.renames).toEqual([["Multi.md", "Multi/Multi.md"]]);
		expect(after.filter((p) => p.startsWith("_pool"))).toEqual(before.filter((p) => p.startsWith("_pool")));
	});

	it("EC-15 a rename in the dialog is one rename event straight to the final path", async () => {
		const s = setup();
		const draft = s.app.vault.getAbstractFileByPath("Draft [v2].md") as TFile;
		await createModule(s.deps, draft, draft.path, "Draft v2");
		expect(s.renames).toEqual([["Draft [v2].md", "Draft v2/Draft v2.md"]]);
	});

	it("EC-18/EC-21 a failed move leaves views, promotions, listing and file alone; only the error notice shows", async () => {
		const s = setup(false);
		const beforeViews = JSON.stringify(s.views.getViews());
		const beforePromotions = JSON.stringify(s.index.getManualPromotions());
		const listing = s.listing();
		vi.spyOn(s.app.fileManager, "renameFile").mockRejectedValue(new Error("nope"));
		const snail = s.app.vault.getAbstractFileByPath("Snail.md") as TFile;
		await createModule(s.deps, snail, "Snail.md", "Snail");
		expect(JSON.stringify(s.views.getViews())).toBe(beforeViews);
		expect(JSON.stringify(s.index.getManualPromotions())).toBe(beforePromotions);
		expect(s.listing()).toEqual(listing);
		expect(s.renames).toEqual([]);
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Snail": nope']);
		expect(s.persist).not.toHaveBeenCalled();
	});

	it("EC-23 links off: proceeds, converts, and shows the links notice exactly once per Create", async () => {
		const s = setup(false);
		const multi = s.app.vault.getAbstractFileByPath("Multi.md") as TFile;
		await createModule(s.deps, multi, "Multi.md", "Multi");
		expect(notices()).toEqual([LINKS_NOT_UPDATED_MESSAGE]);
		expect(find(s.views.getViews(), "m-beta").ref).toEqual(folder("Multi"));
	});

	it("EC-23 links on: no notice", async () => {
		const s = setup(true);
		await createModule(s.deps, s.app.vault.getAbstractFileByPath("Multi.md") as TFile, "Multi.md", "Multi");
		expect(notices()).toEqual([]);
	});

	it("EC-30 the move does not trigger graduation, and a root rename is not a pool rename", async () => {
		const s = setup();
		const openDialog = vi.fn();
		const scheduled: unknown[] = [];
		const graduation = new GraduationController({
			vault: s.app.vault,
			fileManager: s.app.fileManager,
			scheduler: { setTimeout: (cb, ms) => scheduled.push([cb, ms]), clearTimeout: () => {} },
			getPoolFolder: () => "_pool",
			getExcludedFolders: () => ["_pool"],
			notify: () => {},
			afterMove: () => {},
			openDialog,
		});
		s.app.vault.on("rename", (f, oldPath) => graduation.handleRename(f, oldPath));
		await createModule(s.deps, s.app.vault.getAbstractFileByPath("Snail.md") as TFile, "Snail.md", "Snail");
		expect(graduation.pendingCount()).toBe(0);
		expect(scheduled).toEqual([]);
		expect(openDialog).not.toHaveBeenCalled();
	});

	it("EC-27 never edits content (no modify, process, append or frontmatter call)", async () => {
		const s = setup();
		const modify = vi.spyOn(s.app.vault, "modify");
		await createModule(s.deps, s.app.vault.getAbstractFileByPath("Snail.md") as TFile, "Snail.md", "Snail");
		expect(modify).not.toHaveBeenCalled();
		expect((s.app.vault as unknown as { calls: string[] }).calls).toEqual(["createFolder", "fileManager.renameFile", "rename"]);
	});
});

describe("fence regression (source level)", () => {
	const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

	it("FR-3/FR-4/FR-6 adds no command, native-explorer hook or setting", () => {
		const src = read("src/create-module.ts");
		expect(src).not.toMatch(/addCommand\(|addSettingTab|new Setting\(|registerEvent|workspace\.on\(|"file-menu"|"editor-menu"/);
		expect(read("src/settings.ts").match(/new Setting\(/g)).toHaveLength(18); // 17 + "Never auto-promote from these folders"
	});

	it("FR-8 offers no undo, convert-back or demote", () => {
		expect(read("src/create-module.ts")).not.toMatch(/undo|demote|convert back/i);
	});

	it("FR-9 handleAddToModule keeps its confirm text", () => {
		expect(read("src/explorer-view.ts")).toContain("This moves the file on disk into that folder — Atlas doesn't otherwise touch a module's internal organization.");
	});

	it("inbox rows are unchanged: showInboxUnitMenu never mentions Create Module", () => {
		const explorer = read("src/explorer-view.ts");
		const inbox = explorer.slice(explorer.indexOf("private showInboxUnitMenu"), explorer.indexOf("private showMetaFolderMenu"));
		expect(inbox).not.toMatch(/Create Module|createModule/);
	});
});
