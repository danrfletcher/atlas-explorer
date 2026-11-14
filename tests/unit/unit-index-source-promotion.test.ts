import { beforeEach, describe, expect, it } from "vitest";
import { App, Platform, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";

// PR-4 (G1): the pop-out rule inside a Tephra source, through the real `UnitIndex.rebuild()` /
// `computePromotions()` path with Obsidian's link cache stubbed the way unit-index-sources-skip.test.ts does.
function stubLinks(app: App, caches: Record<string, CachedMetadata>, resolve: Record<string, string>): void {
	app.metadataCache.getFileCache = ((file: TFile) => caches[file.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const dest = resolve[linkpath];
		return dest ? (app.vault.getAbstractFileByPath(dest) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
}
const link = (name: string) => ({ link: name, original: `[[${name}]]`, displayText: name, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } });
const cacheOf = (...names: string[]) => ({ links: names.map(link) }) as CachedMetadata;

const FILES = [
	"Sources/tephra/README.md",
	"Sources/tephra/crates/Core.md",
	"Sources/tephra/docs/Guide.md",
	"Sources/tephra/docs/deep/Deeper.md",
	"Sources/tephra/target/Built.md",
	"Home.md",
];
const FOLDERS = ["Sources", "Sources/tephra", "Sources/tephra/crates", "Sources/tephra/docs", "Sources/tephra/docs/deep", "Sources/tephra/target"];

function make(caches: Record<string, CachedMetadata>, resolve: Record<string, string>, settings: Partial<AtlasSettings> = {}) {
	const app = new App();
	seedRoot(app, FILES, FOLDERS);
	stubLinks(app, caches, resolve);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, tephraEnabled: true, ...settings }, []);
	index.rebuild();
	return { app, index };
}
const sourceUnits = (index: UnitIndex) => index.getUnits().filter((u) => u.path.startsWith("Sources/") && u.type.startsWith("promoted")).map((u) => `${u.type}:${u.path}`).sort();

beforeEach(() => {
	Platform.isMobile = false;
});

describe("UnitIndex: per-source pop-outs (G1)", () => {
	it("a link from another folder of the same source promotes the deeper file", () => {
		const { index } = make({ "Sources/tephra/crates/Core.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toEqual(["promoted-file:Sources/tephra/docs/deep/Deeper.md"]);
	});

	it("a link from the same top-level folder does not", () => {
		const { index } = make({ "Sources/tephra/docs/Guide.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toEqual([]);
	});

	it("a subpath link promotes only the block", () => {
		const { index } = make({ "Sources/tephra/crates/Core.md": cacheOf("Deeper#^abc") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toEqual(["promoted-block:Sources/tephra/docs/deep/Deeper.md"]);
	});

	it("a vault note's link into the source promotes the deeper file in the source's section, and the vault's own units are untouched (G12)", () => {
		const { index } = make({ "Home.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toEqual(["promoted-file:Sources/tephra/docs/deep/Deeper.md"]);
		expect(index.getUnits().filter((u) => !u.path.startsWith("Sources/") && u.type.startsWith("promoted"))).toEqual([]);
	});

	it("a self-link promotes nothing", () => {
		const { index } = make({ "Sources/tephra/docs/deep/Deeper.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toEqual([]);
	});

	it("an ignored folder's file never pops out (PR-3 exclude entries)", () => {
		const { index } = make({ "Sources/tephra/crates/Core.md": cacheOf("Built") }, { Built: "Sources/tephra/target/Built.md" }, { tephraExcludes: { tephra: ["Sources/tephra/target"] } });
		expect(sourceUnits(index)).toEqual([]);
	});

	it("with the toggle off nothing is derived per source: Sources is one ordinary module, so a link inside it is same-module", () => {
		const { index } = make({ "Sources/tephra/crates/Core.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" }, { tephraEnabled: false });
		expect(sourceUnits(index)).toEqual([]);
		expect(index.getUnits().some((u) => u.type === "folder-unit" && u.path === "Sources")).toBe(true);
	});

	it("deleting the promoted file drops its pop-out, and a recompute after the link goes drops it too", () => {
		const caches: Record<string, CachedMetadata> = { "Sources/tephra/crates/Core.md": cacheOf("Deeper") };
		const { index, app } = make(caches, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toHaveLength(1);
		index.onVaultDelete("Sources/tephra/docs/deep/Deeper.md");
		expect(sourceUnits(index)).toEqual([]);
		index.onMetadataResolved(); // the link is still in the cache, so it comes back until the file is really gone
		expect(sourceUnits(index)).toHaveLength(1);
		delete caches["Sources/tephra/crates/Core.md"];
		index.onMetadataResolved();
		expect(sourceUnits(index)).toEqual([]);
		expect(app.vault.getAbstractFileByPath("Sources/tephra/README.md")).not.toBeNull();
	});

	it("a pop-out is never persisted as a manual promotion", () => {
		const { index } = make({ "Sources/tephra/crates/Core.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(index.getManualPromotions()).toEqual([]);
		expect(index.isLinkOnlyPromotion(index.getUnits().find((u) => u.type === "promoted-file")!)).toBe(true);
	});
});

// PR-8 (G12): the module rule per source, one row per case, through the real `UnitIndex.rebuild()` path.
const G12_FILES = [
	"Sources/tephra/README.md",
	"Sources/tephra/crates/Core.md",
	"Sources/tephra/docs/Guide.md",
	"Sources/tephra/docs/deep/Deeper.md",
	"Sources/tephra/target/Built.md",
	"Sources/tephra/docs/Private/Secret.md",
	"Sources/tephra/docs/Private/Origin.md",
	"Sources/other/docs/Same.md",
	"Home.md",
	"Notes/Idea.md",
];
const G12_FOLDERS = ["Sources", "Sources/tephra", "Sources/tephra/crates", "Sources/tephra/docs", "Sources/tephra/docs/deep", "Sources/tephra/target", "Sources/tephra/docs/Private", "Sources/other", "Sources/other/docs", "Notes"];
const G12_RESOLVE = {
	Deeper: "Sources/tephra/docs/deep/Deeper.md",
	README: "Sources/tephra/README.md",
	Built: "Sources/tephra/target/Built.md",
	Idea: "Notes/Idea.md",
	Guide: "Sources/tephra/docs/Guide.md",
	Secret: "Sources/tephra/docs/Private/Secret.md",
	Core: "Sources/tephra/crates/Core.md",
};

function makeG12(caches: Record<string, CachedMetadata>, settings: Partial<AtlasSettings> = {}) {
	const app = new App();
	seedRoot(app, G12_FILES, G12_FOLDERS);
	stubLinks(app, caches, G12_RESOLVE);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, tephraEnabled: true, ...settings }, []);
	index.rebuild();
	return { app, index };
}
const vaultPromoted = (index: UnitIndex) => index.getUnits().filter((u) => !u.path.startsWith("Sources/") && u.type.startsWith("promoted")).map((u) => `${u.type}:${u.path}`);

describe("UnitIndex: the module rule per source (G12, table)", () => {
	const DEEPER = "promoted-file:Sources/tephra/docs/deep/Deeper.md";
	const SECRET = "promoted-file:Sources/tephra/docs/Private/Secret.md";
	const CORE = "promoted-file:Sources/tephra/crates/Core.md";
	const rows: Array<{ name: string; caches: Record<string, CachedMetadata>; settings?: Partial<AtlasSettings>; expected: string[] }> = [
		{ name: "same source, same module", caches: { "Sources/tephra/docs/Guide.md": cacheOf("Deeper") }, expected: [] },
		{ name: "same source, different module", caches: { "Sources/tephra/crates/Core.md": cacheOf("Deeper") }, expected: [DEEPER] },
		{ name: "cross-source (a folder of the same name in another source is another module)", caches: { "Sources/other/docs/Same.md": cacheOf("Deeper") }, expected: [DEEPER] },
		{ name: "vault -> source", caches: { "Home.md": cacheOf("Deeper") }, expected: [DEEPER] },
		{ name: "a vault note inside a module is still from outside the source", caches: { "Notes/Idea.md": cacheOf("Deeper") }, expected: [DEEPER] },
		{ name: "source root file as the origin counts as from outside", caches: { "Sources/tephra/README.md": cacheOf("Deeper") }, expected: [DEEPER] },
		{ name: "source root file as the target is already a row", caches: { "Sources/tephra/crates/Core.md": cacheOf("README") }, expected: [] },
		{ name: "block subpath promotes the block only", caches: { "Sources/tephra/crates/Core.md": cacheOf("Deeper#^b1") }, expected: ["promoted-block:Sources/tephra/docs/deep/Deeper.md"] },
		{ name: "block subpath from a vault note", caches: { "Home.md": cacheOf("Deeper#^b1") }, expected: ["promoted-block:Sources/tephra/docs/deep/Deeper.md"] },
		{ name: "self-link", caches: { "Sources/tephra/docs/deep/Deeper.md": cacheOf("Deeper") }, expected: [] },
		{ name: "excluded target (an ignored folder)", caches: { "Home.md": cacheOf("Built") }, settings: { tephraExcludes: { tephra: ["Sources/tephra/target"] } }, expected: [] },
		// R1: `excludedFolders` applies to a path under Sources/<name>/ as to a vault path, as target and as origin.
		{ name: "control: a file under a folder that is not excluded promotes", caches: { "Home.md": cacheOf("Secret") }, expected: [SECRET] },
		{ name: "excludedFolders entry under Sources/ as the target (a vault note links into it)", caches: { "Home.md": cacheOf("Secret") }, settings: { excludedFolders: ["Sources/tephra/docs/Private"] }, expected: [] },
		{ name: "excludedFolders entry under Sources/ as the target (another source module links into it)", caches: { "Sources/tephra/crates/Core.md": cacheOf("Secret") }, settings: { excludedFolders: ["Sources/tephra/docs/Private"] }, expected: [] },
		{ name: "excludedFolders entry naming the target file itself", caches: { "Home.md": cacheOf("Secret") }, settings: { excludedFolders: ["Sources/tephra/docs/Private/Secret.md"] }, expected: [] },
		{ name: "control: an origin inside a folder that is not excluded promotes", caches: { "Sources/tephra/docs/Private/Origin.md": cacheOf("Core") }, expected: [CORE] },
		{ name: "excludedFolders entry under Sources/ as the origin", caches: { "Sources/tephra/docs/Private/Origin.md": cacheOf("Core") }, settings: { excludedFolders: ["Sources/tephra/docs/Private"] }, expected: [] },
		{ name: "excludedFolders entry for a whole source", caches: { "Sources/other/docs/Same.md": cacheOf("Deeper") }, settings: { excludedFolders: ["Sources/tephra"] }, expected: [] },
		{ name: "excludedFolders entry that only shares a prefix with the folder does not exclude it", caches: { "Home.md": cacheOf("Secret") }, settings: { excludedFolders: ["Sources/tephra/docs/Priv"] }, expected: [SECRET] },
		{ name: "vault origin in an Atlas-excluded folder", caches: { "Notes/Idea.md": cacheOf("Deeper") }, settings: { excludedFolders: ["Notes"] }, expected: [] },
	];

	for (const row of rows) {
		it(row.name, () => {
			const { index } = makeG12(row.caches, row.settings);
			const got = index.getUnits().filter((u) => u.path.startsWith("Sources/") && u.type.startsWith("promoted")).map((u) => `${u.type}:${u.path}`).sort();
			expect(got).toEqual(row.expected);
		});
	}

	it("source -> vault: the vault section is the vault-side rules' alone (R3-1)", () => {
		const { index } = makeG12({ "Sources/tephra/crates/Core.md": cacheOf("Idea") });
		expect(vaultPromoted(index)).toEqual([]);
		expect(index.getUnits().filter((u) => u.path.startsWith("Sources/") && u.type.startsWith("promoted"))).toEqual([]);
	});

	it("promoted source units never reach the vault section (F1)", () => {
		const { index } = makeG12({ "Home.md": cacheOf("Deeper") });
		expect(vaultPromoted(index)).toEqual([]);
		expect(index.getUnits().some((u) => u.type === "folder-unit" && u.path === "Sources")).toBe(false);
	});

	it("noAutoPromoteFolders applies to a path under Sources/<name>/ as to a vault path", () => {
		const { index } = makeG12({ "Home.md": cacheOf("Deeper") }, { autoPromotion: true, noAutoPromoteFolders: ["Sources/tephra/docs"] });
		const unit = index.getUnits().find((u) => u.path === "Sources/tephra/docs/deep/Deeper.md")!;
		expect(unit.type).toBe("promoted-file"); // computed, as for a vault path
		expect(index.isSuppressedFromInbox(unit)).toBe(true); // but kept out of the Inbox
	});

	it("a manual promotion of a source file is unchanged by a link", () => {
		const app = new App();
		seedRoot(app, G12_FILES, G12_FOLDERS);
		stubLinks(app, { "Home.md": cacheOf("Deeper") }, G12_RESOLVE);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, tephraEnabled: true }, [{ kind: "file", path: "Sources/tephra/docs/Guide.md" }]);
		index.rebuild();
		expect(index.getManualPromotions()).toEqual([{ kind: "file", path: "Sources/tephra/docs/Guide.md" }]);
		expect(index.getUnits().filter((u) => u.type.startsWith("promoted")).map((u) => u.path)).toEqual(["Sources/tephra/docs/deep/Deeper.md"]); // R3-1: a manual one under Sources/ is kept, not listed
	});
});

describe("UnitIndex: toggle off (G12)", () => {
	it("a link into Sources/ is an ordinary vault link, exactly as before PR-8, and Tephra edges are ignored", () => {
		const { index } = makeG12({ "Home.md": cacheOf("Deeper") }, { tephraEnabled: false });
		index.setTephraEdges([{ from: "@demo:x.rs", to: "@notes:Notes/Idea.md", toRaw: "", subpath: "", line: 1, kind: "wikilink", offline: false }]);
		expect(index.getUnits().filter((u) => u.type.startsWith("promoted")).map((u) => `${u.type}:${u.path}`)).toEqual(["promoted-file:Sources/tephra/docs/deep/Deeper.md"]);
	});
});
