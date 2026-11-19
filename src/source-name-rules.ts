import { isUsableSourceName } from "./tephra-client";
import { VAULT_SOURCE_NAME } from "./sources-links";
import { isValidSourceName } from "./source-links";

/**
 * PR-5 (G3/E2): the rules for the name of a new Tephra source. They are their own: a source name becomes one
 * folder under `Sources/` and half of a `[[@name:…]]` link, so it is not a vault file name and `validateName`
 * (the vault's rules) does not apply.
 */

/** When adding, a name this many UTF-8 bytes long or longer is refused (renaming has no local cap). Tephra's own limit is not known to Atlas (read
 * from its code: it states none), so this keeps the `Sources/<name>` folder name well inside the 255 bytes
 * every common filesystem allows for one path segment. */
export const MAX_SOURCE_NAME_BYTES = 199;

/** What the `[[@name:path]]` link syntax can address (PR-1, `isValidSourceName`): letters a-z, digits, `.`, `_`
 * and `-`. A source with any other character (unicode included) would register but no link could reach it, so
 * the live check marks it red. */
const LINK_NAME_HINT = "A source name can only use letters a-z, digits, \".\", \"_\" and \"-\" (so [[@name:…]] links can reach it)";

/** The characters a source name can't hold, besides a space: they break `[[@name:path]]` links or are
 * wildcards. */
const FORBIDDEN_CHARS = ["/", "@", ":", "*"] as const;

export type SourceNameErrorCode = "empty" | "space" | "forbidden-char" | "too-long" | "unusable" | "unsupported-char" | "taken-source" | "taken-entry";

export type SourceNameValidation = { valid: true } | { valid: false; code: SourceNameErrorCode; message: string };

/**
 * The suggested name for a folder: its base name, lowercased, each space turned into `-`
 * (`Whoop` → `whoop`, `My Notes` → `my-notes`). Nothing else is changed or removed, so a base name that is
 * invalid (`@@@`, a very long one) shows as typed and the live check marks it red.
 */
export function slugSourceName(folderBaseName: string): string {
	return folderBaseName.toLowerCase().replace(/\s/g, "-");
}

/** The last path segment of a folder path (either separator, trailing separators ignored); "" for a root. */
export function folderBaseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return trimmed.slice(trimmed.search(/[^\\/]*$/));
}

export interface SourceNameContext {
	/** The names of the sources Tephra lists now (its cached `source.list`). */
	registered: readonly string[];
	/** The names of the entries `Sources/` holds now (a folder, a note, a stray symlink: anything). */
	sourcesEntries: readonly string[];
	/** PR-11 (G4): set when the name is for renaming this source. The source's own name and its own
	 * `Sources/<name>` link are not clashes: typing the current name stays valid (confirming it changes nothing),
	 * and a case-only change (`whoop` -> `Whoop`) is not refused for matching itself. Every other source and
	 * entry still clashes. */
	renaming?: string;
}

const invalid = (code: SourceNameErrorCode, message: string): SourceNameValidation => ({ valid: false, code, message });

/** Case-insensitive, the way the vault's own folders are compared (macOS and Windows filesystems are). */
function sameName(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * The live check, re-run on every keystroke. The first rule that fails gives the reason: empty, a space,
 * `/` `@` `:` `*`, too long, a name that can't be a folder name, a character the `[[@name:…]]` link syntax
 * can't carry (unicode, `#`, `!`…), taken by a registered source, taken by an
 * entry already in `Sources/`. The vault's own source (`notes`) is always taken, whether or not Tephra lists
 * it yet. With `context.renaming` set (PR-11), the source being renamed and its own `Sources/` entry don't count,
 * and the byte cap does not apply: Tephra judges the length of a new name and its reason is shown.
 */
export function validateSourceName(name: string, context: SourceNameContext): SourceNameValidation {
	if (name.length === 0) return invalid("empty", "Enter a name");
	if (/\s/.test(name)) return invalid("space", "A source name can't contain a space");
	for (const char of FORBIDDEN_CHARS) {
		if (name.includes(char)) return invalid("forbidden-char", `A source name can't contain "${char}"`);
	}
	// Add only. Renaming leaves length to Tephra (PR-11 spec: a 255+ byte name shows Tephra's own reason), so the
	// request goes out and its sentence is shown word for word.
	if (context.renaming === undefined && new TextEncoder().encode(name).length > MAX_SOURCE_NAME_BYTES) {
		return invalid("too-long", `A source name must be under ${MAX_SOURCE_NAME_BYTES + 1} bytes long`);
	}
	if (!isUsableSourceName(name)) return invalid("unusable", `"${name}" can't be used as a source name`);

	if (!isValidSourceName(name)) return invalid("unsupported-char", LINK_NAME_HINT);

	const own = context.renaming;
	const isOwn = (existing: string): boolean => own !== undefined && existing === own;
	const taken = [VAULT_SOURCE_NAME, ...context.registered].find((existing) => !isOwn(existing) && sameName(existing, name));
	if (taken !== undefined) return invalid("taken-source", `A source named ${taken} already exists`);
	const entry = context.sourcesEntries.find((existing) => !isOwn(existing) && sameName(existing, name));
	if (entry !== undefined) return invalid("taken-entry", `Sources/${entry} already exists in the vault`);
	return { valid: true };
}

/**
 * PR-11 (G4): the text the Rename dialog and the notice show for a request Tephra didn't carry out. A refusal
 * (`rpc`) is Tephra's own sentence, word for word, without Atlas's "Tephra error:" prefix (so `the name "notes"
 * is taken by the source "notes"` reads as Tephra wrote it). A call that never got an answer is said in Atlas's
 * words: nothing was sent to Tephra's logic, so there is no reason of Tephra's to quote.
 */
export function renameRefusalText(error: { kind: string; message: string }): string {
	if (error.kind === "network" || error.kind === "no-token") return "Tephra isn't running";
	if (error.kind === "timeout") return "Tephra didn't answer in time";
	return error.message.replace(/^Tephra error:\s*/, "");
}
