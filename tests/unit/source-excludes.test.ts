import { describe, expect, it } from "vitest";
import {
	MAX_GITIGNORE_ENTRIES,
	desiredEntriesForSource,
	excludeEntryMatcher,
	gitDirEntry,
	mapGitignore,
	reconcileExcludes,
	type ExcludeConfigAccess,
} from "../../src/source-excludes";

const matches = (entry: string, path: string) => excludeEntryMatcher(entry)!(path);

describe("mapGitignore (R3-2)", () => {
	it("always starts with the source's .git/", () => {
		expect(mapGitignore("tephra", null).entries).toEqual(["Sources/tephra/.git/"]);
		expect(mapGitignore("tephra", "").entries).toEqual(["Sources/tephra/.git/"]);
		expect(gitDirEntry("a.b")).toBe("Sources/a.b/.git/");
	});

	it("maps plain paths to path entries, keeping a trailing slash", () => {
		const { entries, skipped } = mapGitignore("tephra", "target/\nnode_modules/\ndist\n/build/\ndocs/generated/\n");
		expect(entries).toEqual([
			"Sources/tephra/.git/",
			"Sources/tephra/target/",
			"Sources/tephra/node_modules/",
			"Sources/tephra/dist",
			"Sources/tephra/build/",
			"Sources/tephra/docs/generated/",
		]);
		expect(skipped).toEqual([]);
	});

	it("skips comments and blank lines without reporting them", () => {
		const { entries, skipped } = mapGitignore("t", "# build output\n\n   \ntarget/\n");
		expect(entries).toEqual(["Sources/t/.git/", "Sources/t/target/"]);
		expect(skipped).toEqual([]);
	});

	it("skips negations and reports them", () => {
		const { entries, skipped } = mapGitignore("t", "*.log\n!keep.log\n");
		expect(entries).toHaveLength(2);
		expect(skipped).toEqual([{ line: "!keep.log", reason: "negation" }]);
	});

	it("maps a glob to a /regex/ entry that matches at any depth when it has no slash", () => {
		const { entries } = mapGitignore("tephra", "*.log\n");
		const entry = entries[1];
		expect(entry.startsWith("/") && entry.endsWith("/")).toBe(true);
		expect(matches(entry, "Sources/tephra/debug.log")).toBe(true);
		expect(matches(entry, "Sources/tephra/a/b/debug.log")).toBe(true);
		expect(matches(entry, "Sources/tephra/debug.logx")).toBe(false);
		expect(matches(entry, "Sources/tephra/debug.md")).toBe(false);
		expect(matches(entry, "Sources/other/debug.log")).toBe(false);
	});

	it("treats a glob with a slash inside as anchored to the source root", () => {
		const entry = mapGitignore("t", "docs/*.tmp\n").entries[1];
		expect(matches(entry, "Sources/t/docs/a.tmp")).toBe(true);
		expect(matches(entry, "Sources/t/x/docs/a.tmp")).toBe(false);
		expect(matches(entry, "Sources/t/docs/sub/a.tmp")).toBe(false); // `*` doesn't cross a slash
	});

	it("treats a leading slash as anchored, and a glob that is a directory (trailing slash) as a folder only", () => {
		const anchored = mapGitignore("t", "/*.bak\n").entries[1];
		expect(matches(anchored, "Sources/t/x.bak")).toBe(true);
		expect(matches(anchored, "Sources/t/sub/x.bak")).toBe(false);
		const dirs = mapGitignore("t", "build*/\n").entries[1];
		expect(matches(dirs, "Sources/t/build-out/a.o")).toBe(true);
		expect(matches(dirs, "Sources/t/build-out")).toBe(false); // a file named like the folder pattern, no trailing part
	});

	it("a glob also covers what is inside a matching folder", () => {
		const entry = mapGitignore("t", "tmp*\n").entries[1];
		expect(matches(entry, "Sources/t/tmp-1/inner.md")).toBe(true);
		expect(matches(entry, "Sources/t/tmp-1")).toBe(true);
		expect(matches(entry, "Sources/t/notmp")).toBe(false);
	});

	it("**: a leading **/ matches at any depth, a middle /**/ matches zero or more folders, a trailing /** matches everything inside", () => {
		const lead = mapGitignore("t", "**/cache\n").entries[1];
		expect(matches(lead, "Sources/t/cache/x")).toBe(true);
		expect(matches(lead, "Sources/t/a/b/cache")).toBe(true);
		const mid = mapGitignore("t", "a/**/z.md\n").entries[1];
		expect(matches(mid, "Sources/t/a/z.md")).toBe(true);
		expect(matches(mid, "Sources/t/a/b/c/z.md")).toBe(true);
		expect(matches(mid, "Sources/t/b/z.md")).toBe(false);
		const tail = mapGitignore("t", "out/**\n").entries[1];
		expect(matches(tail, "Sources/t/out/x/y")).toBe(true);
		expect(matches(tail, "Sources/t/outside/x")).toBe(false);
	});

	it("? and [abc] classes", () => {
		const q = mapGitignore("t", "file?.md\n").entries[1];
		expect(matches(q, "Sources/t/file1.md")).toBe(true);
		expect(matches(q, "Sources/t/file12.md")).toBe(false);
		const cls = mapGitignore("t", "x[0-9].md\n").entries[1];
		expect(matches(cls, "Sources/t/x5.md")).toBe(true);
		expect(matches(cls, "Sources/t/xa.md")).toBe(false);
		const neg = mapGitignore("t", "y[!a].md\n").entries[1];
		expect(matches(neg, "Sources/t/yb.md")).toBe(true);
		expect(matches(neg, "Sources/t/ya.md")).toBe(false);
	});

	it("escapes regex metacharacters that are plain in a glob, and the source name", () => {
		const entry = mapGitignore("my.repo", "a+b(1)*.md\n").entries[1];
		expect(matches(entry, "Sources/my.repo/a+b(1)z.md")).toBe(true);
		expect(matches(entry, "Sources/myXrepo/a+b(1)z.md")).toBe(false);
		expect(matches(entry, "Sources/my.repo/aab(1)z.md")).toBe(false);
	});

	it("a malformed line is skipped and reported, and never breaks the others", () => {
		const { entries, skipped } = mapGitignore("t", "foo\\\n*.ok\n[unclosed*\n");
		expect(skipped.map((s) => s.line)).toContain("foo\\");
		expect(entries.some((e) => matches(e, "Sources/t/a.ok"))).toBe(true);
		for (const entry of entries) expect(excludeEntryMatcher(entry)).not.toBeNull();
	});

	it("never lets a line reach outside the source (.. segments)", () => {
		const { entries, skipped } = mapGitignore("t", "../secret\nsub/../x\n..\n");
		expect(entries).toEqual(["Sources/t/.git/"]);
		expect(skipped.map((s) => s.reason)).toEqual(["invalid-pattern", "invalid-pattern", "invalid-pattern"]);
	});

	it("drops duplicates and keeps .gitignore order", () => {
		const { entries } = mapGitignore("t", "b/\na/\nb/\n.git/\n");
		expect(entries).toEqual(["Sources/t/.git/", "Sources/t/b/", "Sources/t/a/"]);
	});

	it("reads CRLF files, and ignores trailing spaces unless escaped", () => {
		const { entries } = mapGitignore("t", "out/  \r\nkeep\\ \r\n");
		expect(entries).toEqual(["Sources/t/.git/", "Sources/t/out/", "Sources/t/keep "]);
	});

	it("unescapes an escaped # or ! at the start of a path", () => {
		const { entries, skipped } = mapGitignore("t", "\\#notes\n\\!bang\n");
		expect(entries).toEqual(["Sources/t/.git/", "Sources/t/#notes", "Sources/t/!bang"]);
		expect(skipped).toEqual([]);
	});

	it("caps the number of entries and reports the rest", () => {
		const text = Array.from({ length: MAX_GITIGNORE_ENTRIES + 20 }, (_, i) => `dir${i}/`).join("\n");
		const { entries, skipped } = mapGitignore("t", text);
		expect(entries).toHaveLength(MAX_GITIGNORE_ENTRIES);
		expect(skipped.filter((s) => s.reason === "over-limit")).toHaveLength(21);
	});

	it("nested .gitignore files are never read: the mapper takes one text only", () => {
		expect(mapGitignore.length).toBe(2);
	});
});

