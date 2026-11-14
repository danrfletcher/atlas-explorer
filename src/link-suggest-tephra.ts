/**
 * G8 — what the `[[` popup asks Tephra: `unit.search` inside one file (the `#` and `^` searches) and
 * `block.ensure_id` (a block without an ID). Wire shapes were read from Tephra's `dev` code
 * (`crates/tephrad/src/search/in_file.rs`, `block_id/mod.rs`), not assumed:
 *
 *   unit.search {query, scope: "headings"|"blocks", in: "@source:rel/path", limit}
 *     -> {unit, scope, offline, text_unavailable, results: [{unit, kind, text?, name?, symbol_kind?,
 *         level?, line?, page?, slide?, paragraph?, index?, block_id?}]}
 *   block.ensure_id {unit, line}  -> {id: string|null, link, created}
 *     an error with the message "file changed, try again" means the file moved under it.
 *
 * Nothing here throws, writes a file or keeps state (F1, F3): every call is one request and its answer.
 */
import type { TephraCallResult, TephraError } from "./tephra-client";

/** The part of `TephraConnection` the popup uses. */
export interface TephraCaller {
	call(method: string, params?: unknown): Promise<TephraCallResult>;
}

export type InFileScope = "headings" | "blocks";

/** One thing inside a file that the popup can offer. */
export interface InFileHit {
	kind: string;
	/** A symbol's name, or a heading's or paragraph's text. Never empty. */
	text: string;
	level: number | null;
	/** 1-based; null for a document's page/slide/paragraph. */
	line: number | null;
	/** `line 9`, `page 2`, ... for the row's second line. */
	place: string;
	symbolKind: string | null;
	/** The `^id` the block already has (without the caret). */
	blockId: string | null;
}

export type InFileSearchResult = { ok: true; hits: InFileHit[] } | { ok: false; message: string };

export type EnsureIdResult = { ok: true; id: string } | { ok: false; message: string };

/** The one-line wording for a failed call. */
export function describeTephraError(error: TephraError): string {
	switch (error.kind) {
		case "network":
		case "no-token":
			return "Tephra offline";
		case "timeout":
			return "Tephra did not answer in time";
		default:
			return error.message;
	}
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function placeOf(hit: Record<string, unknown>): string {
	for (const key of ["line", "page", "slide", "paragraph"]) {
		const n = int(hit[key]);
		if (n !== null) return `${key} ${n}`;
	}
	return "";
}

/** Rows that are not an object, have no text, or (for `blocks`) can neither be linked by an existing ID
 * nor be given one (no line number: a document paragraph) are skipped. */
export function parseInFileHits(result: unknown, scope: InFileScope): InFileHit[] | null {
	if (typeof result !== "object" || result === null) return null;
	const rows = (result as { results?: unknown }).results;
	if (!Array.isArray(rows)) return null;
	const hits: InFileHit[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const hit = row as Record<string, unknown>;
		const kind = str(hit.kind);
		// A code symbol has a `name` and the `text` of its line; show the name. Headings and paragraphs only have `text`.
		const text = str(hit.name) ?? str(hit.text);
		if (kind === null || text === null) continue;
		const line = int(hit.line);
		const blockId = str(hit.block_id);
		if (scope === "blocks" && line === null && blockId === null) continue;
		hits.push({ kind, text, level: int(hit.level), line, place: placeOf(hit), symbolKind: str(hit.symbol_kind), blockId });
	}
	return hits;
}

/** `unit` is `@source:rel/path` with the file's real extension. */
export async function searchInFile(caller: TephraCaller, unit: string, scope: InFileScope, query: string, limit: number): Promise<InFileSearchResult> {
	let answer: TephraCallResult;
	try {
		answer = await caller.call("unit.search", { query, scope, in: unit, limit });
	} catch {
		return { ok: false, message: "Tephra offline" };
	}
	if (!answer.ok) return { ok: false, message: describeTephraError(answer.error) };
	const hits = parseInFileHits(answer.result, scope);
	if (hits === null) return { ok: false, message: "Tephra's search answer was not understood" };
	return { ok: true, hits };
}

/** Asks Tephra to put a block ID on the block at `line` (1-based) and returns it. Tephra writes the
 * file; Atlas never does (F3). */
export async function ensureBlockId(caller: TephraCaller, unit: string, line: number): Promise<EnsureIdResult> {
	let answer: TephraCallResult;
	try {
		answer = await caller.call("block.ensure_id", { unit, line });
	} catch {
		return { ok: false, message: "Tephra offline" };
	}
	if (!answer.ok) return { ok: false, message: describeTephraError(answer.error) };
	const id = typeof answer.result === "object" && answer.result !== null ? str((answer.result as { id?: unknown }).id) : null;
	if (id === null || !/^[A-Za-z0-9-]+$/.test(id)) return { ok: false, message: "Tephra gave no block ID for this line" };
	return { ok: true, id };
}
