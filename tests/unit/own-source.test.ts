import { describe, expect, it } from "vitest";
import { isUnderSourcesFolder, ownSourceOf } from "../../src/source-links";

describe("ownSourceOf: the `Sources/<name>/` prefix, else notes", () => {
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
