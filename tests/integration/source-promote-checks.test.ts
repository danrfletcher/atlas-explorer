import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, Platform } from "obsidian";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { unitRefKey } from "../../src/types";
import { getPromotedRoots } from "../../src/source-links";
import { createMoveNodeTool, createCreateFolderTool, createRemoveNodeTool } from "../../src/mcp-arrange-tools";
import { makeSourcesRig, sectionEl, sectionRows, sectionTitles, type SourcesRig } from "../sources-explorer-fixture";
import { sourcesVaultPaths } from "../sources-vault";

// PR-12, tester round 1: the checklist lines that were not exercised live, pinned at the level a test can reach.
// C13 (Return to parent offline), C20 (a vault folder promoted), C22 (Sources/ unchanged on disk), C23 (F1: no index
// of a promoted source), C25 (F10: views, MCP tools and data.json unchanged). Same rig as source-promote-flow.test.ts:
// the real explorer, `TephraClient`/`TephraConnection`, the real promoter and roots sync, a fake daemon over HTTP.

const VAULT = "/Users/dan/Vault";
const TEPHRA = "/home/user/Developer/Tephra";

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
	Platform.isMobile = false;
});

function menuOf(row: HTMLElement): Menu {
	let built: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	vi.restoreAllMocks();
	return built!;
}
const headerOf = (name: string) => sectionEl(rig!.h, name).querySelector<HTMLElement>(".atlas-section-header")!;

/** A daemon that really promotes `<parent path>/<name>`: it adds the source (rooted where the folder is) and drops it from the parent. */
async function promotingRig(options: { vaultPaths?: string[]; vaultName?: string } = {}): Promise<SourcesRig> {
	let r!: SourcesRig;
	rig = await makeSourcesRig({
		settings: { autoPromotion: true },
		vaultPaths: options.vaultPaths,
		promote: { vaultPath: VAULT },
		methods: {
			"source.promote": (params) => {
				const { name, root } = params as { name: string; root: string };
				r.daemon.sources = [...r.daemon.sources, { name, path: root, status: "online" }];
				r.daemon.units = { ...r.daemon.units, [name]: [{ name: "guide.md", kind: "markdown" }] } as never;
				return { result: { status: "applied", deferred: 0 } };
			},
			"source.unpromote": (params) => {
				const { name } = params as { name: string };
				r.daemon.sources = r.daemon.sources.filter((s) => s.name !== name);
				const { [name]: _gone, ...rest } = r.daemon.units as Record<string, unknown>;
				r.daemon.units = rest as never;
				return { result: { status: "applied", deferred: 0 } };
			},
		},
	});
	r = rig;
	return rig;
}
async function promote(path: string): Promise<void> {
	await rig!.promoter!.makeOwnSource(path);
	await vi.waitFor(() => expect(getPromotedRoots().length).toBeGreaterThan(0));
	await rig!.settle();
}
const modalRows = () => [...document.querySelectorAll<HTMLElement>(".modal .atlas-row-internal .atlas-row-text")].map((el) => el.textContent);
const openContents = (path: string) => {
	const explorer = rig!.h.explorer as unknown as { openModuleContentsModal(p: string): void; openModuleModal: { close(): void } };
	explorer.openModuleContentsModal(path);
	const rows = modalRows();
	explorer.openModuleModal.close();
	return rows;
};

describe("C13: Return to parent while Tephra is offline", () => {
	it("the item is greyed out with the offline words, a click sends no unpromote, the user is told, nothing is queued", async () => {
		await promotingRig();
		await promote("Sources/tephra/docs");
		expect(sectionTitles(rig!.h)).toContain("[docs]");

		rig!.daemon.down = true;
		await rig!.check();
		const item = menuOf(headerOf("docs")).items.find((i) => i.title === "Return to parent")!;
		expect(item).toBeDefined();
		expect(item.disabled).toBe(true);

		rig!.daemon.requests.length = 0;
		await rig!.promoter!.returnToParent("docs");
		expect(rig!.daemon.requests.filter((r) => r.method === "source.unpromote")).toEqual([]);
		expect(rig!.confirms).toEqual(["Make docs its own source? It will be hidden in tephra."]); // only the earlier promote asked
		expect(rig!.notices).toEqual(["Atlas: Tephra isn't running."]);

		// Tephra comes back: nothing was queued, so nothing is replayed.
		rig!.daemon.down = false;
		await rig!.check();
		expect(rig!.daemon.requests.filter((r) => r.method === "source.unpromote")).toEqual([]);
		expect(getPromotedRoots().map((r) => r.name)).toEqual(["docs"]);
	});
});

