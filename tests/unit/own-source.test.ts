import { describe, expect, it } from "vitest";
import { SourceFileIndex, isUnderSourcesFolder, locateInSource, ownSourceOf, resolvePlainLinkInOwnSource, resolveSourceLink, setPromotedRoots, vaultRootOfSource } from "../../src/source-links";

describe("ownSourceOf: the `Sources/<name>/` prefix, else notes (no promoted roots)", () => {
	const table: Array<[string, string]> = [
		["Sources/whoop/Workout Plan.md", "whoop"],
		["Sources/tephra/README.md", "tephra"],
		["Sources/tephra/crates/tephrad/src/registry.rs", "tephra"],
		["Sources/whoop/Sources/x.md", "whoop"], // the longest (= outermost real) prefix: not the inner "Sources"
		["Sources/whoop/Sources/inner/x.md", "whoop"],
		["Sources/v1.2/a.md", "v1.2"],
		["Sources/Whoop/a.md", "Whoop"], // the name keeps the case it has in the path
		// everything else is the vault:
		["Weekly Review.md", "notes"],
		["Leg Day.md", "notes"],
		["Notes/Deep/x.md", "notes"],
		["", "notes"],
		["Sources.md", "notes"], // `Sources` as a file name
		["Sources", "notes"], // `Sources` as a bare file or folder entry
		["Sources/", "notes"], // the bare folder
		["Sources/readme.md", "notes"], // a file directly under Sources/ is in no source
		["Sources//x.md", "notes"],
		["Sources/my notes/x.md", "notes"], // not a valid source name
		["sources/whoop/x.md", "notes"], // case variants of the folder itself are not `Sources/`
		["SOURCES/whoop/x.md", "notes"],
		["Notes/Sources/whoop/x.md", "notes"], // only a vault-root Sources/ counts
		["SourcesX/whoop/x.md", "notes"],
		["Sources-old/whoop/x.md", "notes"],
	];
	it.each(table)("%j -> %s", (path, expected) => {
		expect(ownSourceOf(path)).toBe(expected);
	});
});

describe("isUnderSourcesFolder", () => {
	it.each([
		["Sources", true],
		["Sources/", true],
		["Sources/whoop/a.md", true],
		["Sources/readme.md", true],
		["Sources/my notes/x.md", true], // under Sources/ even though not a valid source name
		["Sources.md", false],
		["Notes/Sources/a.md", false],
		["sources/a.md", false],
		["", false],
	])("%j -> %s", (path, expected) => {
		expect(isUnderSourcesFolder(path)).toBe(expected);
	});
});

