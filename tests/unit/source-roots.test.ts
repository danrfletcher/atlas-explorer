import { describe, expect, it } from "vitest";
import { absolutePathOf, computeSourceRoots, owningRoot, promotedRootsOf } from "../../src/source-roots";
import type { TephraSource } from "../../src/tephra-client";

// PR-12 (G6): where each listed source sits in the vault's path space. A promoted source gets no link of its own;
// its vault path is its parent's vault path plus the folder's path under the parent's root.

const src = (name: string, path: string, status: TephraSource["status"] = "online"): TephraSource => ({ name, path, status });
const VAULT = "/Users/dan/Vault";

describe("computeSourceRoots", () => {
	it("a top-level source's vault path is its `Sources/<name>` link, with no parent", () => {
		const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("whoop", "/docs/Whoop")], VAULT);
		expect(roots).toEqual([
			{ name: "tephra", absRoot: "/dev/Tephra", vaultPath: "Sources/tephra", parent: null, status: "online" },
			{ name: "whoop", absRoot: "/docs/Whoop", vaultPath: "Sources/whoop", parent: null, status: "online" },
		]);
		expect(promotedRootsOf(roots)).toEqual([]);
	});

	it("a source rooted inside another source is promoted: no link, the parent's path plus the relative folder", () => {
		const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("tephrad", "/dev/Tephra/crates/tephrad")], VAULT);
		const tephrad = roots.find((r) => r.name === "tephrad")!;
		expect(tephrad).toMatchObject({ vaultPath: "Sources/tephra/crates/tephrad", parent: "tephra", absRoot: "/dev/Tephra/crates/tephrad" });
		expect(promotedRootsOf(roots)).toEqual([{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad", absRoot: "/dev/Tephra/crates/tephrad" }]);
	});

	it("a source rooted inside the vault is promoted out of the vault (`notes`), at its own vault path", () => {
		const roots = computeSourceRoots([src("atlas", `${VAULT}/Projects/Atlas`)], VAULT);
		expect(roots).toEqual([{ name: "atlas", absRoot: `${VAULT}/Projects/Atlas`, vaultPath: "Projects/Atlas", parent: "notes", status: "online" }]);
	});

	it("a promoted source inside a promoted source: its parent is the longest root that holds it", () => {
		const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("tephrad", "/dev/Tephra/crates/tephrad"), src("core", "/dev/Tephra/crates/tephrad/src/core")], VAULT);
		expect(roots.find((r) => r.name === "core")).toMatchObject({ parent: "tephrad", vaultPath: "Sources/tephra/crates/tephrad/src/core" });
	});

	it("a list given deepest-first gives the same answer", () => {
		const list = [src("core", "/dev/Tephra/crates/tephrad/src/core"), src("tephrad", "/dev/Tephra/crates/tephrad"), src("tephra", "/dev/Tephra")];
		expect(computeSourceRoots(list, VAULT)).toEqual(computeSourceRoots([...list].reverse(), VAULT));
	});

	it("a folder whose name only shares a prefix is not inside the other (`tephrad2` vs `tephrad`)", () => {
		const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("a", "/dev/Tephra/crates/tephrad"), src("b", "/dev/Tephra/crates/tephrad2")], VAULT);
		expect(roots.find((r) => r.name === "b")?.parent).toBe("tephra");
	});

	it("without the vault's path, a vault folder can't be recognised (it stays a top-level source); a source nested in a listed source still is promoted", () => {
		const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("tephrad", "/dev/Tephra/crates/tephrad"), src("atlas", `${VAULT}/Projects/Atlas`)], null);
		expect(roots.find((r) => r.name === "tephrad")?.parent).toBe("tephra");
		expect(roots.find((r) => r.name === "atlas")?.parent).toBeNull();
	});

	it("an unusable name and a second name on one root are left out; the first name keeps the root", () => {
		const roots = computeSourceRoots([src("a", "/dev/X"), src("b", "/dev/X"), src("bad/name", "/dev/Y")], VAULT);
		expect(roots.map((r) => r.name)).toEqual(["a"]);
	});

	it("carries the status through, so an offline promoted source stays listed", () => {
		const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("tephrad", "/dev/Tephra/crates/tephrad", "offline")], VAULT);
		expect(roots.find((r) => r.name === "tephrad")?.status).toBe("offline");
	});
});

describe("owningRoot / absolutePathOf: the longest root wins, whole segments", () => {
	const roots = computeSourceRoots([src("tephra", "/dev/Tephra"), src("tephrad", "/dev/Tephra/crates/tephrad"), src("atlas", `${VAULT}/Projects/Atlas`)], VAULT);

	it.each([
		["Sources/tephra/Cargo.toml", "tephra"],
		["Sources/tephra/crates/tephrad/src/registry.rs", "tephrad"],
		["Sources/tephra/crates/tephrad", "tephrad"],
		["Sources/tephra/crates/tephrad2/x.rs", "tephra"],
		["Projects/Atlas/Plan.md", "atlas"],
		["Projects/Atlas2/x.md", null],
		["Weekly.md", null],
	])("%s is in %s", (path, name) => {
		expect(owningRoot(path, roots)?.name ?? null).toBe(name);
	});

	it("maps a vault path back to the disk path Tephra's `root` wants", () => {
		expect(absolutePathOf("Sources/tephra/crates/tephrad/src", roots)).toBe("/dev/Tephra/crates/tephrad/src");
		expect(absolutePathOf("Sources/tephra/crates/tephrad", roots)).toBe("/dev/Tephra/crates/tephrad");
		expect(absolutePathOf("Sources/tephra/docs", roots)).toBe("/dev/Tephra/docs");
		expect(absolutePathOf("Projects/Atlas/deep", roots)).toBe(`${VAULT}/Projects/Atlas/deep`);
		expect(absolutePathOf("Weekly", roots)).toBeNull(); // the vault proper: the caller adds the vault's own path
	});
});
