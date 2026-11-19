import { describe, expect, it } from "vitest";
import { desiredEntriesForSource } from "../../src/source-excludes";
import {
	remapExcludeEntry,
	remapExcludeList,
	remapPathList,
	remapSourcePath,
	remapSourceStores,
	type SourceRenameStores,
} from "../../src/source-rename-remap";

/** PR-11 (G4, R3-4): the pure half of a source rename, store by store, at the segment boundary, and as a no-op. */

const stores = (over: Partial<SourceRenameStores> = {}): SourceRenameStores => ({
	noAutoPromoteFolders: [],
	expandedModuleFolders: [],
	sourceSettings: {},
	excludes: {},
	...over,
});

describe("remapSourcePath: whole path segments only", () => {
	it.each([
		["Sources/whoop", "Sources/gym"],
		["Sources/whoop/Workout Plan.md", "Sources/gym/Workout Plan.md"],
		["Sources/whoop/deep/er/Leg Day.md", "Sources/gym/deep/er/Leg Day.md"],
		["Sources/whoopee/Workout Plan.md", "Sources/whoopee/Workout Plan.md"], // a longer name that starts the same
		["Sources/whoopee", "Sources/whoopee"],
		["Sources-whoop.md", "Sources-whoop.md"], // a vault note
		["Sources-whoop/a.md", "Sources-whoop/a.md"],
		["Weekly Review.md", "Weekly Review.md"],
		["Sources/tephra/whoop/a.md", "Sources/tephra/whoop/a.md"], // another source with a folder of that name
		["notes/Sources/whoop/a.md", "notes/Sources/whoop/a.md"], // not the vault-root Sources folder
		["Sources/Whoop/a.md", "Sources/Whoop/a.md"], // path keys are exact; Obsidian's index is case-sensitive
	])("%s -> %s", (path, expected) => {
		expect(remapSourcePath(path, "whoop", "gym")).toBe(expected);
	});
});

describe("remapSourceStores: every store, one row each", () => {
	it("noAutoPromoteFolders: folder paths under the source move, others stay in place", () => {
		const out = remapSourceStores(stores({ noAutoPromoteFolders: ["Projects", "Sources/whoop/Plans", "Sources/whoopee/Plans", "Sources/whoop"] }), "whoop", "gym");
		expect(out.noAutoPromoteFolders).toEqual(["Projects", "Sources/gym/Plans", "Sources/whoopee/Plans", "Sources/gym"]);
		expect(out.changed).toBe(true);
	});

	it("expandedModuleFolders: the Module Contents expansion carries over", () => {
		const out = remapSourceStores(stores({ expandedModuleFolders: ["Sources/whoop/Plans/2024", "Mod/Inner", "Sources-whoop"] }), "whoop", "gym");
		expect(out.expandedModuleFolders).toEqual(["Sources/gym/Plans/2024", "Mod/Inner", "Sources-whoop"]);
	});

	it("tephraSourceSettings: 'Show in Obsidian search & graph' moves to the new name, other sources untouched", () => {
		const input = { whoop: { showInSearch: true }, tephra: { showInSearch: false } };
		const out = remapSourceStores(stores({ sourceSettings: input }), "whoop", "gym");
		expect(out.sourceSettings).toEqual({ tephra: { showInSearch: false }, gym: { showInSearch: true } });
		expect(out.sourceSettings).not.toHaveProperty("whoop");
		expect(input).toEqual({ whoop: { showInSearch: true }, tephra: { showInSearch: false } }); // never mutated
	});

	it("tephraSourceSettings: the old entry replaces a stale entry already under the new name", () => {
		const out = remapSourceStores(stores({ sourceSettings: { whoop: { showInSearch: true }, gym: { showInSearch: false } } }), "whoop", "gym");
		expect(out.sourceSettings).toEqual({ gym: { showInSearch: true } });
	});

	it("tephraExcludes: the entries move with the name and no Sources/<old>/ entry is left behind", () => {
		const out = remapSourceStores(
			stores({ excludes: { whoop: ["Sources/whoop/", "Sources/whoop/target/", "/^Sources/whoop/(?:.*/)?[^/]*\\.log(?:/|$)/"], tephra: ["Sources/tephra/"] } }),
			"whoop",
			"gym"
		);
		expect(out.excludes).toEqual({
			tephra: ["Sources/tephra/"],
			gym: ["Sources/gym/", "Sources/gym/target/", "/^Sources/gym/(?:.*/)?[^/]*\\.log(?:/|$)/"],
		});
		expect(JSON.stringify(out.excludes)).not.toContain("whoop");
	});

	it("a store with nothing under the source is absent from the result", () => {
		const out = remapSourceStores(
			stores({ noAutoPromoteFolders: ["Projects"], expandedModuleFolders: ["Mod"], sourceSettings: { tephra: { showInSearch: false } }, excludes: { tephra: ["Sources/tephra/"] } }),
			"whoop",
			"gym"
		);
		expect(out).toEqual({ changed: false });
	});
});

