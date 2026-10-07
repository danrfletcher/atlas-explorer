import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { seedRoot } from "../helpers";
import type { AddedItem, UnitRef } from "../../src/types";

/** Wires `getFileCache`/`getFirstLinkpathDest` so `computePromotions()`'s link-scanning loop sees
 * exactly the caches and resolved destinations given here, independent of path-resolution rules. */
function stubLinks(
	app: App,
	caches: Record<string, CachedMetadata>,
	resolve: Record<string, string>, // linkpath -> resolved destPath
): void {
	app.metadataCache.getFileCache = ((file: TFile) => caches[file.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const destPath = resolve[linkpath];
		return destPath ? (app.vault.getAbstractFileByPath(destPath) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
}

function makeIndex(
	files: string[],
	folders: string[],
	caches: Record<string, CachedMetadata>,
	resolve: Record<string, string>,
	manualPromotions: UnitRef[] = [],
	settingsOverride: Partial<AtlasSettings> = {},
	addedItems: AddedItem[] = [],
): { app: App; index: UnitIndex } {
	const app = new App();
	seedRoot(app, files, folders);
	stubLinks(app, caches, resolve);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, ...settingsOverride }, manualPromotions, {}, [], addedItems);
	index.rebuild();
	return { app, index };
}

const promotedBlockPaths = (index: UnitIndex) =>
	index
		.getUnits()
		.filter((u) => u.type === "promoted-block")
		.map((u) => `${u.path}#${(u as { subpath: string }).subpath}`)
		.sort();

const promotedFilePaths = (index: UnitIndex) =>
	index
		.getUnits()
		.filter((u) => u.type === "promoted-file")
		.map((u) => u.path)
		.sort();

const promotedFolderPaths = (index: UnitIndex) =>
	index
		.getUnits()
		.filter((u) => u.type === "promoted-folder")
		.map((u) => u.path)
		.sort();

describe("UnitIndex.computePromotions — block/heading references (bug 1, E5/E5a)", () => {
	it("E5: a block reference from inside the same top-level module does not promote the block", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Other#^abc123", original: "[[Other#^abc123]]" } as never],
				},
			},
			{ Other: "ModuleA/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual([]);
	});

	it("E5a: a block reference from a different top-level module still promotes the block", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Other#^abc123", original: "[[Other#^abc123]]" } as never],
				},
			},
			{ Other: "ModuleB/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual(["ModuleB/Other.md#^abc123"]);
	});
});

describe("UnitIndex.getUnits() — added-file survives a later block reference to the same file (R1)", () => {
	it("a file added via \"+\" keeps its added-file row when another note later links a block/heading inside it — dedup is by file-kind ref, not bare path", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "Areas/Added.md"],
			["ModuleA", "Areas"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Added#^abc123", original: "[[Added#^abc123]]" } as never],
				},
			},
			{ Added: "Areas/Added.md" },
			[],
			{},
			[{ ref: { kind: "file", path: "Areas/Added.md" }, tag: "added" }],
		);
		// The block reference promotes a block unit (same path, kind "block") — it must not shadow
		// the file's own added-file row, which would otherwise disappear (R1) and, if the file were
		// also placed in a view, render greyed as "(missing)" there.
		const units = index.getUnits().filter((u) => u.path === "Areas/Added.md");
		expect(units.map((u) => u.type).sort()).toEqual(["added-file", "promoted-block"]);
	});
});

