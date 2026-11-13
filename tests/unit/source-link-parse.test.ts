import { describe, expect, it } from "vitest";
import { isSourceLinkSyntax, isValidSourceName, parseSourceLink } from "../../src/source-links";

describe("isValidSourceName: [a-z0-9-_.], no space, /, @, :, *", () => {
	const table: Array<[string, boolean]> = [
		["whoop", true],
		["tephra", true],
		["github-atlas", true],
		["my_notes", true],
		["v1.2", true],
		["Whoop", true], // Obsidian matches case-insensitively
		["a", true],
		["", false],
		["my notes", false],
		["a/b", false],
		["@whoop", false],
		["wh:oop", false],
		["a*", false],
		["wh😀", false],
		["café", false],
		[".", false],
		["..", false],
		["whoop ", false],
		["wh\toop", false],
	];
	it.each(table)("%j -> %s", (name, ok) => {
		expect(isValidSourceName(name)).toBe(ok);
	});
});

describe("isSourceLinkSyntax: only `@name:` is new syntax (F9)", () => {
	it.each([
		["@whoop:Workout Plan", true],
		["@:x", true],
		["@whoop:", true],
		["@whoop:x#^id", true],
		["@home", false],
		["@home#a:b", false], // the colon is inside the subpath
		["whoop:x", false],
		["Workout Plan", false],
		["", false],
	])("%j -> %s", (text, expected) => {
		expect(isSourceLinkSyntax(text)).toBe(expected);
	});
	it("refuses non-strings", () => {
		for (const v of [undefined, null, 5, {}, []]) expect(isSourceLinkSyntax(v)).toBe(false);
	});
});

describe("parseSourceLink: well-formed links", () => {
	const table: Array<[string, { source: string; path: string; subpath: string }]> = [
		["@whoop:Workout Plan", { source: "whoop", path: "Workout Plan", subpath: "" }],
		["@whoop:Workout Plan.md", { source: "whoop", path: "Workout Plan", subpath: "" }],
		["@whoop:Workout Plan.MD", { source: "whoop", path: "Workout Plan", subpath: "" }],
		["@whoop:Workout Plan#Week 1", { source: "whoop", path: "Workout Plan", subpath: "#Week 1" }],
		["@whoop:Workout Plan#^plan1", { source: "whoop", path: "Workout Plan", subpath: "#^plan1" }],
		["@whoop:Workout Plan.md#^plan1", { source: "whoop", path: "Workout Plan", subpath: "#^plan1" }],
		["@whoop:Workout Plan#a#b", { source: "whoop", path: "Workout Plan", subpath: "#a#b" }],
		["@tephra:crates/tephrad/src/registry.rs", { source: "tephra", path: "crates/tephrad/src/registry.rs", subpath: "" }],
		["@tephra:crates/tephrad/src/registry.rs#^k3f9a2", { source: "tephra", path: "crates/tephrad/src/registry.rs", subpath: "#^k3f9a2" }],
		["@tephra:README", { source: "tephra", path: "README", subpath: "" }],
		["@v1.2:data.v2.json", { source: "v1.2", path: "data.v2.json", subpath: "" }],
		["@Whoop:x", { source: "Whoop", path: "x", subpath: "" }],
		["@whoop:Entraînement 日本語", { source: "whoop", path: "Entraînement 日本語", subpath: "" }],
		["@whoop:a:b", { source: "whoop", path: "a:b", subpath: "" }], // only the first colon splits
		["@whoop:x.md.md", { source: "whoop", path: "x.md", subpath: "" }], // drops one `.md` only
	];
	it.each(table)("%j", (text, expected) => {
		expect(parseSourceLink(text)).toEqual(expected);
	});
});

describe("parseSourceLink: malformed or non-source text is null and never throws", () => {
	const table: string[] = [
		"@:x", // empty source
		"@whoop:", // empty path
		"@whoop:.md", // nothing left once `.md` is dropped
		"@who op:x", // space in the name
		"@a*:x", // `*`
		"@a/b:x", // `/` in the name
		"@@x:y", // `@` in the name
		"@wh😀:x", // unicode source name
		"@whoop:sub/../x", // `..` segment
		"@whoop:../x",
		"@whoop:./x",
		"@whoop:/x", // leading slash
		"@whoop:a//b", // empty segment
		"@whoop:a/", // trailing slash
		"@whoop:a\\b", // backslash
		"@whoop:a\u0000b", // control char
		"@..:x", // dots-only name
		"@whoop:#^id", // subpath but no path
		"", // empty link
		"@", // bare
		"@home", // no colon: a plain link, not a source link
		"Workout Plan",
		"whoop:Workout Plan",
		"[[@whoop:x]]", // brackets are never part of the link text
	];
	it.each(table)("%j", (text) => {
		let result: unknown;
		expect(() => (result = parseSourceLink(text))).not.toThrow();
		// "[[@whoop:x]]" starts with "[", so it is not source syntax; the rest are rejected by the rules.
		expect(result).toBeNull();
	});
	it("refuses non-strings", () => {
		for (const v of [undefined, null, 5, {}, []]) expect(parseSourceLink(v)).toBeNull();
	});
});