describe("C20: a vault folder made its own source (Projects/Atlas -> [atlas])", () => {
	const PATHS = [...sourcesVaultPaths(), "Projects/Atlas/Plan.md", "Projects/Atlas/guide.md", "Projects/Atlas/sub/x.md", "Projects/Other.md", "Projects/Atlas2/Keep.md"];
	const link = (text: string) => ({ link: text, original: `[[${text}]]`, displayText: text, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } });
	const resolve = (text: string, from: string) => (rig!.plugin.sourceLinks as { resolveFile(t: string, f: string): { path: string } | null }).resolveFile(text, from)?.path ?? null;

	it("the confirm says it is hidden in the vault; [atlas] appears; Projects' Module Contents loses Atlas but keeps Atlas2; @atlas: resolves", async () => {
		await promotingRig({ vaultPaths: PATHS });
		expect(openContents("Projects")).toEqual(expect.arrayContaining(["Atlas", "Atlas2", "Other.md"]));

		await promote("Projects/Atlas");
		expect(rig!.confirms).toEqual(["Make atlas its own source? It will be hidden in the vault."]);
		expect(rig!.daemon.requests.filter((r) => r.method === "source.promote").map((r) => r.params)).toEqual([{ name: "atlas", root: `${VAULT}/Projects/Atlas` }]);
		expect(getPromotedRoots()).toEqual([{ name: "atlas", vaultPath: "Projects/Atlas", absRoot: `${VAULT}/Projects/Atlas` }]);
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[atlas]", "[tephra]", "[whoop]"]);

		const after = openContents("Projects");
		expect(after).not.toContain("Atlas");
		expect(after).toEqual(expect.arrayContaining(["Atlas2", "Other.md"])); // the prefix trap: Atlas2 is not inside Atlas
		expect(resolve("@atlas:Plan.md", "Weekly Review.md")).toBe("Projects/Atlas/Plan.md");
		expect(resolve("@atlas:sub/x.md", "Weekly Review.md")).toBe("Projects/Atlas/sub/x.md");
		expect(sectionRows(sectionEl(rig!.h, "atlas"))).toEqual(["guide"]);
	});

	it("a vault note outside the folder that links into it makes the target a pop-out of [atlas], not of the vault", async () => {
		await promotingRig({ vaultPaths: PATHS });
		const app = rig!.app as unknown as { metadataCache: { getFileCache: unknown } };
		app.metadataCache.getFileCache = (file: { path: string }) => (file.path === "Projects/Other.md" ? { links: [link("@atlas:sub/x.md")] } : null);
		await promote("Projects/Atlas");
		rig!.unitIndex.onMetadataResolved();
		await rig!.settle();
		const popped = rig!.unitIndex.getUnits().filter((u) => u.path === "Projects/Atlas/sub/x.md");
		expect(popped.map((u) => u.type)).toContain("promoted-file");
		const keys = [...sectionEl(rig!.h, "atlas").querySelectorAll<HTMLElement>("[data-select-key]")].map((el) => el.getAttribute("data-select-key"));
		expect(keys).toContain(unitRefKey({ kind: "file", path: "Projects/Atlas/sub/x.md" }));
		expect(sectionRows(sectionEl(rig!.h, null))).not.toContain("x");
	});

	it("Return to parent puts Atlas back in Projects' Module Contents and drops the section", async () => {
		await promotingRig({ vaultPaths: PATHS });
		await promote("Projects/Atlas");
		await rig!.promoter!.returnToParent("atlas");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		await rig!.settle();
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(openContents("Projects")).toContain("Atlas");
		expect(rig!.confirms[1]).toBe("Return atlas to the vault? Its section goes and the folder comes back in the vault.");
	});
});