// R1/R2: "bug 2" was reported as a plain markdown link ([custom content type parsers]
// (./ContentTypeParser.md)) wrongly promoting its same-module target. Live CDP instrumentation
// against a real Obsidian 1.13.7 instance (vault: alnwick-3-vault, plugin: atlas-explorer) against
// the actual repro pair in agy-proxy/node_modules/fastify/docs/Reference/ confirmed:
//  - the real `cache.links` entry for that link is
//    { link: "./ContentTypeParser.md", original: "[custom content type parsers](./ContentTypeParser.md)",
//      displayText: "custom content type parsers" } — note the preserved "./" prefix on `link`,
//    which the previous E6/E6a mocks (bare "Other.md") didn't reflect.
//  - `getFirstLinkpathDest("./ContentTypeParser.md", sourcePath)` resolves correctly to
//    agy-proxy/.../ContentTypeParser.md; there is no resolution bug.
//  - with both the pre-bug-1-fix and post-bug-1-fix code, this exact link NEVER promoted
//    ContentTypeParser.md into `promotedFiles` — the plain-file branch's module check was always
//    correctly positioned ahead of the file-promotion logic, before this PR started.
//  - what DID reproduce, pre-fix only, was a *block* promotion: Server.md (same module) links
//    `[here](./ContentTypeParser.md#usage)` — a plain markdown link with a heading anchor, which
//    takes the subpath/block branch, not the plain-file branch. That's bug 1 (the subpath branch's
//    missing module check) manifesting through markdown-link-with-anchor syntax rather than the
//    `[[Note#^id]]` wikilink syntax E5 already covered — not an independent "bug 2" code path.
//    Bug 1's fix (reordering the module check ahead of the subpath branch) already suppresses it;
//    confirmed live by swapping the built plugin back to the post-fix commit and observing
//    `promotedBlocks` for ContentTypeParser.md drop from 1 entry (`#usage`) to 0.
// So GP2/E6's acceptance criterion (same-module plain link doesn't promote the file) was already
// met going into this PR; the tests below use the real `./`-prefixed link shape for both the
// plain-file case and the heading-anchor case that was the actual pre-fix regression.
describe("UnitIndex.computePromotions — plain markdown links (bug 2, E6/E6a)", () => {
	it("E6: a plain markdown link (real cache.links shape, './'-prefixed) from inside the same top-level module does not promote the file", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md", original: "[text](./Other.md)", displayText: "text" } as never],
				},
			},
			{ "./Other.md": "ModuleA/Other.md" },
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("E6a: a plain markdown link (real cache.links shape) from a different top-level module still promotes the file", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md", original: "[text](./Other.md)", displayText: "text" } as never],
				},
			},
			{ "./Other.md": "ModuleB/Other.md" },
		);
		expect(promotedFilePaths(index)).toEqual(["ModuleB/Other.md"]);
	});

	it("E6b: a same-module plain markdown link with a heading anchor (the real pre-fix regression, via Server.md's [here](./ContentTypeParser.md#usage)) does not promote the block", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md#usage", original: "[here](./Other.md#usage)", displayText: "here" } as never],
				},
			},
			{ "./Other.md": "ModuleA/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual([]);
	});

	it("a cross-module plain markdown link with a heading anchor still promotes the block (regression)", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md#usage", original: "[here](./Other.md#usage)", displayText: "here" } as never],
				},
			},
			{ "./Other.md": "ModuleB/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual(["ModuleB/Other.md#usage"]);
	});
});

describe("UnitIndex.computePromotions — fence regressions", () => {
	it("F5: topLevelFolderFor/isExcluded behavior (as observed via promotion results) is unchanged — cross-module file link still promotes, root-level link never promotes", () => {
		const { index } = makeIndex(
			["Root.md", "ModuleA/Source.md", "ModuleB/Target.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Target", original: "[[Target]]" } as never],
				},
				"Root.md": {
					links: [{ link: "Target", original: "[[Target]]" } as never],
				},
			},
			{ Target: "ModuleB/Target.md" },
		);
		// Root.md is at vault root (topLevelFolderFor -> null for the source), so its own module
		// status doesn't matter; what F5 checks is that the target's module is still correctly
		// derived and distinct from "no module" / "root" cases.
		expect(promotedFilePaths(index)).toEqual(["ModuleB/Target.md"]);
	});

	it("F5 (R4): a reference from an excluded source folder never promotes, even though the target is cross-module", () => {
		const { index } = makeIndex(
			["_to_delete/Ghost.md", "ModuleB/Target.md"],
			["_to_delete", "ModuleB"],
			{
				"_to_delete/Ghost.md": {
					links: [{ link: "Target", original: "[[Target]]" } as never],
				},
			},
			{ Target: "ModuleB/Target.md" },
			[],
			{ excludedFolders: ["_to_delete"] },
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("F5 (R4): a reference to a target inside an excluded folder never promotes", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "_to_delete/Ghost.md"],
			["ModuleA", "_to_delete"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Ghost", original: "[[Ghost]]" } as never],
				},
			},
			{ Ghost: "_to_delete/Ghost.md" },
			[],
			{ excludedFolders: ["_to_delete"] },
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("F5 (R4): a plain (subpath-less) reference to a pool free block never promotes the file — a free block has no module to record", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "_pool/Abc.md"],
			["ModuleA", "_pool"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Abc", original: "[[Abc]]" } as never],
				},
			},
			{ Abc: "_pool/Abc.md" },
			[],
			{ excludedFolders: ["_pool"] }, // mirrors computeDefaultExcludedFolders(), which always excludes the pool folder itself
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("F5 (R4): a plain (subpath-less) reference to a vault-root file never promotes the file — a vault-root file has no module to record", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "Root.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Root", original: "[[Root]]" } as never],
				},
			},
			{ Root: "Root.md" },
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("interface-note promotion is unaffected by either fix — still only reached via the subpath-less branch, after the module check", () => {
		// The linked interface note (`Sub/Sub.md`) is nested inside ModuleA, distinct from ModuleA
		// itself, so promoting it (as a folder) is observable — unlike linking a module's own
		// top-level interface note, which is already a base folder-unit and promotes nothing.
		const { index } = makeIndex(
			["ModuleB/Source.md", "ModuleA/Sub/Sub.md"],
			["ModuleA", "ModuleB", "ModuleA/Sub"],
			{
				"ModuleB/Source.md": {
					links: [{ link: "Sub", original: "[[Sub]]" } as never],
				},
			},
			{ Sub: "ModuleA/Sub/Sub.md" },
		);
		expect(promotedFolderPaths(index)).toEqual(["ModuleA/Sub"]);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("manual promotions are unaffected by module — they bypass the link-scanning loop entirely", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{},
			{},
			[{ kind: "file", path: "ModuleA/Other.md" }],
		);
		expect(promotedFilePaths(index)).toEqual(["ModuleA/Other.md"]);
	});
});

