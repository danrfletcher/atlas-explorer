/**
 * G8 — the grammar of what is typed after `[[` (or `![[`), as a pure function. No Obsidian imports.
 *
 *   text            own   — the note's own source
 *   @               sources — list the sources (query = what follows `@`, filters source names only)
 *   @wh             sources
 *   @name:text      source  — search the source `name`
 *   @*:text         all     — search every source
 *
 * After the target a `#` (heading) or `^` (block) starts a sub-search inside the chosen file; a `|`
 * starts an alias. The first of the three that appears decides: `[[A|b#c` is an alias that happens to
 * contain `#`, `[[A#b|c` is a heading link with an alias. `|` anywhere sets `alias`. `#^` (Obsidian's
 * block-link spelling, `[[A#^id]]`) counts as the `^` marker, so `[[A#^ab` searches blocks for `ab`.
 */

export type SuggestMode = "own" | "sources" | "source" | "all";

export interface ParsedSuggestQuery {
	mode: SuggestMode;
	/** The source name exactly as typed for `source` (`""` for `[[@:`), `"*"` for `all`, otherwise null. */
	source: string | null;
	/** `own`/`source`/`all`: the file target typed so far (no sigil, no `@name:`). `sources`: the
	 * source-name filter. For an `own` query with no `#`/`^` and an alias this is only the part
	 * before the `|`. */
	query: string;
	/** The `#` or `^` that opened a sub-search before any `|`, or null. */
	marker: "#" | "^" | null;
	/** What follows the marker (up to a `|`); `""` when there is no marker. */
	sub: string;
	/** A `|` appeared somewhere in the query. */
	alias: boolean;
}

export function parseSuggestQuery(raw: string): ParsedSuggestQuery {
	const special = /[#^|]/.exec(raw);
	let head = raw;
	let marker: "#" | "^" | null = null;
	let sub = "";
	let alias = false;
	if (special) {
		head = raw.slice(0, special.index);
		if (special[0] === "|") {
			alias = true;
		} else {
			marker = special[0] as "#" | "^";
			let rest = raw.slice(special.index + 1);
			// `File#^id` is Obsidian's own block-link spelling: the `^` right after the `#` makes it a block search.
			if (marker === "#" && rest.startsWith("^")) {
				marker = "^";
				rest = rest.slice(1);
			}
			const pipe = rest.indexOf("|");
			alias = pipe !== -1;
			sub = pipe === -1 ? rest : rest.slice(0, pipe);
		}
	}

	if (!head.startsWith("@")) return { mode: "own", source: null, query: head, marker, sub, alias };
	const colon = head.indexOf(":");
	if (colon === -1) return { mode: "sources", source: null, query: head.slice(1), marker, sub, alias };
	const name = head.slice(1, colon);
	const query = head.slice(colon + 1);
	if (name === "*") return { mode: "all", source: "*", query, marker, sub, alias };
	return { mode: "source", source: name, query, marker, sub, alias };
}