describe("C22 (F2): Sources/ is the same before and after a promote and after a return", () => {
	it("the vault's Sources/ folder and the real fixture directory list the same entries at each step, and a promote never changes the link set", async () => {
		await promotingRig();
		const real = join(__dirname, "..", "fixtures", "sources-vault", "Sources");
		const mock = () => (rig!.app.vault.getAbstractFileByPath("Sources") as unknown as { children: Array<{ name: string }> }).children.map((c) => c.name).sort();
		const disk = () => readdirSync(real).sort();
		const before = { mock: mock(), disk: disk() };

		await promote("Sources/tephra/docs");
		expect({ mock: mock(), disk: disk() }).toEqual(before);

		await rig!.promoter!.returnToParent("docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		await rig!.settle();
		expect({ mock: mock(), disk: disk() }).toEqual(before);
		expect(before.disk).toEqual(["tephra", "whoop"]);
	});
});

describe("C23 (F1): Atlas keeps no index of the promoted source", () => {
	it("UnitIndex holds nothing under Sources/ before or after a promote (no links); the section's rows come from unit.list", async () => {
		await promotingRig();
		const underSources = () => rig!.unitIndex.getUnits().filter((u) => u.path.startsWith("Sources/"));
		expect(underSources()).toEqual([]);

		rig!.daemon.requests.length = 0;
		await promote("Sources/tephra/docs");
		rig!.unitIndex.rebuild(); // a full rebuild, the strongest form of "does the index scan it"
		expect(underSources()).toEqual([]);
		const lists = rig!.daemon.requests.filter((r) => r.method === "unit.list").map((r) => (r.params as { source: string }).source);
		expect(lists).toContain("docs");
		expect(sectionRows(sectionEl(rig!.h, "docs"))).toEqual(["guide"]);
	});
});

describe("C25 (F10): free blocks, modules, statuses, views and the MCP arrange tools behave the same", () => {
	const flat = (nodes: Array<{ children?: unknown[] }>): Array<Record<string, unknown>> => nodes.flatMap((n) => [n as Record<string, unknown>, ...flat((n.children ?? []) as Array<{ children?: unknown[] }>)]);

	it("move_node, create_folder and remove_node on a view that holds a promoted folder's unit give the same results before and after a promote; the views hold no source name", async () => {
		await promotingRig();
		const vm = rig!.viewsManager;
		const view = vm.getActiveView();
		const governor = vm.addMetaFolder(view.id, null, "Tasks")!;
		const other = vm.addMetaFolder(view.id, null, "Other")!;
		vm.setNodeStatus(view.id, governor.id, true, "S");
		const placed = vm.placeUnit(view.id, { kind: "file", path: "Sources/tephra/docs/guide.md" }, governor.id)!;

		const ctx = {
			getViewsManager: () => vm,
			getVaultName: () => "Vault",
			getVaultPath: () => VAULT,
			getVault: () => rig!.app.vault,
			getUnitIndex: () => rig!.unitIndex,
			getMetadataCache: () => rig!.app.metadataCache,
			promoteUnit: () => {},
			forgetDeviceLocalSourceState: () => {},
		};
		const run = async (tool: ReturnType<typeof createMoveNodeTool>, args: Record<string, unknown>) => JSON.parse(JSON.stringify(await tool.handler(args)));
		const strip = (r: Record<string, unknown>) => ({ ...r, nodeId: undefined });

		const moveBefore = await run(createMoveNodeTool(ctx as never), { view: view.name, nodeId: placed.id, newParentId: other.id });
		await promote("Sources/tephra/docs");
		const moveBack = await run(createMoveNodeTool(ctx as never), { view: view.name, nodeId: placed.id, newParentId: governor.id });
		await rig!.promoter!.returnToParent("docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		await rig!.settle();
		const moveAfter = await run(createMoveNodeTool(ctx as never), { view: view.name, nodeId: placed.id, newParentId: other.id });

		expect(moveBefore.nodeId).toBe(placed.id);
		expect(moveBack.nodeId).toBe(placed.id);
		expect(strip(moveAfter)).toEqual(strip(moveBefore));
		const created = await run(createCreateFolderTool(ctx as never), { view: view.name, label: "Made while promoted" });
		expect(created.nodeId).toEqual(expect.any(String));
		await run(createRemoveNodeTool(ctx as never), { view: view.name, nodeId: created.nodeId });

		const node = flat(vm.getActiveView().root as never).find((n) => n.id === placed.id)!;
		expect(node.ref).toEqual({ kind: "file", path: "Sources/tephra/docs/guide.md" });
		const json = JSON.stringify(vm.getViews());
		for (const name of ["docs", "tephra", "whoop"]) expect(json).not.toContain(`"source:${name}"`);
		expect(json).not.toContain("absRoot");
		expect(json).not.toContain(TEPHRA);
	});

	it("a free block, a module and a status in the vault render and resolve the same with a promoted source present", async () => {
		await promotingRig();
		const before = sectionRows(sectionEl(rig!.h, null));
		await promote("Sources/tephra/docs");
		expect(sectionRows(sectionEl(rig!.h, null))).toEqual(before);
	});
});