// R3/R5: bug 1's original fix moved the *entire* `targetTop === null || targetTop === sourceTop`
// check ahead of the subpath branch, which (as an unflagged side effect) also stopped block/heading
// references from promoting when their target has no module of its own — vault-root files and pool
// free blocks, since topLevelFolderFor() returns null for both. Before that fix, the subpath branch
// ran first and promoted any resolved block reference unconditionally, so those cases did promote.
// Per the review, this PR narrows the fix instead of changing that behaviour: only the
// `targetTop === sourceTop` same-module comparison was moved ahead of the subpath branch; the
// `targetTop === null` guard stays exactly where it was, applying only to the plain-file/folder
// branch (where it's meaningful — a promoted file/folder records its module). A block reference to
// a target with no module is therefore still "from outside" the source's real module and promotes,
// same as pre-fix.
//
// R5 fixed a second unflagged side effect of that same comparison: when source and target *both*
// have no module (two vault-root files, two pool free blocks, or one of each), `null === null`
// compared equal and the reference was treated as "the same non-module", so it stopped promoting —
// a behaviour change this PR never asked for. Having no module is not the same as sharing one, so
// the check is now `targetTop !== null && targetTop === sourceTop`: a null targetTop never matches,
// and every module-less pairing promotes exactly as it did before this PR.
describe("UnitIndex.computePromotions — block references to module-less targets (R3)", () => {
	it("a block reference from inside a module to a pool free block still promotes the block (restored pre-fix behaviour)", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "_pool/Abc.md"],
			["ModuleA", "_pool"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Abc#^xyz", original: "[[Abc#^xyz]]" } as never],
				},
			},
			{ Abc: "_pool/Abc.md" },
			[],
			{ excludedFolders: ["_pool"] },
		);
		expect(promotedBlockPaths(index)).toEqual(["_pool/Abc.md#^xyz"]);
	});

	it("a block reference from inside a module to a vault-root file still promotes the block (restored pre-fix behaviour)", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "Root.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Root#^xyz", original: "[[Root#^xyz]]" } as never],
				},
			},
			{ Root: "Root.md" },
		);
		expect(promotedBlockPaths(index)).toEqual(["Root.md#^xyz"]);
	});

	it("a block reference between two module-less files (vault-root source, vault-root target) still promotes (restored pre-fix behaviour)", () => {
		const { index } = makeIndex(
			["Root.md", "Root2.md"],
			[],
			{
				"Root.md": {
					links: [{ link: "Root2#^xyz", original: "[[Root2#^xyz]]" } as never],
				},
			},
			{ Root2: "Root2.md" },
		);
		expect(promotedBlockPaths(index)).toEqual(["Root2.md#^xyz"]);
	});

	it("a block reference between two pool free blocks still promotes (restored pre-fix behaviour)", () => {
		const { index } = makeIndex(
			["_pool/Abc.md", "_pool/Def.md"],
			["_pool"],
			{
				"_pool/Abc.md": {
					links: [{ link: "Def#^xyz", original: "[[Def#^xyz]]" } as never],
				},
			},
			{ Def: "_pool/Def.md" },
			[],
			{ excludedFolders: ["_pool"] },
		);
		expect(promotedBlockPaths(index)).toEqual(["_pool/Def.md#^xyz"]);
	});
});