// PR-12 (G6): own source = the longest matching root. A promoted folder is a root of its own, so a path inside it
// is in the promoted source, not in the `Sources/<name>` or the vault it lies in.
describe("ownSourceOf with promoted roots (PR-12): the longest matching root wins", () => {
	const tephrad = { name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad" };
	const nested = { name: "src-core", vaultPath: "Sources/tephra/crates/tephrad/src/core" }; // a promoted folder inside a promoted folder
	const atlas = { name: "atlas", vaultPath: "Projects/Atlas" }; // a vault folder promoted
	const roots = [tephrad, nested, atlas];

	const table: Array<[string, string, string]> = [
		// [path, own source, path inside that source]
		["Sources/tephra/Cargo.toml", "tephra", "Cargo.toml"], // top-level source, outside any promoted root
		["Sources/tephra/crates/tephractl/main.rs", "tephra", "crates/tephractl/main.rs"],
		["Sources/tephra/crates/tephrad/src/registry.rs", "tephrad", "src/registry.rs"], // a promoted folder
		["Sources/tephra/crates/tephrad/src/scan.rs", "tephrad", "src/scan.rs"],
		["Sources/tephra/crates/tephrad/src/core/mod.rs", "src-core", "mod.rs"], // a promoted folder inside a promoted folder
		["Sources/tephra/crates/tephrad/src/core", "src-core", ""], // the root folder itself
		["Sources/tephra/crates/tephrad", "tephrad", ""],
		["Projects/Atlas/Plan.md", "atlas", "Plan.md"], // a vault folder promoted
		["Projects/Atlas/deep/er/x.md", "atlas", "deep/er/x.md"],
		["Projects/Other/Plan.md", "notes", "Projects/Other/Plan.md"], // paths outside `Sources/` and outside a root are the vault's
		["Weekly Review.md", "notes", "Weekly Review.md"],
		["Sources/tephra/crates/tephrad2/src/x.rs", "tephra", "crates/tephrad2/src/x.rs"], // the prefix trap: `tephrad2` is not inside `tephrad`
		["Sources/tephra/crates/tephrad-old/x.rs", "tephra", "crates/tephrad-old/x.rs"],
		["Projects/Atlas2/x.md", "notes", "Projects/Atlas2/x.md"],
		["Projects/AtlasNotes.md", "notes", "Projects/AtlasNotes.md"],
		["Sources/whoop/a.md", "whoop", "a.md"],
	];
	it.each(table)("%j -> %s (%j inside it)", (path, expected, rel) => {
		expect(ownSourceOf(path, roots)).toBe(expected);
		expect(locateInSource(path, roots)).toEqual({ source: expected, rel });
	});

	it("with no promoted roots the answer is the plain `Sources/<name>` rule", () => {
		expect(ownSourceOf("Sources/tephra/crates/tephrad/src/registry.rs", [])).toBe("tephra");
		expect(ownSourceOf("Projects/Atlas/Plan.md", [])).toBe("notes");
	});

	it("reads the roots the plugin last set when none are passed", () => {
		setPromotedRoots(roots);
		try {
			expect(ownSourceOf("Sources/tephra/crates/tephrad/src/registry.rs")).toBe("tephrad");
			expect(vaultRootOfSource("tephrad")).toBe("Sources/tephra/crates/tephrad");
			expect(vaultRootOfSource("whoop")).toBe("Sources/whoop"); // a top-level source keeps its link
		} finally {
			setPromotedRoots([]);
		}
		expect(ownSourceOf("Sources/tephra/crates/tephrad/src/registry.rs")).toBe("tephra");
	});
});

describe("SourceFileIndex with promoted roots (PR-12)", () => {
	const files = ["Sources/tephra/crates/tephrad/src/registry.rs", "Sources/tephra/crates/tephrad/src/scan.rs", "Sources/tephra/crates/tephractl/src/main.rs", "Projects/Atlas/Plan.md", "Notes.md"].map((path) => ({ path }));
	const roots = [
		{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad" },
		{ name: "atlas", vaultPath: "Projects/Atlas" },
	];

	it("a plain link resolves in its own source first: `tephrad`'s registry.rs from tephrad's scan.rs", () => {
		const index = new SourceFileIndex(() => files, () => roots);
		const hit = resolvePlainLinkInOwnSource(index, "registry.rs", "Sources/tephra/crates/tephrad/src/scan.rs");
		expect(hit?.path).toBe("Sources/tephra/crates/tephrad/src/registry.rs");
		// from `tephra` proper (outside the promoted folder) the same plain name is not in its own source any more
		expect(resolvePlainLinkInOwnSource(index, "registry.rs", "Sources/tephra/crates/tephractl/src/main.rs")).toBeNull();
	});

	it("@tephrad:src/registry.rs resolves to the file at its real path, and the old @tephra: path no longer does", () => {
		const index = new SourceFileIndex(() => files, () => roots);
		const hit = resolveSourceLink(index, "@tephrad:src/registry.rs");
		expect(hit.kind === "resolved" && hit.file.path).toBe("Sources/tephra/crates/tephrad/src/registry.rs");
		expect(resolveSourceLink(index, "@tephra:crates/tephrad/src/registry.rs").kind).toBe("unresolved");
		expect(resolveSourceLink(index, "@tephra:crates/tephractl/src/main.rs").kind).toBe("resolved");
		const vaultFolder = resolveSourceLink(index, "@atlas:Plan.md");
		expect(vaultFolder.kind === "resolved" && vaultFolder.file.path).toBe("Projects/Atlas/Plan.md");
	});

	it("a vault file outside the promoted folder stays in the vault", () => {
		const index = new SourceFileIndex(() => files, () => roots);
		expect(resolvePlainLinkInOwnSource(index, "Notes", "Notes.md")?.path).toBe("Notes.md");
	});
});
