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

	it("a vault note's link into the source promotes nothing (PR-8 seam), and the vault's own units are untouched", () => {
		const { index } = make({ "Home.md": cacheOf("Deeper") }, { Deeper: "Sources/tephra/docs/deep/Deeper.md" });
		expect(sourceUnits(index)).toEqual([]);
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