describe("UnitIndex dismiss state vs. re-promotion — dismiss always wins (G10)", () => {
	it("dismiss state survives a live link-cache recompute that newly promotes the dismissed ref (its outside-module link count going from zero to nonzero), and the plain inbox keeps excluding it", () => {
		const caches: Record<string, CachedMetadata> = {};
		const resolve: Record<string, string> = {};
		const { app, index } = makeIndex(["ModuleA/Source.md", "ModuleB/Target.md"], ["ModuleA", "ModuleB"], caches, resolve);

		// Nothing links to Target.md yet, so it has zero outside-module links and isn't promoted.
		expect(promotedFilePaths(index)).toEqual([]);

		const targetRef: UnitRef = { kind: "file", path: "ModuleB/Target.md" };
		index.setDismissed(targetRef, "global", true);
		expect(index.isDismissed(targetRef, "global")).toBe(true);

		// A cross-module link now appears (e.g. the user edited Source.md) — Target.md's
		// outside-module link count goes from zero to nonzero, which would promote it.
		caches["ModuleA/Source.md"] = { links: [{ link: "Target", original: "[[Target]]" } as never] };
		resolve["Target"] = "ModuleB/Target.md";
		index.onMetadataResolved();

		expect(promotedFilePaths(index)).toEqual(["ModuleB/Target.md"]);
		expect(index.isDismissed(targetRef, "global")).toBe(true);

		const views = new ViewsManager(app, [], "v1", () => {});
		expect(views.getInboxUnits(index.getUnits(), "v1", "global", index).map((u) => u.path)).not.toContain("ModuleB/Target.md");
		expect(views.getDismissedInboxUnits(index.getUnits(), "v1", "global", index).map((u) => u.path)).toContain("ModuleB/Target.md");
	});
});

describe("UnitIndex.removeAdded — PR-1.F2 (G10) inbox Remove on a missing added row", () => {
	const fileRef = (path: string): UnitRef => ({ kind: "file", path });
	const folderRef = (path: string): UnitRef => ({ kind: "folder", path });

	function indexWith(addedItems: AddedItem[], dismissedGlobal: UnitRef[] = [], dismissedByView: Record<string, UnitRef[]> = {}): UnitIndex {
		return new UnitIndex(new App(), { ...DEFAULT_SETTINGS }, [], dismissedByView, dismissedGlobal, addedItems);
	}

	it("removes only the matching file ref", () => {
		const index = indexWith([
			{ ref: fileRef("a.md"), tag: "added" },
			{ ref: fileRef("b.md"), tag: "added" },
		]);
		index.removeAdded(fileRef("a.md"));
		expect(index.getAddedItems()).toEqual([{ ref: fileRef("b.md"), tag: "added" }]);
		expect(index.isAdded(fileRef("a.md"))).toBe(false);
	});

	it("removes only the matching folder ref, leaving a file ref with the same path alone", () => {
		const index = indexWith([
			{ ref: folderRef("Jobs/Acme"), tag: "added" },
			{ ref: fileRef("Jobs/Acme"), tag: "added" },
		]);
		index.removeAdded(folderRef("Jobs/Acme"));
		expect(index.getAddedItems()).toEqual([{ ref: fileRef("Jobs/Acme"), tag: "added" }]);
	});

	it("is a no-op for an unknown ref", () => {
		const items: AddedItem[] = [{ ref: fileRef("a.md"), tag: "added" }];
		const index = indexWith(items);
		index.removeAdded(fileRef("nope.md"));
		expect(index.getAddedItems()).toEqual([{ ref: fileRef("a.md"), tag: "added" }]);
	});

	it("leaves dismissals (global and per-view) intact", () => {
		const index = indexWith(
			[{ ref: fileRef("a.md"), tag: "added" }],
			[fileRef("g.md")],
			{ v1: [fileRef("v.md")] }
		);
		index.removeAdded(fileRef("a.md"));
		expect(index.getDismissedGlobal()).toEqual([fileRef("g.md")]);
		expect(index.getDismissedByView()).toEqual({ v1: [fileRef("v.md")] });
	});

	it("removes every duplicate entry for the same ref", () => {
		const index = indexWith([
			{ ref: fileRef("a.md"), tag: "added" },
			{ ref: fileRef("a.md"), tag: "added" },
		]);
		index.removeAdded(fileRef("a.md"));
		expect(index.getAddedItems()).toEqual([]);
	});
});
