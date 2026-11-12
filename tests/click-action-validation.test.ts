import { describe, expect, it } from "vitest";
import { validateClickActionValue } from "../src/click-action-validation";
import { ClickActionKind } from "../src/types";

type Row = [label: string, kind: ClickActionKind, value: string, ok: boolean];

/** Pure rules, no DOM. G4/E5 (terminal), G5 (command), G6/E4 (URI). */
const ROWS: Row[] = [
	// --- terminal: tokenizer only, no shell, no placeholder check ---
	["terminal: plain command", "terminal", "open -a Docker", true],
	["terminal: single word", "terminal", "ls", true],
	["terminal: double-quoted argument", "terminal", 'open -a "Live Captions"', true],
	["terminal: single-quoted argument", "terminal", "open -a 'Live Captions'", true],
	["terminal: escaped space", "terminal", "open -a Live\\ Captions", true],
	["terminal: a `{field}` placeholder is not resolved or rejected at save time", "terminal", "open {path}", true],
	["terminal: shell syntax is just literal tokens, never rejected", "terminal", "echo a | b && c", true],
	["terminal: a missing executable is accepted at save", "terminal", "definitely-not-installed --flag", true],
	["terminal: empty", "terminal", "", false],
	["terminal: spaces only", "terminal", "   ", false],
	["terminal: tab and spaces only", "terminal", " \t  ", false],
	["terminal: unbalanced double quote", "terminal", 'open -a "Live Captions', false],
	["terminal: unbalanced single quote", "terminal", "open -a 'Docker", false],
	["terminal: unicode arguments", "terminal", "open -a Café 日本語 🚀", true],
	["terminal: a 2,000-character command", "terminal", `echo ${"a".repeat(1995)}`, true],

	// --- command: any non-blank id; registration is not a save-time rule ---
	["command: an id", "command", "app-runner:open-live-captions", true],
	["command: an id that is not registered anywhere", "command", "gone-plugin:gone-command", true],
	["command: empty", "command", "", false],
	["command: whitespace only", "command", "  ", false],

	// --- URI: accepted by `new URL()` and carries a scheme; any scheme ---
	["uri: obsidian://", "uri", "obsidian://open?vault=Notes&file=Docker", true],
	["uri: https", "uri", "https://example.com/a?b=c#d", true],
	["uri: mailto", "uri", "mailto:dan@example.com", true],
	["uri: a custom scheme", "uri", "x-apple-app://thing", true],
	["uri: file", "uri", "file:///Applications/Docker.app", true],
	["uri: unicode in the query", "uri", "obsidian://open?vault=Café&file=日本語 🚀", true],
	["uri: interior double space", "uri", "obsidian://open?file=a  b", true],
	["uri: a 2,000-character value", "uri", `https://example.com/?q=${"x".repeat(1977)}`, true],
	["uri: empty", "uri", "", false],
	["uri: whitespace only", "uri", "   ", false],
	["uri: not a uri", "uri", "not a uri", false],
	["uri: a bare word", "uri", "docker", false],
	["uri: protocol-relative, no scheme", "uri", "//no-scheme", false],
	["uri: a colon and nothing before it", "uri", ":foo", false],
	["uri: a path", "uri", "/Applications/Docker.app", false],
	["uri: a scheme with a space in it", "uri", "my app://x", false],
];

describe("validateClickActionValue", () => {
	it.each(ROWS)("%s", (_label, kind, value, ok) => {
		expect(validateClickActionValue(kind, value).ok).toBe(ok);
	});

	it("gives every refusal a non-empty message to show inline", () => {
		for (const [label, kind, value, ok] of ROWS) {
			if (ok) continue;
			const result = validateClickActionValue(kind, value);
			expect(result.ok, label).toBe(false);
			if (!result.ok) expect(result.error.length, label).toBeGreaterThan(0);
		}
	});

	it("names the unbalanced quote for a terminal tokenizer error", () => {
		const result = validateClickActionValue("terminal", "open 'x");
		expect(result).toEqual({ ok: false, error: expect.stringMatching(/quote/i) });
	});

	it("never changes the value: it only answers yes or no", () => {
		const value = "  obsidian://open?file=a  b  ";
		const before = value;
		validateClickActionValue("uri", value);
		expect(value).toBe(before);
	});
});
