import { describe, expect, it } from "vitest";
import { validateName } from "../../src/name-rules";
import { isValidSourceName } from "../../src/source-links";
import { MAX_SOURCE_NAME_BYTES, folderBaseName, slugSourceName, validateSourceName, type SourceNameContext } from "../../src/source-name-rules";

const context = (over: Partial<SourceNameContext> = {}): SourceNameContext => ({ registered: ["notes", "tephra"], sourcesEntries: ["tephra"], ...over });

describe("slugSourceName (G3 prefill)", () => {
	it.each([
		["Whoop", "whoop"],
		["My Notes", "my-notes"],
		["already-fine", "already-fine"],
		["Two  Spaces", "two--spaces"], // each space becomes one dash; nothing else is tidied
		["Café Œuvre", "café-œuvre"], // unicode is lowercased, never stripped (the live check marks it red)
		["@@@", "@@@"], // shown as typed: the live check marks it red
		["", ""],
	])("%j -> %j", (base, slug) => {
		expect(slugSourceName(base)).toBe(slug);
	});

	it("leaves a name of 200+ bytes whole (the live check, not the prefill, refuses it)", () => {
		expect(slugSourceName("N".repeat(250))).toBe("n".repeat(250));
	});
});

describe("folderBaseName", () => {
	it.each([
		["/Users/dan/Documents/Whoop", "Whoop"],
		["/Users/dan/Documents/Whoop/", "Whoop"],
		["/Users/dan/Documents/Whoop///", "Whoop"],
		["C:\\Users\\dan\\My Notes", "My Notes"],
		["/", ""],
		["Whoop", "Whoop"],
	])("%j -> %j", (path, base) => {
		expect(folderBaseName(path)).toBe(base);
	});
});

describe("validateSourceName: one row per live-check rule (G3, E2)", () => {
	const rows: { name: string; ctx?: Partial<SourceNameContext>; valid: boolean; code?: string; message?: string | RegExp }[] = [
		{ name: "whoop", valid: true },
		{ name: "my-notes_2.v1", valid: true },
		{ name: "", valid: false, code: "empty", message: "Enter a name" },
		{ name: "my notes", valid: false, code: "space", message: "A source name can't contain a space" },
		{ name: " whoop", valid: false, code: "space" },
		{ name: "who\top", valid: false, code: "space" }, // a tab is whitespace too
		{ name: "who/op", valid: false, code: "forbidden-char", message: 'A source name can\'t contain "/"' },
		{ name: "who@op", valid: false, code: "forbidden-char", message: 'A source name can\'t contain "@"' },
		{ name: "who:op", valid: false, code: "forbidden-char", message: 'A source name can\'t contain ":"' },
		{ name: "who*op", valid: false, code: "forbidden-char", message: 'A source name can\'t contain "*"' },
		{ name: "@@@", valid: false, code: "forbidden-char" },
		{ name: "..", valid: false, code: "unusable" },
		{ name: ".", valid: false, code: "unusable" },
		{ name: "a\\b", valid: false, code: "unusable" },
		{ name: "__proto__", valid: false, code: "unusable" },
		{ name: "tephra", valid: false, code: "taken-source", message: "A source named tephra already exists" },
		{ name: "TEPHRA", valid: false, code: "taken-source", message: "A source named tephra already exists" }, // case-insensitive
		{ name: "Notes", ctx: { registered: [] }, valid: false, code: "taken-source", message: "A source named notes already exists" }, // the vault, even if Tephra doesn't list it yet
		{ name: "whoop", ctx: { sourcesEntries: ["whoop"] }, valid: false, code: "taken-entry", message: "Sources/whoop already exists in the vault" },
		{ name: "WHOOP", ctx: { sourcesEntries: ["Whoop"] }, valid: false, code: "taken-entry", message: "Sources/Whoop already exists in the vault" }, // a stray note/folder/symlink, any case
		{ name: "whoop", ctx: { registered: ["Whoop"] }, valid: false, code: "taken-source", message: "A source named Whoop already exists" },
	];

	it.each(rows)("$name -> valid=$valid $code", ({ name, ctx, valid, code, message }) => {
		const result = validateSourceName(name, context(ctx));
		expect(result.valid).toBe(valid);
		if (result.valid) return;
		expect(result.code).toBe(code);
		if (typeof message === "string") expect(result.message).toBe(message);
	});

	it("a registered source wins over an entry of the same name (one reason, the source's)", () => {
		const result = validateSourceName("tephra", context());
		expect(result).toMatchObject({ valid: false, code: "taken-source" });
	});

	it("unicode names are red: the [[@name:…]] link syntax (PR-1) can't address them", () => {
		for (const name of ["café-œuvre", "日本語のノート", "CAFÉ"]) {
			expect(validateSourceName(name, context()), name).toMatchObject({ valid: false, code: "unsupported-char" });
		}
		expect(validateSourceName("café", context())).toMatchObject({ message: expect.stringContaining("letters a-z") });
	});

	it.each(["who#op", "who!", "(whoop)", "wh$op", "who+op", "who=op"])("%j: any character outside a-z 0-9 . _ - is red, as the link syntax can't carry it", (name) => {
		expect(validateSourceName(name, context())).toMatchObject({ valid: false, code: "unsupported-char" });
	});

	it("every name the link syntax accepts passes the character rule, and every one it rejects is red", () => {
		for (const name of ["whoop", "Whoop", "my-notes_2.v1", "a.", "-x", "_x", "9"]) {
			expect(isValidSourceName(name), name).toBe(true);
			expect(validateSourceName(name, context()), name).toEqual({ valid: true });
		}
		for (const name of ["é", "a b", "a#b", "日本"]) {
			expect(isValidSourceName(name), name).toBe(false);
			expect(validateSourceName(name, context()).valid, name).toBe(false);
		}
	});

	describe("length boundary (UTF-8 bytes, not characters)", () => {
		it("199 bytes is valid, 200 bytes is red", () => {
			expect(MAX_SOURCE_NAME_BYTES).toBe(199);
			expect(validateSourceName("n".repeat(199), context())).toEqual({ valid: true });
			expect(validateSourceName("n".repeat(200), context())).toMatchObject({ valid: false, code: "too-long" });
			expect(validateSourceName("n".repeat(250), context())).toMatchObject({ valid: false, code: "too-long" });
		});

		it("counts bytes: 100 two-byte characters are 200 bytes and red as too long (99 are red too, as unicode)", () => {
			expect(validateSourceName("é".repeat(100), context())).toMatchObject({ valid: false, code: "too-long" });
			expect(validateSourceName("é".repeat(99), context())).toMatchObject({ valid: false, code: "unsupported-char" });
		});

		it("a long name with a forbidden character reports the character first", () => {
			expect(validateSourceName(`${"n".repeat(250)}:`, context())).toMatchObject({ code: "forbidden-char" });
		});
	});

	it("does not use the vault's name rules: a name `validateName` refuses (the vault's own folder name rules) can be a source name", () => {
		const name = "a.";
		expect(validateName(name, { root: [] }).valid).toBe(false); // the vault refuses a trailing dot...
		expect(validateSourceName(name, context())).toEqual({ valid: true }); // ...a source name doesn't
	});
});
