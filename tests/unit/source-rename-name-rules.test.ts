import { describe, expect, it } from "vitest";
import { renameRefusalText, validateSourceName, type SourceNameContext } from "../../src/source-name-rules";

/** PR-11 (G4): the Rename dialog's live check. The same rules as Add (G3/E2), minus the source being renamed. */

const context = (over: Partial<SourceNameContext> = {}): SourceNameContext => ({
	registered: ["notes", "tephra", "whoop"],
	sourcesEntries: ["tephra", "whoop", "stray-note.md"],
	renaming: "whoop",
	...over,
});

describe("Rename: one row per G3/E2 rule", () => {
	const rows: { name: string; ctx?: Partial<SourceNameContext>; valid: boolean; code?: string }[] = [
		{ name: "gym", valid: true },
		{ name: "my_src.v2", valid: true }, // dots and underscores go through
		{ name: "a".repeat(150), valid: true }, // a long name goes through
		{ name: "", valid: false, code: "empty" },
		{ name: "a b", valid: false, code: "space" },
		{ name: "a\tb", valid: false, code: "space" },
		{ name: "a/b", valid: false, code: "forbidden-char" },
		{ name: "a@b", valid: false, code: "forbidden-char" },
		{ name: "a:b", valid: false, code: "forbidden-char" },
		{ name: "a*b", valid: false, code: "forbidden-char" },
		{ name: "tephra", valid: false, code: "taken-source" }, // another source
		{ name: "TEPHRA", valid: false, code: "taken-source" }, // compared without regard to case
		{ name: "notes", valid: false, code: "taken-source" }, // the vault's own source
		{ name: "stray-note.md", ctx: { registered: ["notes", "whoop"] }, valid: false, code: "taken-entry" }, // a Sources/ entry that isn't a source
		{ name: "Stray-Note.md", ctx: { registered: ["notes", "whoop"] }, valid: false, code: "taken-entry" },
		{ name: "whoop", valid: true }, // the unchanged current name: valid, and confirming it changes nothing
		{ name: "Whoop", valid: true }, // case-only: not refused for matching itself
		{ name: "WHOOP", valid: true },
		{ name: "a".repeat(200), valid: true }, // no local byte cap when renaming: Tephra judges the length
		{ name: "a".repeat(300), valid: true },
	];
	it.each(rows)("$name -> valid:$valid $code", ({ name, ctx, valid, code }) => {
		const result = validateSourceName(name, context(ctx));
		expect(result.valid).toBe(valid);
		if (!result.valid) {
			expect(result.code).toBe(code);
			expect(result.message.length).toBeGreaterThan(0);
		}
	});

	it("without `renaming` (Add) the source's own name is taken: the rename context is the only difference", () => {
		const result = validateSourceName("whoop", context({ renaming: undefined }));
		expect(result).toMatchObject({ valid: false, code: "taken-source" });
	});

	it("a name of 255+ bytes is not refused here (renaming): the request goes to Tephra, whose reason shows; Add keeps its 199-byte cap", () => {
		for (const length of [199, 200, 255, 256, 300]) {
			expect(validateSourceName("a".repeat(length), context())).toEqual({ valid: true });
		}
		expect(validateSourceName("é".repeat(130), context())).toMatchObject({ valid: false, code: "unsupported-char" }); // 260 bytes: only the link-syntax rule applies
		expect(validateSourceName("a".repeat(200), context({ renaming: undefined }))).toMatchObject({ valid: false, code: "too-long" });
		expect(validateSourceName("a".repeat(255), context({ renaming: undefined }))).toMatchObject({ valid: false, code: "too-long" });
	});

	it("`renaming` frees only that source: a case-variant of ANOTHER source's name still clashes", () => {
		expect(validateSourceName("Tephra", context({ renaming: "whoop" }))).toMatchObject({ valid: false, code: "taken-source" });
		expect(validateSourceName("whoop", context({ renaming: "tephra" }))).toMatchObject({ valid: false, code: "taken-source" });
	});

	it("the taken message names the clash", () => {
		expect(validateSourceName("tephra", context())).toMatchObject({ message: "A source named tephra already exists" });
		expect(validateSourceName("stray-note.md", context({ registered: ["notes", "whoop"] }))).toMatchObject({ message: "Sources/stray-note.md already exists in the vault" });
	});
});

describe("renameRefusalText: Tephra's refusal reason, word for word", () => {
	it("an rpc refusal is Tephra's sentence without Atlas's prefix", () => {
		expect(renameRefusalText({ kind: "rpc", message: 'Tephra error: the name "tephra" is taken by the source "tephra"' })).toBe('the name "tephra" is taken by the source "tephra"');
		expect(renameRefusalText({ kind: "rpc", message: "no source named whoop" })).toBe("no source named whoop");
	});

	it("keeps everything else in the sentence, including a prefix that isn't Atlas's", () => {
		expect(renameRefusalText({ kind: "rpc", message: "source offline: Tephra error: x" })).toBe("source offline: Tephra error: x");
	});

	it.each([
		["network", "Tephra isn't running"],
		["no-token", "Tephra isn't running"],
		["timeout", "Tephra didn't answer in time"],
	])("%s -> %s", (kind, text) => {
		expect(renameRefusalText({ kind, message: "whatever the transport said" })).toBe(text);
	});

	it.each(["http", "non-json", "bad-response", "unauthorized"])("%s keeps the client's own message", (kind) => {
		expect(renameRefusalText({ kind, message: "Tephra answered 503" })).toBe("Tephra answered 503");
	});
});
