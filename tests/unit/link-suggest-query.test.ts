import { describe, expect, it } from "vitest";
import { parseSuggestQuery, type ParsedSuggestQuery } from "../../src/link-suggest-query";

type Row = [typed: string, expected: Partial<ParsedSuggestQuery>];

const base: ParsedSuggestQuery = { mode: "own", source: null, query: "", marker: null, sub: "", alias: false };

/** What is typed after `[[` (or `![[`: the trigger regex in `onTrigger` hands over the same text for both). */
const rows: Row[] = [
	// [[text — the note's own source
	["", { mode: "own", query: "" }],
	["text", { mode: "own", query: "text" }],
	["Workout Plan", { mode: "own", query: "Workout Plan" }],
	["a@b", { mode: "own", query: "a@b" }], // an `@` that is not first is just text
	["a:b", { mode: "own", query: "a:b" }],
	// [[@ — the source list
	["@", { mode: "sources", query: "" }],
	["@x", { mode: "sources", query: "x" }],
	["@wh", { mode: "sources", query: "wh" }],
	["@WH", { mode: "sources", query: "WH" }], // case is kept; matching is case-insensitive elsewhere
	// [[@x: — one source
	["@x:", { mode: "source", source: "x", query: "" }],
	["@x:t", { mode: "source", source: "x", query: "t" }],
	["@whoop:Workout Plan", { mode: "source", source: "whoop", query: "Workout Plan" }],
	["@WHOOP:leg", { mode: "source", source: "WHOOP", query: "leg" }],
	["@notes:Foo", { mode: "source", source: "notes", query: "Foo" }],
	["@x:a:b", { mode: "source", source: "x", query: "a:b" }], // only the first colon splits
	// names with - _ .
	["@github-atlas:", { mode: "source", source: "github-atlas", query: "" }],
	["@my_src:x", { mode: "source", source: "my_src", query: "x" }],
	["@v1.2:x", { mode: "source", source: "v1.2", query: "x" }],
	// empty name
	["@:", { mode: "source", source: "", query: "" }],
	["@:x", { mode: "source", source: "", query: "x" }],
	// [[@*:t — every source
	["@*:", { mode: "all", source: "*", query: "" }],
	["@*:t", { mode: "all", source: "*", query: "t" }],
	["@*:a b", { mode: "all", source: "*", query: "a b" }],
	// # ^ | after each form
	["text#", { mode: "own", query: "text", marker: "#", sub: "" }],
	["text#Head", { mode: "own", query: "text", marker: "#", sub: "Head" }],
	["text^", { mode: "own", query: "text", marker: "^", sub: "" }],
	["text^abc", { mode: "own", query: "text", marker: "^", sub: "abc" }],
	["text|al", { mode: "own", query: "text", alias: true }],
	["#", { mode: "own", query: "", marker: "#" }],
	["@wh#", { mode: "sources", query: "wh", marker: "#" }],
	["@wh|x", { mode: "sources", query: "wh", alias: true }],
	["@x:t#", { mode: "source", source: "x", query: "t", marker: "#", sub: "" }],
	["@x:t#He", { mode: "source", source: "x", query: "t", marker: "#", sub: "He" }],
	["@x:t^", { mode: "source", source: "x", query: "t", marker: "^", sub: "" }],
	["@x:t^ab", { mode: "source", source: "x", query: "t", marker: "^", sub: "ab" }],
	["@x:t|wp", { mode: "source", source: "x", query: "t", alias: true }],
	["@whoop:Workout Plan|wp", { mode: "source", source: "whoop", query: "Workout Plan", alias: true }],
	["@*:t#", { mode: "all", source: "*", query: "t", marker: "#" }],
	["@*:t|a", { mode: "all", source: "*", query: "t", alias: true }],
	// the first of # ^ | decides
	["A#b|c", { mode: "own", query: "A", marker: "#", sub: "b", alias: true }],
	["A|b#c", { mode: "own", query: "A", marker: null, sub: "", alias: true }],
	["A^b|c", { mode: "own", query: "A", marker: "^", sub: "b", alias: true }],
	["@x:A#b|c", { mode: "source", source: "x", query: "A", marker: "#", sub: "b", alias: true }],
	["@x:A|b#c", { mode: "source", source: "x", query: "A", marker: null, alias: true }],
	// `#^` is Obsidian's block-link spelling: a block search, not a heading search for "^"
	["@x:crates/tephrad/src/registry.rs#^", { mode: "source", source: "x", query: "crates/tephrad/src/registry.rs", marker: "^", sub: "" }],
	["text#^", { mode: "own", query: "text", marker: "^", sub: "" }],
	["text#^ab", { mode: "own", query: "text", marker: "^", sub: "ab" }],
	["@x:t#^ab|al", { mode: "source", source: "x", query: "t", marker: "^", sub: "ab", alias: true }],
	["text#a^b", { mode: "own", query: "text", marker: "#", sub: "a^b" }], // a `^` later in a heading search is text
];

describe("parseSuggestQuery: the trigger grammar after [[", () => {
	it.each(rows)("%j", (typed, expected) => {
		expect(parseSuggestQuery(typed)).toEqual({ ...base, ...expected });
	});

	it("`![[` hands over the same text as `[[`: the embed `!` is not part of the query", () => {
		// onTrigger's regex is `\[\[([^[\]]*)$`, so for `![[@whoop:` the query is what follows the brackets.
		const line = "![[@whoop:";
		const typed = /\[\[([^[\]]*)$/.exec(line)![1];
		expect(parseSuggestQuery(typed)).toEqual({ ...base, mode: "source", source: "whoop" });
		expect(parseSuggestQuery(typed)).toEqual(parseSuggestQuery(/\[\[([^[\]]*)$/.exec("[[@whoop:")![1]));
	});

	it("never throws and always returns a mode", () => {
		for (const typed of ["@@", "@@:", "@:*", "::", "@x:@y:z", "|", "^", "#^|", "@*", "@*x:"]) {
			expect(["own", "sources", "source", "all"]).toContain(parseSuggestQuery(typed).mode);
		}
	});

	it("`@*` without a colon is still the source list; `@*x:` names a source called `*x`", () => {
		expect(parseSuggestQuery("@*")).toMatchObject({ mode: "sources", query: "*" });
		expect(parseSuggestQuery("@*x:")).toMatchObject({ mode: "source", source: "*x" });
	});
});