describe("desiredEntriesForSource (the per-source show toggle)", () => {
	it("with Show in search on, no whole-source entry", () => {
		expect(desiredEntriesForSource("w", "target/\n", true).entries).toEqual(["Sources/w/.git/", "Sources/w/target/"]);
	});

	it("with it off, Sources/<name>/ comes first", () => {
		expect(desiredEntriesForSource("w", "target/\n", false).entries).toEqual(["Sources/w/", "Sources/w/.git/", "Sources/w/target/"]);
	});
});

function memoryConfig(initial: unknown): ExcludeConfigAccess & { value: unknown; writes: number } {
	const config = {
		value: initial,
		writes: 0,
		get: () => config.value,
		set: (list: string[]) => {
			config.value = list;
			config.writes++;
		},
	};
	return config;
}

describe("reconcileExcludes: only Atlas's own entries change", () => {
	it("adds a source's entries after the user's, in order", () => {
		const config = memoryConfig(["Private/", "/\\.tmp$/"]);
		const result = reconcileExcludes(config, { desired: { t: ["Sources/t/.git/", "Sources/t/target/"] }, tracked: {}, removeStale: true });
		expect(config.value).toEqual(["Private/", "/\\.tmp$/", "Sources/t/.git/", "Sources/t/target/"]);
		expect(result.tracked).toEqual({ t: ["Sources/t/.git/", "Sources/t/target/"] });
	});

	it("is idempotent: a second run writes nothing", () => {
		const config = memoryConfig([]);
		const first = reconcileExcludes(config, { desired: { t: ["Sources/t/.git/"] }, tracked: {}, removeStale: true });
		reconcileExcludes(config, { desired: { t: ["Sources/t/.git/"] }, tracked: first.tracked, removeStale: true });
		expect(config.writes).toBe(1);
	});

	it("an entry the user already had is neither duplicated, tracked nor ever removed", () => {
		const config = memoryConfig(["Sources/t/target/"]);
		const first = reconcileExcludes(config, { desired: { t: ["Sources/t/.git/", "Sources/t/target/"] }, tracked: {}, removeStale: true });
		expect(config.value).toEqual(["Sources/t/target/", "Sources/t/.git/"]);
		expect(first.tracked).toEqual({ t: ["Sources/t/.git/"] });
		const second = reconcileExcludes(config, { desired: {}, tracked: first.tracked, removeStale: true });
		expect(config.value).toEqual(["Sources/t/target/"]);
		expect(second.tracked).toEqual({});
	});

	it("follows a .gitignore edit: drops the entry that went, adds the one that came", () => {
		const config = memoryConfig(["Mine/"]);
		const first = reconcileExcludes(config, { desired: { t: ["Sources/t/.git/", "Sources/t/a/"] }, tracked: {}, removeStale: true });
		reconcileExcludes(config, { desired: { t: ["Sources/t/.git/", "Sources/t/b/"] }, tracked: first.tracked, removeStale: true });
		expect(config.value).toEqual(["Mine/", "Sources/t/.git/", "Sources/t/b/"]);
	});

	it("removes every entry of a source that went, and only those", () => {
		const config = memoryConfig(["Mine/"]);
		const first = reconcileExcludes(config, { desired: { a: ["Sources/a/.git/"], b: ["Sources/b/.git/"] }, tracked: {}, removeStale: true });
		const second = reconcileExcludes(config, { desired: { a: ["Sources/a/.git/"] }, tracked: first.tracked, removeStale: true });
		expect(config.value).toEqual(["Mine/", "Sources/a/.git/"]);
		expect(second.tracked).toEqual({ a: ["Sources/a/.git/"] });
	});

	it("while links are still being made (removeStale off) nothing Atlas added is removed", () => {
		const config = memoryConfig([]);
		const first = reconcileExcludes(config, { desired: { a: ["Sources/a/.git/"] }, tracked: {}, removeStale: true });
		const second = reconcileExcludes(config, { desired: {}, tracked: first.tracked, removeStale: false });
		expect(config.value).toEqual(["Sources/a/.git/"]);
		expect(second.tracked).toEqual(first.tracked);
	});

	it("put back an entry the user removed from the list by hand", () => {
		const config = memoryConfig([]);
		const first = reconcileExcludes(config, { desired: { a: ["Sources/a/.git/"] }, tracked: {}, removeStale: true });
		config.value = [];
		reconcileExcludes(config, { desired: { a: ["Sources/a/.git/"] }, tracked: first.tracked, removeStale: true });
		expect(config.value).toEqual(["Sources/a/.git/"]);
	});

	it("the per-source show toggle: off adds Sources/<name>/, on removes exactly that", () => {
		const config = memoryConfig(["Mine/"]);
		const off = reconcileExcludes(config, { desired: { w: desiredEntriesForSource("w", null, false).entries }, tracked: {}, removeStale: true });
		expect(config.value).toEqual(["Mine/", "Sources/w/", "Sources/w/.git/"]);
		reconcileExcludes(config, { desired: { w: desiredEntriesForSource("w", null, true).entries }, tracked: off.tracked, removeStale: true });
		expect(config.value).toEqual(["Mine/", "Sources/w/.git/"]);
	});

	it("an entry two sources both want stays while one of them does", () => {
		const config = memoryConfig([]);
		const first = reconcileExcludes(config, { desired: { a: ["shared/"], b: ["x/"] }, tracked: {}, removeStale: true });
		reconcileExcludes(config, { desired: { b: ["shared/", "x/"] }, tracked: first.tracked, removeStale: true });
		expect(config.value).toContain("shared/");
	});

	it("a list that isn't an array is treated as empty and written only when there is something to add", () => {
		const untouched = memoryConfig("garbage");
		reconcileExcludes(untouched, { desired: {}, tracked: {}, removeStale: true });
		expect(untouched.value).toBe("garbage");
		const filled = memoryConfig(undefined);
		reconcileExcludes(filled, { desired: { a: ["Sources/a/.git/"] }, tracked: {}, removeStale: true });
		expect(filled.value).toEqual(["Sources/a/.git/"]);
	});

	it("a source called constructor does not read the prototype", () => {
		const config = memoryConfig([]);
		const desired = JSON.parse('{"constructor": ["Sources/constructor/.git/"]}') as Record<string, string[]>;
		const result = reconcileExcludes(config, { desired, tracked: {}, removeStale: true });
		expect(config.value).toEqual(["Sources/constructor/.git/"]);
		expect(Object.keys(result.tracked)).toEqual(["constructor"]);
	});
});
