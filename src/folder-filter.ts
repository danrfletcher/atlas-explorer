/** PR-1.S1 (G3): a single `key = value` rule from a Folder source's YAML file filter. */
export interface YamlFilterRule {
	key: string;
	value: string;
}

/** G3: `[[X]]` and `[[X|alias]]` compare as `X`. Anything else is returned unchanged. */
function linkTarget(text: string): string {
	const match = /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/.exec(text);
	return match ? match[1].trim() : text;
}

/** G3: the comparable text of a frontmatter scalar, or `undefined` when it has none (null, nested
 * objects, and arrays inside arrays). Numbers, booleans and dates compare as their text. */
function scalarText(value: unknown): string | undefined {
	if (typeof value === "string") return linkTarget(value.trim()).toLowerCase();
	if (typeof value === "number" || typeof value === "boolean") return String(value).toLowerCase();
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return undefined;
}

/** E2: a nested object never matches, so it is treated as having no value at all. */
function isNestedObject(value: unknown): boolean {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/** G3: a non-empty wanted value matches a scalar that equals it, or a list with any item that equals
 * it. Null and `[]` therefore never match a non-empty value. */
function valueMatches(raw: unknown, wanted: string): boolean {
	if (isNestedObject(raw)) return false;
	if (Array.isArray(raw)) return raw.some((item) => scalarText(item) === wanted);
	return scalarText(raw) === wanted;
}

/** G3/E2: one rule against a frontmatter object. Key lookup is case-insensitive. An empty value means
 * "key present", so `key:` with null or `[]` counts, but a nested object does not. If several keys
 * differ only by case, the rule holds when any of them satisfies it. */
function ruleMatches(frontmatter: Record<string, unknown>, rule: YamlFilterRule): boolean {
	const wantedKey = rule.key.trim().toLowerCase();
	const wanted = scalarText(rule.value.trim()) ?? "";
	return Object.keys(frontmatter).some((key) => {
		if (key.toLowerCase() !== wantedKey) return false;
		return wanted === "" ? !isNestedObject(frontmatter[key]) : valueMatches(frontmatter[key], wanted);
	});
}

/** PR-1.F2: how a managed Folder-source row shows under its source's rules. `shown` is an ordinary row,
 * `filteredOut` is greyed with a Remove button (merge), and `hidden` is not rendered at all, its children
 * lifted one level into its place (overwrite, or a hidden-at-save row in merge or overwrite). */
export type FolderRowFilterState = "shown" | "filteredOut" | "hidden";

/** PR-1.F2 (G4/G5/E11): the render-time state of one managed row. `matches` is whether its file currently
 * satisfies the rules. Append never hides a row. Hidden-at-save rows stay hidden in merge and overwrite
 * while they don't match, and a live drop-out shows "filtered out" in merge or is hidden in overwrite. */
export function folderRowFilterState(node: { folderSourceHiddenAtSave?: true }, mode: "append" | "merge" | "overwrite", matches: boolean): FolderRowFilterState {
	if (matches || mode === "append") return "shown";
	if (node.folderSourceHiddenAtSave) return "hidden";
	return mode === "overwrite" ? "hidden" : "filteredOut";
}

/** G3: whether `frontmatter` satisfies every rule (ANDed). Rules with an empty key are ignored, and
 * zero remaining rules means unfiltered, so everything passes. Missing or non-object frontmatter
 * (no cache entry, malformed YAML, body-only file) fails every rule that is left. Pure: reads only
 * its arguments. Callers pass `app.metadataCache` frontmatter, never file content. */
export function matchesYamlRules(frontmatter: unknown, rules: YamlFilterRule[]): boolean {
	const active = rules.filter((rule) => rule.key.trim() !== "");
	if (active.length === 0) return true;
	if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return false;
	const fields = frontmatter as Record<string, unknown>;
	return active.every((rule) => ruleMatches(fields, rule));
}
