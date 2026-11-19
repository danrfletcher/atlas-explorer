import { describe, expect, it } from "vitest";
import { canMakeOwnSource, canReturnToParent, gapTakesDrag, parentSourceOf, promoteMenuState, promoteRootPath, type PromoteRow } from "../../src/promote-offer";
import { computeSourceRoots } from "../../src/source-roots";

// PR-12 (G6, E10): where "Make its own source" and "Return to parent" are offered, and their words.

const roots = computeSourceRoots(
	[
		{ name: "tephra", path: "/dev/Tephra", status: "online" },
		{ name: "tephrad", path: "/dev/Tephra/crates/tephrad", status: "online" },
		{ name: "atlas", path: "/Users/dan/Vault/Projects/Atlas", status: "online" },
	],
	"/Users/dan/Vault"
);
const ctx = { roots, isExcluded: (p: string) => p === "_pool" || p.startsWith("_pool/") };
const row = (over: Partial<PromoteRow>): PromoteRow => ({ kind: "folder", path: "Sources/tephra/docs", surface: "inbox", ...over });

describe("canMakeOwnSource", () => {
	it.each<[string, Partial<PromoteRow>, boolean]>([
		["a folder in a source's Inbox section", {}, true],
		["a folder in Module Contents", { surface: "module-contents" }, true],
		["a folder of the vault proper", { path: "Projects/Notes" }, true],
		["a folder inside a promoted source", { path: "Sources/tephra/crates/tephrad/src" }, true],
		["a file", { kind: "file" }, false],
		["a free block", { kind: "free-block" }, false],
		["a block", { kind: "block" }, false],
		["a data-source row (API / Folder / Table / CSV)", { kind: "data-source" }, false],
		["a View (bucket) row", { surface: "view" }, false],
		["a source's section header", { kind: "section-header" }, false],
		["a top-level source's own folder", { path: "Sources/tephra" }, false],
		["a promoted source's own folder (already a source)", { path: "Sources/tephra/crates/tephrad" }, false],
		["a promoted vault folder (already a source)", { path: "Projects/Atlas" }, false],
		["the `Sources` folder", { path: "Sources" }, false],
		["the pool folder", { path: "_pool" }, false],
		["a folder inside the pool", { path: "_pool/x" }, false],
		["a `Sources/x` folder no listed source owns", { path: "Sources/ghost/dir" }, false],
		["an empty path", { path: "" }, false],
	])("%s: %s", (_label, over, expected) => {
		expect(canMakeOwnSource(row(over), ctx)).toBe(expected);
	});
});

describe("parentSourceOf / promoteRootPath", () => {
	it("a folder's parent is its owning source, or the vault", () => {
		expect(parentSourceOf("Sources/tephra/docs", roots)).toBe("tephra");
		expect(parentSourceOf("Sources/tephra/crates/tephrad/src", roots)).toBe("tephrad");
		expect(parentSourceOf("Projects/Notes", roots)).toBe("notes");
	});
	it("the root sent to Tephra is the folder's absolute path on disk", () => {
		expect(promoteRootPath("Sources/tephra/docs", roots, "/Users/dan/Vault")).toBe("/dev/Tephra/docs");
		expect(promoteRootPath("Sources/tephra/crates/tephrad/src", roots, "/Users/dan/Vault")).toBe("/dev/Tephra/crates/tephrad/src");
		expect(promoteRootPath("Projects/Notes", roots, "/Users/dan/Vault")).toBe("/Users/dan/Vault/Projects/Notes");
		expect(promoteRootPath("Projects/Notes", roots, "/Users/dan/Vault/")).toBe("/Users/dan/Vault/Projects/Notes");
	});
	it("no root when the vault's path is unknown, or the folder is in a `Sources/` no source owns", () => {
		expect(promoteRootPath("Projects/Notes", roots, null)).toBeNull();
		expect(promoteRootPath("Projects/Notes", roots, "")).toBeNull();
		expect(promoteRootPath("Sources/ghost/dir", roots, "/Users/dan/Vault")).toBeNull();
	});
});

describe("canReturnToParent", () => {
	it("only a promoted source's header offers it", () => {
		expect(canReturnToParent("tephrad", roots)).toBe(true);
		expect(canReturnToParent("atlas", roots)).toBe(true);
		expect(canReturnToParent("tephra", roots)).toBe(false); // top-level
		expect(canReturnToParent("notes", roots)).toBe(false); // the vault
		expect(canReturnToParent(null, roots)).toBe(false); // the vault's Inbox header
		expect(canReturnToParent("nope", roots)).toBe(false);
	});
});

describe("promoteMenuState: offline greys the item out, never queues", () => {
	it("offered + online -> enabled; offered + offline -> disabled; not offered -> neither", () => {
		expect(promoteMenuState(true, true)).toEqual({ offered: true, disabled: false });
		expect(promoteMenuState(true, false)).toEqual({ offered: true, disabled: true });
		expect(promoteMenuState(false, false)).toEqual({ offered: false, disabled: false });
	});
});

describe("gapTakesDrag: the strip between sections", () => {
	const folder = row({});
	it("one promotable folder, Tephra online: takes it", () => {
		expect(gapTakesDrag({ rows: [folder] }, ctx, true)).toBe(folder);
	});
	it.each<[string, PromoteRow[], boolean]>([
		["Tephra offline", [row({})], false],
		["a file", [row({ kind: "file" })], true],
		["a header", [row({ kind: "section-header" })], true],
		["a multi-item drag", [row({}), row({ path: "Sources/tephra/other" })], true],
		["an empty drag", [], true],
		["a source's own folder", [row({ path: "Sources/tephra" })], true],
	])("%s: not taken", (_label, rows, online) => {
		expect(gapTakesDrag({ rows }, ctx, online)).toBeNull();
	});
	it("no drag in progress: not taken", () => {
		expect(gapTakesDrag(null, ctx, true)).toBeNull();
	});
});