describe("remapSourceStores: the no-op", () => {
	it("the same name changes nothing, even with matching entries", () => {
		const out = remapSourceStores(stores({ noAutoPromoteFolders: ["Sources/whoop/a"], sourceSettings: { whoop: { showInSearch: true } } }), "whoop", "whoop");
		expect(out).toEqual({ changed: false });
	});

	it("never mutates its input", () => {
		const input = stores({ noAutoPromoteFolders: ["Sources/whoop/a"], excludes: { whoop: ["Sources/whoop/"] } });
		const snapshot = JSON.stringify(input);
		remapSourceStores(input, "whoop", "gym");
		expect(JSON.stringify(input)).toBe(snapshot);
	});
});

describe("remapExcludeEntry: only an entry Atlas wrote for this source moves", () => {
	it.each([
		["Sources/whoop/", "Sources/gym/"],
		["Sources/whoop/target/", "Sources/gym/target/"],
		["Sources/whoop", "Sources/whoop"], // no slash after the name: not an entry Atlas writes
		["Sources/whoopee/", "Sources/whoopee/"],
		["/^Sources/whoop/(?:.*/)?build(?:/|$)/", "/^Sources/gym/(?:.*/)?build(?:/|$)/"],
		["/^Sources/whoopee/(?:.*/)?build(?:/|$)/", "/^Sources/whoopee/(?:.*/)?build(?:/|$)/"],
		["drafts/", "drafts/"], // the user's own line
		["/\\.tmp$/", "/\\.tmp$/"],
	])("%s -> %s", (entry, expected) => {
		expect(remapExcludeEntry(entry, "whoop", "gym")).toBe(expected);
	});

	it("a name with a regex metacharacter (a dot) is matched literally", () => {
		expect(remapExcludeEntry("/^Sources/my\\.src/(?:.*/)?x(?:/|$)/", "my.src", "my.new")).toBe("/^Sources/my\\.new/(?:.*/)?x(?:/|$)/");
		expect(remapExcludeEntry("/^Sources/myXsrc/(?:.*/)?x(?:/|$)/", "my.src", "my.new")).toBe("/^Sources/myXsrc/(?:.*/)?x(?:/|$)/");
	});

	it("round trip: the entries Atlas writes for `whoop` from a .gitignore become exactly the entries it would write for `gym`", () => {
		const gitignore = ["target/", "*.log", "/dist", "docs/**/tmp", "build/", "!keep.log", "node_modules"].join("\n");
		const before = desiredEntriesForSource("whoop", gitignore, false).entries;
		const after = desiredEntriesForSource("gym", gitignore, false).entries;
		expect(before.length).toBeGreaterThan(3);
		expect(remapExcludeList(before, "whoop", "gym")).toEqual(after);
		expect(before.some((entry) => entry.startsWith("/"))).toBe(true); // regexes are in the mix, not only paths
	});

	it("round trip with a regex-special name (`my.src`)", () => {
		const before = desiredEntriesForSource("my.src", "*.log\nbuild/", true).entries;
		expect(remapExcludeList(before, "my.src", "my_new-1")).toEqual(desiredEntriesForSource("my_new-1", "*.log\nbuild/", true).entries);
	});

	it("remapExcludeList keeps the order, drops a duplicate the move would make, and is null when nothing moved", () => {
		expect(remapExcludeList(["a/", "Sources/whoop/", "Sources/gym/", "b/"], "whoop", "gym")).toEqual(["a/", "Sources/gym/", "b/"]);
		expect(remapExcludeList(["a/", "b/"], "whoop", "gym")).toBeNull();
	});
});

describe("remapPathList", () => {
	it("is null when nothing moved, the moved list otherwise", () => {
		expect(remapPathList(["a", "Sources/whoopee/x"], "whoop", "gym")).toBeNull();
		expect(remapPathList(["a", "Sources/whoop/x"], "whoop", "gym")).toEqual(["a", "Sources/gym/x"]);
	});
});
