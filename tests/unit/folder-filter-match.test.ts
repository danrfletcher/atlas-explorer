import { describe, expect, it } from "vitest";
import { matchesYamlRules, type YamlFilterRule } from "../../src/folder-filter";

const rule = (key: string, value: string): YamlFilterRule => ({ key, value });

/** Table of [description, frontmatter, rules, expected]. Pure inputs only, no Obsidian mocks. */
const cases: [string, unknown, YamlFilterRule[], boolean][] = [
	// G3: ANDed rules
	["every rule must match (AND)", { status: "active", company: "Gamma" }, [rule("status", "active"), rule("company", "Gamma")], true],
	["one failing rule fails the file", { status: "active" }, [rule("status", "active"), rule("company", "Gamma")], false],

	// G3: key case-insensitive
	["key lookup ignores case", { Status: "Active" }, [rule("status", "active")], true],
	["rule key case is ignored too", { status: "active" }, [rule("STATUS", "active")], true],

	// G3: value trimmed, case-insensitive equality
	["rule value is trimmed", { status: "active" }, [rule("status", "  active  ")], true],
	["value compares case-insensitively", { status: "ACTIVE" }, [rule("status", "active")], true],
	["a different value fails", { status: "done" }, [rule("status", "active")], false],
	["equality is exact, not substring", { status: "inactive" }, [rule("status", "active")], false],

	// G3: lists match if any item equals
	["a list matches on any item", { tags: ["a", "Active", "c"] }, [rule("tags", "active")], true],
	["a list with no equal item fails", { tags: ["a", "c"] }, [rule("tags", "active")], false],

	// G3: [[X]] and [[X|alias]] compare as X
	["[[X]] compares as X", { company: "[[Gamma Ltd]]" }, [rule("company", "Gamma Ltd")], true],
	["[[X|alias]] compares as X", { company: "[[Gamma Ltd|GL]]" }, [rule("company", "Gamma Ltd")], true],
	["[[X|alias]] inside a list matches as X", { client: ["[[Acme|A]]"] }, [rule("client", "Acme")], true],
	["the alias itself does not match", { company: "[[Gamma Ltd|GL]]" }, [rule("company", "GL")], false],
	["a rule written as [[X]] compares as X", { company: "Gamma Ltd" }, [rule("company", "[[Gamma Ltd]]")], true],

	// G3: empty value means key present
	["empty value matches a present key", { status: "x" }, [rule("status", "")], true],
	["empty value matches key: null", { status: null }, [rule("status", "")], true],
	["empty value matches key: []", { status: [] }, [rule("status", "")], true],
	["empty value fails an absent key", { other: "x" }, [rule("status", "")], false],
	["whitespace value behaves as empty", { status: null }, [rule("status", "   ")], true],
	["whitespace value still needs the key", { other: null }, [rule("status", "   ")], false],

	// G3: non-empty value fails null and []
	["non-empty value fails key: null", { status: null }, [rule("status", "active")], false],
	["non-empty value fails key: []", { status: [] }, [rule("status", "active")], false],

	// G3: numbers, booleans and dates compare as text
	["number 0 compares as text '0'", { n: 0 }, [rule("n", "0")], true],
	["boolean false compares as text 'false'", { flag: false }, [rule("flag", "false")], true],
	["ISO date string compares as text", { d: "2026-01-02" }, [rule("d", "2026-01-02")], true],
	["Date object compares as its date text", { d: new Date("2026-01-02T00:00:00Z") }, [rule("d", "2026-01-02")], true],
	["a number does not match a different number", { n: 1 }, [rule("n", "0")], false],

	// E2: nested objects never match
	["nested object never matches a value", { meta: { a: 1 } }, [rule("meta", "x")], false],
	["nested object never matches an empty-value rule", { meta: { a: 1 } }, [rule("meta", "")], false],
	["nested object inside a list is not an item", { l: [{ a: 1 }] }, [rule("l", "x")], false],
	["nested object does not match the rule text in its own fields", { meta: { a: "x" } }, [rule("meta", "x")], false],

	// E2: two rules on the same key must both hold
	["same key, both rules hold", { status: "active" }, [rule("status", "active"), rule("status", "")], true],
	["same key, contradictory rules match nothing", { status: "active" }, [rule("status", "active"), rule("status", "done")], false],

	// E1: missing or malformed frontmatter fails every rule
	["undefined frontmatter fails a value rule", undefined, [rule("status", "active")], false],
	["undefined frontmatter fails an empty-value rule", undefined, [rule("status", "")], false],
	["null frontmatter fails every rule", null, [rule("status", "")], false],
	["a non-object frontmatter fails every rule", "status: active", [rule("status", "active")], false],
	["an array frontmatter fails every rule", ["status"], [rule("status", "")], false],
	["a body-only file (no frontmatter) fails an empty-value rule", undefined, [rule("status", "")], false],

	// Zero valid rules means unfiltered
	["zero rules passes anything", undefined, [], true],
	["zero rules passes a file with frontmatter", { status: "done" }, [], true],
	["rules with an empty key are ignored", { status: "done" }, [rule("  ", "active")], true],

	// Added: key with surrounding whitespace is trimmed
	["a rule key with surrounding whitespace is trimmed", { status: "active" }, [rule("  status  ", "active")], true],

	// F1: no or/not, comparisons, regex or != . Values are literal text.
	["'!done' is literal text, not negation", { status: "done" }, [rule("status", "!done")], false],
	["'!done' matches the literal text '!done'", { status: "!done" }, [rule("status", "!done")], true],
	["'>5' is literal text, not a comparison", { n: 6 }, [rule("n", ">5")], false],
	["'>5' matches the literal text '>5'", { n: ">5" }, [rule("n", ">5")], true],
	["'/a.*/' is literal text, not a regex", { x: "abc" }, [rule("x", "/a.*/")], false],
	["'/a.*/' matches the literal text '/a.*/'", { x: "/a.*/" }, [rule("x", "/a.*/")], true],
];

describe("matchesYamlRules", () => {
	it.each(cases)("%s", (_description, frontmatter, rules, expected) => {
		expect(matchesYamlRules(frontmatter, rules)).toBe(expected);
	});

	it("GP1: rule status = active selects acme and gamma, and not beta", () => {
		const acme = { status: "active" };
		const beta = { status: "done" };
		const gamma = { Status: "Active", company: "[[Gamma Ltd]]" };
		const rules = [rule("status", "active")];
		expect([acme, beta, gamma].map((fm) => matchesYamlRules(fm, rules))).toEqual([true, false, true]);
	});

	it("GP1: rule company = Gamma Ltd selects gamma via the link form", () => {
		const gamma = { Status: "Active", company: "[[Gamma Ltd]]" };
		expect(matchesYamlRules(gamma, [rule("company", "Gamma Ltd")])).toBe(true);
	});

	it("does not mutate its inputs", () => {
		const frontmatter = { status: "active", tags: ["a"] };
		const rules = [rule("status", "active")];
		matchesYamlRules(frontmatter, rules);
		expect(frontmatter).toEqual({ status: "active", tags: ["a"] });
		expect(rules).toEqual([rule("status", "active")]);
	});
});
