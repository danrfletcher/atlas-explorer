/** PR-8 (G17-G20/G22/G24): a from-scratch markdown pipe-table detector/parser — no markdown-table
 * parser exists anywhere in this codebase. Deliberately not a full CommonMark table implementation:
 * it recognizes the standard pipe-table shape the spec asks for (a header row containing `|`,
 * immediately followed by a `|---|---|`-style separator row whose own cell count matches the
 * header's (R4c), then zero or more data rows), skips YAML front matter at the very top of the file
 * and any fenced code block's contents (R4b), handles an escaped `\|` as a literal pipe inside a
 * cell rather than a delimiter (R4a), and never mistakes prose containing a stray `|` for a table
 * (prose is never followed by a matching separator row). Still not handled: a `|` inside inline code
 * (`` `a|b` ``) splits as a delimiter same as any other `|` — doing that properly needs tracking
 * backtick-delimited spans within a row before the pipe-split runs, deferred as a further R4 item.
 *
 * Every table found is returned in source order as a plain `Record<string, string>[]`, the same
 * flat shape `mapSampleRows`/`mapResponseRows`/`runJsMapping` already accept for a top-level-array
 * response — so a selected table's rows flow through that unmodified pipeline with no `arrayField`
 * needed, exactly like CSV's rows (`csv-parsing.ts`).
 *
 * G24/F9 fence: `selectMarkdownTable` is a plain index lookup with no validation against the table
 * that used to be at that index — a stored `tableIndex` that no longer points at "the same" table
 * after a later edit is read as-is, with no drift detection, warning, or re-prompt. */

export interface MarkdownTable {
	headers: string[];
	rows: Record<string, string>[];
	/** G22/E3: rows in this table whose cell count didn't match the header's and were dropped rather
	 * than guessed at — unlike CSV, a markdown table row with too FEW cells is also malformed (there
	 * is no trailing-column padding convention for pipe tables), not just one with too many. */
	skippedCount: number;
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").split("\n");
}

/** Strips a leading YAML front-matter block (`---` ... `---` at the very top of the file) before
 * table scanning ever sees it — otherwise front matter's own closing `---` line could be read as a
 * table's header-separator row if a coincidentally `|`-containing line preceded it. Only recognized
 * when the very first line is exactly `---` and a matching closing `---` line actually exists;
 * anything else (no opening marker, or an opening marker with no close) is left untouched. */
function stripFrontMatter(lines: string[]): string[] {
	if (lines[0]?.trim() !== "---") return lines;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") return lines.slice(i + 1);
	}
	return lines;
}

/** Splits one pipe-table row line into its cell strings: an optional leading/trailing `|` is
 * stripped first (both styles — `| a | b |` and `a | b` — are standard), then the remainder is
 * split on `|` and each cell trimmed.
 *
 * PR-8 (R4a fix): an escaped pipe (`\|`) is a literal `|` inside a cell, not a delimiter — GFM's own
 * rule. Swapped for a sentinel the actual markdown text can never contain before splitting, then
 * swapped back after, so `\|` survives as one literal character per cell rather than splitting the
 * row into one extra (and now misaligned) cell. */
function splitRowCells(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
	const ESCAPED_PIPE_SENTINEL = "\u0000";
	const withSentinel = trimmed.replace(/\\\|/g, ESCAPED_PIPE_SENTINEL);
	return withSentinel.split("|").map((cell) => cell.trim().split(ESCAPED_PIPE_SENTINEL).join("|"));
}

/** A separator row is every cell matching `:?-+:?` (dashes, with optional alignment colons) AND the
 * line containing at least one `|` — the pipe requirement is what keeps a bare prose horizontal
 * rule (`---`, no pipes at all) from ever being misread as a table separator. */
function isSeparatorRow(line: string): boolean {
	if (!line.includes("|")) return false;
	const cells = splitRowCells(line);
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** A line continues an already-open table only while it still contains a `|` and isn't blank —
 * prose or a blank line after the table always ends it, which is also what keeps trailing prose
 * (with no pipes) from ever being folded into the table's rows. */
function isTableRow(line: string): boolean {
	return line.trim() !== "" && line.includes("|");
}

/** Blank headers fall back to "column"; a header colliding with an earlier one in the same table is
 * suffixed `_2`, `_3`, ... — same rule CSV's own `dedupeHeaders` uses, so both key sets look and
 * behave identically to the shared mapping pipeline downstream. */
function dedupeHeaders(headers: string[]): string[] {
	const seen = new Map<string, number>();
	return headers.map((raw) => {
		const base = raw.trim() === "" ? "column" : raw.trim();
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}_${count + 1}`;
	});
}

/** PR-8 (R4b fix): a fenced code block's own lines (between a pair of ` ``` ` or `~~~` fence markers)
 * are never scanned for a table — a code sample that happens to contain `|`-delimited lines (ASCII
 * art, a shell pipeline, a genuinely unrelated pipe table shown as an example) must not be read as a
 * live, editable source table. */
function isFenceMarker(line: string): boolean {
	return /^\s*(```|~~~)/.test(line);
}

/** Finds and parses every standard pipe-table in `text`, in source order. Never throws — a file
 * with no tables at all simply yields an empty array, not an error (there is nothing to fail). */
export function detectMarkdownTables(text: string): MarkdownTable[] {
	const lines = stripFrontMatter(splitLines(text));
	const tables: MarkdownTable[] = [];
	let i = 0;
	let inFence = false;
	while (i < lines.length) {
		if (isFenceMarker(lines[i])) {
			inFence = !inFence;
			i++;
			continue;
		}
		if (inFence) {
			i++;
			continue;
		}
		const headerLine = lines[i];
		const separatorLine = lines[i + 1];
		const headerCells = headerLine.includes("|") ? splitRowCells(headerLine) : [];
		// R4c fix: a separator row whose own cell count doesn't match the header's is not a table at
		// all — without this check, a header with e.g. 3 columns and a 2-column `|---|---|` separator
		// was accepted anyway, misaligning every row parsed under it.
		if (
			headerLine.includes("|") &&
			headerLine.trim() !== "" &&
			separatorLine !== undefined &&
			isSeparatorRow(separatorLine) &&
			splitRowCells(separatorLine).length === headerCells.length
		) {
			const headers = dedupeHeaders(headerCells);
			let j = i + 2;
			const rawRows: string[][] = [];
			while (j < lines.length && isTableRow(lines[j])) {
				rawRows.push(splitRowCells(lines[j]));
				j++;
			}
			let skippedCount = 0;
			const rows: Record<string, string>[] = [];
			for (const raw of rawRows) {
				if (raw.length !== headers.length) {
					skippedCount++;
					continue;
				}
				const obj: Record<string, string> = {};
				for (let k = 0; k < headers.length; k++) obj[headers[k]] = raw[k];
				rows.push(obj);
			}
			tables.push({ headers, rows, skippedCount });
			i = j;
			continue;
		}
		i++;
	}
	return tables;
}

/** G20/G24: a plain index lookup, deliberately with no bounds-checking side effects beyond a safe
 * empty-table fallback — selecting an index that no longer exists (zero tables, or the file was
 * edited so fewer tables remain) never throws or warns, it just reads as empty, same as any other
 * "garbage in, garbage out" source in this codebase. */
export function selectMarkdownTable(tables: MarkdownTable[], index: number): MarkdownTable {
	return tables[index] ?? { headers: [], rows: [], skippedCount: 0 };
}

/** G20: the file's table-index picker prompt is shown only when there's an actual choice to make. */
export function needsTableIndexPrompt(tables: MarkdownTable[]): boolean {
	return tables.length > 1;
}
