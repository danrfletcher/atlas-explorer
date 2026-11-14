import { beforeEach, describe, expect, it } from "vitest";
import { App, Platform, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { GraduationController, type GraduationDeps } from "../../src/graduation";
import { seedRoot } from "../helpers";

/** Wires `getFileCache`/`getFirstLinkpathDest` the way `unit-index.test.ts` does. */
function stubLinks(app: App, caches: Record<string, CachedMetadata>, resolve: Record<string, string>): void {
	app.metadataCache.getFileCache = ((file: TFile) => caches[file.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const dest = resolve[linkpath];
		return dest ? (app.vault.getAbstractFileByPath(dest) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
}

const link = (name: string) => ({ link: name, original: `[[${name}]]`, displayText: name, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } });

function make(settings: Partial<AtlasSettings>, files: string[], folders: string[], caches: Record<string, CachedMetadata> = {}, resolve: Record<string, string> = {}, manual: Parameters<typeof UnitIndex.prototype.addManualPromotion>[0][] = []) {
	const app = new App();
	seedRoot(app, files, folders);
	stubLinks(app, caches, resolve);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, ...settings }, manual);
	index.rebuild();
	return { app, index };
}

const FILES = ["Sources/tephra/README.md", "Sources/tephra/docs/Guide.md", "Notes/Idea.md", "Notes/Other.md", "Root.md"];
const FOLDERS = ["Sources", "Sources/tephra", "Sources/tephra/docs", "Notes"];
const folderUnits = (index: UnitIndex) => index.getUnits().filter((u) => u.type === "folder-unit").map((u) => u.path).sort();
const promoted = (index: UnitIndex) => index.getUnits().filter((u) => u.type.startsWith("promoted")).map((u) => u.path).sort();

beforeEach(() => {
	Platform.isMobile = false;
});

describe("R3-1: UnitIndex skips Sources/ while the Tephra toggle is on", () => {
	it("Sources never appears as a module, and the user's own modules still do", () => {
		const { index } = make({ tephraEnabled: true }, FILES, FOLDERS);
		expect(folderUnits(index)).toEqual(["Notes"]);
		expect(index.getUnits().some((u) => u.path === "Sources" || u.path.startsWith("Sources/"))).toBe(false);
	});

	it("with the toggle off, a real Sources folder is an ordinary vault-root module", () => {
		const { index } = make({ tephraEnabled: false }, FILES, FOLDERS);
		expect(folderUnits(index)).toEqual(["Notes", "Sources"]);
	});

	it("on mobile the toggle counts as off, whatever data.json says", () => {
		Platform.isMobile = true;
		const { index } = make({ tephraEnabled: true }, FILES, FOLDERS);
		expect(folderUnits(index)).toEqual(["Notes", "Sources"]);
	});

	it("a vault note linking to a top-level Sources file promotes nothing, on (a deeper one is PR-8: unit-index-source-promotion.test.ts)", () => {
		const caches = { "Notes/Idea.md": { links: [link("README")] } as CachedMetadata };
		const { index } = make({ tephraEnabled: true }, FILES, FOLDERS, caches, { README: "Sources/tephra/README.md" });
		expect(promoted(index)).toEqual([]);
	});

	it("a Sources file linking to a vault note promotes nothing, on", () => {
		const caches = { "Sources/tephra/README.md": { links: [link("Idea")] } as CachedMetadata };
		const { index } = make({ tephraEnabled: true }, FILES, FOLDERS, caches, { Idea: "Notes/Idea.md" });
		expect(promoted(index)).toEqual([]);
	});

	it("a block link into a Sources file promotes nothing, on", () => {
		const caches = { "Notes/Idea.md": { links: [link("README#^abc")] } as CachedMetadata };
		const { index } = make({ tephraEnabled: true }, FILES, FOLDERS, caches, { "README#^abc": "Sources/tephra/README.md" });
		expect(index.getUnits().filter((u) => u.type === "promoted-block")).toEqual([]);
	});

	it("the same links promote with the toggle off (the skip is gated on the toggle)", () => {
		const caches = { "Notes/Idea.md": { links: [link("README")] } as CachedMetadata };
		const { index } = make({ tephraEnabled: false }, FILES, FOLDERS, caches, { README: "Sources/tephra/README.md" });
		expect(promoted(index)).toContain("Sources/tephra/README.md");
	});

	it("links between vault notes still promote, on: the skip is only for Sources", () => {
		const caches = { "Root.md": { links: [link("Idea")] } as CachedMetadata };
		const { index } = make({ tephraEnabled: true }, FILES, FOLDERS, caches, { Idea: "Notes/Idea.md" });
		expect(promoted(index)).toEqual(["Notes/Idea.md"]);
	});

	it("a manual promotion under Sources/ is not listed while on, and is kept so it returns when off", () => {
		const manual = [{ kind: "file" as const, path: "Sources/tephra/README.md" }];
		const { index, app } = make({ tephraEnabled: true }, FILES, FOLDERS, {}, {}, manual);
		expect(promoted(index)).toEqual([]);
		expect(index.getManualPromotions()).toHaveLength(1);
		const off = new UnitIndex(app, { ...DEFAULT_SETTINGS, tephraEnabled: false }, manual);
		off.rebuild();
		expect(promoted(off)).toEqual(["Sources/tephra/README.md"]);
	});

	it("a new Sources/ folder created while on never becomes a module (onVaultCreate)", () => {
		const { index, app } = make({ tephraEnabled: true }, ["Notes/Idea.md"], ["Notes"]);
		const folder = app.vault.seedFolder("Sources");
		index.onVaultCreate(folder);
		expect(folderUnits(index)).toEqual(["Notes"]);
	});

	it("the toggle is read live: flipping it changes the next rebuild", () => {
		const settings = { ...DEFAULT_SETTINGS, tephraEnabled: true };
		const app = new App();
		seedRoot(app, FILES, FOLDERS);
		const index = new UnitIndex(app, settings, []);
		index.rebuild();
		expect(folderUnits(index)).toEqual(["Notes"]);
		settings.tephraEnabled = false;
		index.rebuild();
		expect(folderUnits(index)).toEqual(["Notes", "Sources"]);
	});

	it("isExcludedPath (the MCP add_node refusal) agrees: Sources paths are refused only while on", () => {
		const on = make({ tephraEnabled: true }, FILES, FOLDERS).index;
		const off = make({ tephraEnabled: false }, FILES, FOLDERS).index;
		expect(on.isExcludedPath("Sources/tephra/README.md")).toBe(true);
		expect(off.isExcludedPath("Sources/tephra/README.md")).toBe(false);
		expect(on.isExcludedPath("SourcesX/a.md")).toBe(false);
	});
});

describe("R3-1: Graduation skips Sources/ while the toggle is on", () => {
	/** A pool folder inside Sources/ is the only way a pool rename can touch it: graduation needs the old and new
	 * path in the same pool folder. */
	function graduation(skips: boolean) {
		const app = new App();
		seedRoot(app, ["Sources/pool/Draft.md"], ["Sources", "Sources/pool"]);
		const deps = {
			vault: app.vault,
			fileManager: { renameFile: async () => {} },
			scheduler: { setTimeout: () => 1, clearTimeout: () => {} },
			getPoolFolder: () => "Sources/pool",
			getExcludedFolders: () => [],
			skipsSources: () => skips,
			notify: () => {},
			afterMove: () => {},
			onHiddenMove: () => {},
			openDialog: async () => null,
		} as unknown as GraduationDeps;
		return { app, controller: new GraduationController(deps) };
	}

	it("a pool rename under Sources/ graduates with the toggle off, and is ignored with it on", () => {
		for (const [skips, expected, pending] of [[false, "scheduled", 1], [true, "ignored", 0]] as const) {
			const { app, controller } = graduation(skips);
			const file = app.vault.getAbstractFileByPath("Sources/pool/Draft.md") as TFile;
			expect(controller.handleRename(file, "Sources/pool/Old name.md")).toBe(expected);
			expect(controller.pendingCount()).toBe(pending);
		}
	});

	it("a delete under Sources/ forgets nothing while on, and a pending record is forgotten while off", () => {
		for (const [skips, pending] of [[true, 1], [false, 0]] as const) {
			const { app, controller } = graduation(false);
			const file = app.vault.getAbstractFileByPath("Sources/pool/Draft.md") as TFile;
			controller.handleRename(file, "Sources/pool/Old name.md");
			expect(controller.pendingCount()).toBe(1);
			(controller as unknown as { deps: { skipsSources: () => boolean } }).deps.skipsSources = () => skips;
			controller.handleDelete(file);
			expect(controller.pendingCount()).toBe(pending);
		}
	});
});
