/** PR-7 (G17-G19/G22): a from-scratch CSV parser — no CSV library exists anywhere in this codebase.
 * Deliberately not a full RFC4180 validator: it supports the cases the spec actually asks for
 * (quoted fields containing commas/newlines, `""` as an escaped quote, CRLF/LF line endings, a UTF-8
 * BOM, duplicate/blank headers, ragged rows) and treats anything else leniently rather than erroring.
 *
 * The first row is always the header row (G19 — no toggle). Rows are returned as plain
 * `Record<string, string>` objects, the same flat shape `mapSampleRows`/`runJsMapping` already accept
 * for a top-level-array response, so CSV rows flow through that unmodified pipeline with no
 * `arrayField` needed. */

export interface CsvParseOk {
	ok: true;
	rows: Record<string, string>[];
	/** PR-7 (R7 fix): the parsed, deduped header row — present even when there are zero data rows
	 * (header-only file), so a caller that needs field names to configure mapping (the modal's
	 * `loadCsvSample`) doesn't have to derive them from a sample row that doesn't exist. */
	headers: string[];
	/** R2 fix (G22/E3): rows dropped because they were unparseable or lost data — a quote that opens
	 * and is never closed (every row it swallows, not just the trailing one — see
	 * `countLostLineBreaks`), plus any data row with MORE fields than the header row (it can't be
	 * mapped to a key without silently misaligning every field after the extra one, so it's dropped
	 * rather than truncated). A row with FEWER fields than the header is not malformed — it is padded
	 * with empty strings for the missing trailing fields and kept (documented leniency, not a loss). */
	skippedCount: number;
}

export interface CsvParseError {
	ok: false;
	error: string;
}

export type CsvParseOutcome = CsvParseOk | CsvParseError;

interface TokenizeResult {
	/** Each inner array is one row's raw fields, in source order. */
	rows: string[][];
	/** True when the text ends while still inside an open quote — that row's fields (if any were
	 * already completed on the current row) are NOT included in `rows`. */
	unterminatedQuote: boolean;
	/** R2 fix (G22): only meaningful when `unterminatedQuote` is true — how many rows the dangling
	 * open quote swallowed, by the same counting rule `tokenize` itself uses for a well-formed tail:
	 * every line break from the point the quote opened through end-of-file (each would otherwise
	 * have ended a row), plus one more only if the file doesn't already end on a line break (the
	 * final, never-terminated row still needs counting even with nothing after it). */
	rowsLostToUnterminatedQuote: number;
}

/** Counts line breaks in `text[from..)`, treating a CRLF pair as a single break — the same rule
 * `tokenize`'s own row-splitting uses, so this always agrees with how many rows the span would have
 * produced had it been parsed normally. */
function countLineBreaks(text: string, from: number): number {
	let count = 0;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\r") {
			if (text[i + 1] === "\n") i++;
			count++;
		} else if (text[i] === "\n") {
			count++;
		}
	}
	return count;
}

function tokenize(text: string): TokenizeResult {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let quoteOpenIndex = -1;
	let i = 0;
	const n = text.length;

	while (i < n) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}
		// R10 fix (G22/E3): a quote only opens a quoted field when it's the field's very first
		// character — same rule RFC4180 uses. A quote appearing mid-field (e.g. `ab"c`) used to be
		// treated as an opener too, silently merging everything up to the next quote (even across
		// line breaks) into one field and losing whatever row that quote happened to close, uncounted.
		// Treated as a literal character here instead, matching the leniency the rest of this parser
		// already applies elsewhere.
		if (c === '"' && field === "") {
			inQuotes = true;
			quoteOpenIndex = i;
			i++;
			continue;
		}
		if (c === ",") {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (c === "\r") {
			if (text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += c;
		i++;
	}

	if (inQuotes) {
		const lastChar = text[n - 1];
		const endsOnLineBreak = lastChar === "\n" || lastChar === "\r";
		const rowsLostToUnterminatedQuote = countLineBreaks(text, quoteOpenIndex) + (endsOnLineBreak ? 0 : 1);
		return { rows, unterminatedQuote: true, rowsLostToUnterminatedQuote };
	}

	// Flush a final field/row with no trailing newline — skip entirely for a truly empty file so it
	// stays a clean zero-row result rather than one phantom empty row.
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return { rows, unterminatedQuote: false, rowsLostToUnterminatedQuote: 0 };
}

/** Blank headers fall back to "column"; any header (blank-fallback or not) that collides with an
 * earlier one is suffixed `_2`, `_3`, ... so every key `mapSampleRows` sees is unique. */
function dedupeHeaders(headers: string[]): string[] {
	const seen = new Map<string, number>();
	return headers.map((raw) => {
		const base = raw.trim() === "" ? "column" : raw.trim();
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}_${count + 1}`;
	});
}

/** Parses `text` (a whole `.csv` file's contents) into header-keyed row objects. Never throws —
 * every failure mode is reported through the returned `CsvParseOutcome`. */
export function parseCsv(text: string): CsvParseOutcome {
	const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	if (stripped.includes("\u0000")) {
		return { ok: false, error: "This file doesn't look like a CSV text file (it contains binary data)." };
	}

	const { rows: rawRows, unterminatedQuote, rowsLostToUnterminatedQuote } = tokenize(stripped);

	if (unterminatedQuote && rawRows.length === 0) {
		return { ok: false, error: "Couldn't read a header row: a quoted field is opened but never closed." };
	}

	if (rawRows.length === 0) return { ok: true, rows: [], headers: [], skippedCount: 0 };

	const headers = dedupeHeaders(rawRows[0]);
	const dataRows = rawRows.slice(1);
	let skippedCount = unterminatedQuote ? rowsLostToUnterminatedQuote : 0;
	const rows: Record<string, string>[] = [];
	for (const raw of dataRows) {
		// R2 fix (G22/E3): a row with MORE fields than the header can't be mapped to a key without
		// silently misaligning every field after the extra one — dropped and counted rather than
		// truncated. A row with fewer fields is padded (see loop below) and kept, not malformed.
		if (raw.length > headers.length) {
			skippedCount++;
			continue;
		}
		const obj: Record<string, string> = {};
		for (let i = 0; i < headers.length; i++) obj[headers[i]] = raw[i] ?? "";
		rows.push(obj);
	}

	return { ok: true, rows, headers, skippedCount };
}
