import { App, TFile } from "obsidian";
import type { UnitIndex } from "./unit-index";
import { clampRefreshMinutes } from "./api-refresh-timer";
import {
	activeFolderRules,
	basenameForDeletedRef,
	buildFolderSourceChildren,
	diffOutsideChildren,
	fileMatchesFolderRules,
	parentFolderPath,
	reconcileFolderSourceChildDelete,
} from "./folder-source";
import { type FolderRowFilterState, folderRowFilterState, type YamlFilterRule } from "./folder-filter";
import { listOutsideChildren, resolveOutsidePath } from "./folder-source-outside";
import {
	ApiClickAction,
	ApiFieldMapping,
	ApiItemState,
	ApiSourceConfig,
	CsvSourceConfig,
	DEFAULT_VIEW_NAME,
	FolderSourceConfig,
	MarkdownTableSourceConfig,
	PLACEHOLDER_ROW_KIND,
	StatusGovernance,
	Unit,
	UnitRef,
	View,
	ViewNode,
	createEmptyView,
	rewritePathString,
	rewriteRefKeyPath,
	rewriteRefPath,
	unitRefKey,
	unitRefsEqual,
	unitToRef,
} from "./types";

/** PR-1.S1 (T1): whether `metadataCache` had already finished indexing before this plugin instance
 * loaded (e.g. the plugin was re-enabled mid-session). Obsidian fires "resolved" once per indexing
 * pass, so without this a later instance would hold rule-filtered files back until some note changed.
 * `inProgressTaskCount` is not in the public typings, so it is read defensively: when it is absent
 * this stays false and the "resolved" event decides, as before. */
function metadataCacheIdle(app: App): boolean {
	return (app as unknown as { metadataCache?: { inProgressTaskCount?: unknown } }).metadataCache?.inProgressTaskCount === 0;
}

function generateNodeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** R20/E9: a `noteRef` loaded from `data.json` can be any JSON value — validates it actually has the
 * `UnitRef` shape (a known `kind` and a string `path`, plus `subpath` for a block) before it's trusted
 * anywhere else, the same way `sanitizeApiItemState` validates the rest of a row's fields. */
function isValidUnitRef(value: unknown): value is UnitRef {
	if (!value || typeof value !== "object") return false;
	const ref = value as { kind?: unknown; path?: unknown; subpath?: unknown };
	if (typeof ref.path !== "string") return false;
	if (ref.kind === "file" || ref.kind === "folder") return true;
	if (ref.kind === "block") return typeof ref.subpath === "string";
	return false;
}

/** R20/E9: `apiItemState` entries come straight from `data.json` and can each be malformed
 * independently of the container being a well-shaped object — e.g. `{"1": {"id": "1"}}` (no label) or
 * `{"1": 5}`. Left unchecked, a missing/non-string `label` crashes `apiItemMatchesFilter` and
 * `item.label.trim()` (both called on every render/filter keystroke), and a non-string or unparsable
 * `lastSeenAt` renders as "not found, last seen NaN-NaN-NaN". Returns `null` for an entry too broken to
 * repair (not an object, or no string `label`); everything else is dropped field-by-field rather than
 * discarding the whole row. `id` is always retaken from the state map's own key, since that's the
 * value every other lookup (by id) actually keys on. */
function sanitizeApiItemState(raw: unknown, key: string): ApiItemState | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Partial<ApiItemState>;
	if (typeof item.label !== "string") return null;

	const sanitized: ApiItemState = { id: key, label: item.label, kind: PLACEHOLDER_ROW_KIND };
	if (typeof item.secondary === "string") sanitized.secondary = item.secondary;
	if (typeof item.explicitStatusId === "string") sanitized.explicitStatusId = item.explicitStatusId;
	if (isValidUnitRef(item.noteRef)) sanitized.noteRef = item.noteRef;
	if (item.notFound === true) sanitized.notFound = true;
	if (typeof item.lastSeenAt === "string" && !isNaN(new Date(item.lastSeenAt).getTime())) {
		sanitized.lastSeenAt = item.lastSeenAt;
	}
	return sanitized;
}

/** R17/E9: `data.json` is free-form JSON — hand-edited or corrupted, `apiSource` can be missing its
 * `mapping`, and `apiItemOrder`/`apiItemState` can be any shape at all (an object instead of an array,
 * a number, absent). Left unchecked, that crashes `renderApiItems`'s `for...of` over `apiItemOrder`,
 * `mergeApiItems`'s own iteration over the same, and `mapResponseRows` reading `mapping.arrayField` off
 * `undefined`. Called once, here, on load — so every other API-source code path can assume these
 * fields are always well-shaped afterwards instead of re-guarding at every use site. An `apiSource`
 * missing a usable `mapping` is dropped entirely (rather than guessed at — there's no safe default id/
 * label field to invent), but PR-3's G4 means that no longer implies wiping `apiItemState`/
 * `apiItemOrder` too: a Folder can legitimately have rows with no source at all (source removed, or a
 * `data.json` that dropped just the `apiSource` object by hand), and those rows are sanitized on their
 * own merits below, independent of whether `apiSource` survived. */
function sanitizeApiFields(node: ViewNode): void {
	if (node.apiSource) {
		const raw = node.apiSource as Partial<ApiSourceConfig> & { mapping?: Partial<ApiFieldMapping> };
		const mapping = raw.mapping;
		const validMapping = !!mapping && typeof mapping.idField === "string" && typeof mapping.labelField === "string";
		// PR-4/G3: in "js" mode the mapping step is replaced by `jsSource` — a JS-mode source is valid
		// on a usable `jsSource` string, not a usable drag `mapping` (which may never have been touched
		// at all for a source built entirely in JS mode). `mapping` is still sanitized/kept either way
		// (defaulted to empty fields if absent) so a later switch back to drag has something to show,
		// matching "mapping is retained unchanged while in js mode."
		const isJsMode = raw.mappingMode === "js";
		const validJsSource = typeof raw.jsSource === "string";
		const mappingOrJsValid = isJsMode ? validJsSource : validMapping;
		if (typeof raw.url !== "string" || !mappingOrJsValid) {
			node.apiSource = undefined;
		} else {
			// G5b/R6: any out-of-range `refreshEveryMinutes` reaching here some other way (hand-edited
			// `data.json`) is clamped into range rather than rejected outright — including zero and
			// negative values, per the spec's "interval change to below 5 minutes ... is clamped to 5 at
			// load" (clampRefreshMinutes floors at MIN_REFRESH_MINUTES regardless of how far below it the
			// stored value is). A toggle left on with no usable number at all (missing, or not a finite
			// number) is forced off instead of inventing one (there is deliberately no fixed default value
			// for this field).
			const rawMinutes = raw.refreshEveryMinutes;
			const validMinutes = typeof rawMinutes === "number" && Number.isFinite(rawMinutes);
			const refreshEveryMinutes = validMinutes ? clampRefreshMinutes(rawMinutes) : undefined;
			const rawExtras = mapping?.extraFields ?? (mapping as unknown as { extras?: unknown })?.extras;
			const extraFields: Record<string, string> = {};
			if (rawExtras && typeof rawExtras === "object" && !Array.isArray(rawExtras)) {
				for (const [k, v] of Object.entries(rawExtras)) {
					if (typeof k === "string" && typeof v === "string" && /^[a-zA-Z0-9_]+$/.test(k)) {
						extraFields[k] = v;
					}
				}
			}
			const extraFieldsRecord = Object.keys(extraFields).length > 0 ? extraFields : undefined;
			const rawAction = raw.action ?? raw.clickAction;
			const action: ApiClickAction | undefined =
				rawAction === "none" || rawAction === "run-command" || rawAction === "open-attachment" ? rawAction : undefined;
			const command = typeof raw.command === "string" ? raw.command : undefined;
			node.apiSource = {
				url: raw.url,
				method: "GET",
				mapping: {
					idField: typeof mapping?.idField === "string" ? mapping.idField : "",
					labelField: typeof mapping?.labelField === "string" ? mapping.labelField : "",
					secondaryField: typeof mapping?.secondaryField === "string" ? mapping.secondaryField : undefined,
					arrayField: typeof mapping?.arrayField === "string" ? mapping.arrayField : undefined,
					extraFields: extraFieldsRecord,
				},
				mode: raw.mode === "append" ? "append" : raw.mode === "overwrite" ? "overwrite" : "merge",
				refreshOnViewLoad: !!raw.refreshOnViewLoad,
				refreshEveryMinutesEnabled: !!raw.refreshEveryMinutesEnabled && refreshEveryMinutes !== undefined,
				refreshEveryMinutes,
				keepOnEmpty: typeof raw.keepOnEmpty === "boolean" ? raw.keepOnEmpty : undefined,
				confirmBeforeDelete: typeof raw.confirmBeforeDelete === "boolean" ? raw.confirmBeforeDelete : undefined,
				mappingMode: isJsMode ? "js" : undefined,
				jsSource: typeof raw.jsSource === "string" ? raw.jsSource : undefined,
				action,
				clickAction: action,
				command,
			};
		}
	}

	// G4: rows survive a source's removal as plain static rows — sanitize `apiItemState`/`apiItemOrder`
	// whenever either is actually present (or a source exists to have produced them), rather than only
	// when `apiSource` currently exists. PR-7/PR-8: `csvSource`/`markdownTableSource` produce the exact
	// same kind of rows, so this widens the same way for each.
	const hasApiState =
		!!node.apiSource ||
		!!node.csvSource ||
		!!node.markdownTableSource ||
		node.apiItemState !== undefined ||
		node.apiItemOrder !== undefined;
	if (hasApiState) {
		if (!node.apiItemState || typeof node.apiItemState !== "object" || Array.isArray(node.apiItemState)) {
			node.apiItemState = {};
		} else {
			const cleaned: Record<string, ApiItemState> = {};
			for (const [id, raw] of Object.entries(node.apiItemState)) {
				const sanitized = sanitizeApiItemState(raw, id);
				if (sanitized) cleaned[id] = sanitized;
			}
			node.apiItemState = cleaned;
		}
		if (!Array.isArray(node.apiItemOrder)) {
			node.apiItemOrder = Object.keys(node.apiItemState);
		} else {
			node.apiItemOrder = node.apiItemOrder.filter((id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(node.apiItemState, id));
		}
	} else {
		node.apiItemState = undefined;
		node.apiItemOrder = undefined;
	}

	// Cache and the awaiting-confirmation flag are meaningless without a live source — G4's static rows
	// never show a dot at all (that's `explorer-view.ts`'s job, gated on `apiSource`/`csvSource`/
	// `markdownTableSource`, not this). PR-7/PR-8: `csvSource`/`markdownTableSource` share this exact
	// same cache shape with `apiSource`.
	if (node.apiSource || node.csvSource || node.markdownTableSource) {
		if (!node.apiCache || typeof node.apiCache !== "object") node.apiCache = undefined;
		if (typeof node.apiAwaitingConfirmation !== "boolean") node.apiAwaitingConfirmation = undefined;
	} else {
		node.apiCache = undefined;
		node.apiAwaitingConfirmation = undefined;
	}

	sanitizeFolderSource(node);
	sanitizeCsvSource(node);
	sanitizeMarkdownTableSource(node);

	for (const child of node.children) sanitizeApiFields(child);
}

/** PR-4 (G5/G16): `data.json` is free-form JSON — hand-edited or corrupted, `folderSource.path` can
 * be missing/non-string, and `location`/`showFiles`/`showFolders` can be any shape at all. PR-1 (G2):
 * any legacy `refreshOnViewLoad`/`refreshEveryMinutes*` field is dropped silently — Folder sources
 * always refresh live now, so they have no refresh settings to carry. A `folderSource` missing a usable `path` is dropped entirely (mirrors `apiSource`'s own
 * "no usable mapping" rule — there's no safe path to invent); every other field falls back to its own
 * spec'd default (G4: `location` "inside", both show-toggles on) rather than being rejected outright. */
function sanitizeFolderSource(node: ViewNode): void {
	if (!node.folderSource) return;
	const raw = node.folderSource as Partial<FolderSourceConfig>;
	if (typeof raw.path !== "string") {
		node.folderSource = undefined;
		return;
	}
	const rawRemoved = raw.removedRefs;
	const filters = sanitizeFolderFilters(raw.filters);
	node.folderSource = {
		type: "folder",
		location: raw.location === "outside" ? "outside" : "inside",
		path: raw.path,
		showFiles: typeof raw.showFiles === "boolean" ? raw.showFiles : true,
		showFolders: typeof raw.showFolders === "boolean" ? raw.showFolders : true,
		// R1 fix: `unitRefKey` strings the user has removed from this source's managed set — any
		// non-string entry (hand-edited `data.json`) is dropped rather than rejecting the whole list.
		removedRefs: Array.isArray(rawRemoved) ? rawRemoved.filter((key): key is string => typeof key === "string") : undefined,
		// PR-6: same three-value `mode` as `ApiSourceConfig`, same "merge" default on anything else.
		mode: raw.mode === "append" ? "append" : raw.mode === "overwrite" ? "overwrite" : "merge",
		// PR-1.S1: absent (not `undefined`-valued) when no valid rule survives, so the source is unfiltered.
		...(filters ? { filters } : {}),
	};
}

/** PR-1.S1 (G3): `data.json` is free-form JSON, so only well-formed YAML rules are kept. A rule
 * needs a string `key` and a string `value` (a non-string is malformed); the key is trimmed and an
 * empty key is dropped; the value is trimmed, so a whitespace-only value becomes "key present".
 * Anything else (non-object `filters`, non-array `rules`, `null`, non-object entries) is dropped, and
 * when no rule survives `filters` is omitted, which leaves the source unfiltered without throwing. */
export function sanitizeFolderFilters(raw: unknown): FolderSourceConfig["filters"] {
	if (!raw || typeof raw !== "object") return undefined;
	const files = (raw as { files?: unknown }).files;
	if (!files || typeof files !== "object") return undefined;
	const yaml = (files as { yaml?: unknown }).yaml;
	if (!yaml || typeof yaml !== "object") return undefined;
	const rawRules = (yaml as { rules?: unknown }).rules;
	if (!Array.isArray(rawRules)) return undefined;
	const rules: YamlFilterRule[] = [];
	for (const entry of rawRules) {
		if (!entry || typeof entry !== "object") continue;
		const { key, value } = entry as { key?: unknown; value?: unknown };
		if (typeof key !== "string" || typeof value !== "string") continue;
		const trimmedKey = key.trim();
		if (trimmedKey === "") continue;
		rules.push({ key: trimmedKey, value: value.trim() });
	}
	return rules.length > 0 ? { files: { yaml: { rules } } } : undefined;
}

/** PR-7 (G17-G19): `data.json` is free-form JSON — hand-edited or corrupted, `csvSource.path`/
 * `mapping` can be missing/non-string, same as `apiSource` above. A `csvSource` missing a usable
 * `path`, or (in drag mode) a usable `mapping`, is dropped entirely — mirrors `sanitizeApiFields`'s
 * own "no usable mapping" rule, since there's no safe id/label field to invent either way. */
function sanitizeCsvSource(node: ViewNode): void {
	if (!node.csvSource) return;
	const raw = node.csvSource as Partial<CsvSourceConfig> & { mapping?: Partial<ApiFieldMapping> };
	const mapping = raw.mapping;
	const validMapping = !!mapping && typeof mapping.idField === "string" && typeof mapping.labelField === "string";
	const isJsMode = raw.mappingMode === "js";
	const validJsSource = typeof raw.jsSource === "string";
	const mappingOrJsValid = isJsMode ? validJsSource : validMapping;
	if (typeof raw.path !== "string" || !mappingOrJsValid) {
		node.csvSource = undefined;
		return;
	}
	const rawExtras = mapping?.extraFields ?? (mapping as unknown as { extras?: unknown })?.extras;
	const extraFields: Record<string, string> = {};
	if (rawExtras && typeof rawExtras === "object" && !Array.isArray(rawExtras)) {
		for (const [k, v] of Object.entries(rawExtras)) {
			if (typeof k === "string" && typeof v === "string" && /^[a-zA-Z0-9_]+$/.test(k)) extraFields[k] = v;
		}
	}
	const extraFieldsRecord = Object.keys(extraFields).length > 0 ? extraFields : undefined;
	node.csvSource = {
		type: "csv",
		path: raw.path,
		mapping: {
			idField: typeof mapping?.idField === "string" ? mapping.idField : "",
			labelField: typeof mapping?.labelField === "string" ? mapping.labelField : "",
			secondaryField: typeof mapping?.secondaryField === "string" ? mapping.secondaryField : undefined,
			extraFields: extraFieldsRecord,
		},
		mode: raw.mode === "append" ? "append" : raw.mode === "overwrite" ? "overwrite" : "merge",
		keepOnEmpty: typeof raw.keepOnEmpty === "boolean" ? raw.keepOnEmpty : undefined,
		confirmBeforeDelete: typeof raw.confirmBeforeDelete === "boolean" ? raw.confirmBeforeDelete : undefined,
		mappingMode: isJsMode ? "js" : undefined,
		jsSource: typeof raw.jsSource === "string" ? raw.jsSource : undefined,
	};
}

/** PR-8 (G17-G20): `data.json` is free-form JSON — hand-edited or corrupted, `markdownTableSource.
 * path`/`mapping`/`tableIndex` can be missing/non-string/non-numeric, same as `csvSource` above. A
 * `markdownTableSource` missing a usable `path`, or (in drag mode) a usable `mapping`, is dropped
 * entirely — mirrors `sanitizeCsvSource`'s own rule. `tableIndex` falls back to 0 (the only table a
 * single-table file has) rather than being rejected outright — same "fall back to a safe default"
 * treatment every other numeric field here gets, not a validation failure. */
function sanitizeMarkdownTableSource(node: ViewNode): void {
	if (!node.markdownTableSource) return;
	const raw = node.markdownTableSource as Partial<MarkdownTableSourceConfig> & { mapping?: Partial<ApiFieldMapping> };
	const mapping = raw.mapping;
	const validMapping = !!mapping && typeof mapping.idField === "string" && typeof mapping.labelField === "string";
	const isJsMode = raw.mappingMode === "js";
	const validJsSource = typeof raw.jsSource === "string";
	const mappingOrJsValid = isJsMode ? validJsSource : validMapping;
	if (typeof raw.path !== "string" || !mappingOrJsValid) {
		node.markdownTableSource = undefined;
		return;
	}
	const rawExtras = mapping?.extraFields ?? (mapping as unknown as { extras?: unknown })?.extras;
	const extraFields: Record<string, string> = {};
	if (rawExtras && typeof rawExtras === "object" && !Array.isArray(rawExtras)) {
		for (const [k, v] of Object.entries(rawExtras)) {
			if (typeof k === "string" && typeof v === "string" && /^[a-zA-Z0-9_]+$/.test(k)) extraFields[k] = v;
		}
	}
	const extraFieldsRecord = Object.keys(extraFields).length > 0 ? extraFields : undefined;
	const tableIndex = typeof raw.tableIndex === "number" && Number.isInteger(raw.tableIndex) && raw.tableIndex >= 0 ? raw.tableIndex : 0;
	node.markdownTableSource = {
		type: "markdown-table",
		path: raw.path,
		tableIndex,
		mapping: {
			idField: typeof mapping?.idField === "string" ? mapping.idField : "",
			labelField: typeof mapping?.labelField === "string" ? mapping.labelField : "",
			secondaryField: typeof mapping?.secondaryField === "string" ? mapping.secondaryField : undefined,
			extraFields: extraFieldsRecord,
		},
		mode: raw.mode === "append" ? "append" : raw.mode === "overwrite" ? "overwrite" : "merge",
		keepOnEmpty: typeof raw.keepOnEmpty === "boolean" ? raw.keepOnEmpty : undefined,
		confirmBeforeDelete: typeof raw.confirmBeforeDelete === "boolean" ? raw.confirmBeforeDelete : undefined,
		mappingMode: isJsMode ? "js" : undefined,
		jsSource: typeof raw.jsSource === "string" ? raw.jsSource : undefined,
	};
}

/** G9b: resolves the effective click action for a source, defaulting to "open-attachment". */
export function resolveClickAction(source: ApiSourceConfig | undefined | null): ApiClickAction {
	return source?.action ?? source?.clickAction ?? "open-attachment";
}

/** G2: resolves the extra fields mapping for a source, defaulting to empty record. */
export function resolveExtraFields(mapping: ApiFieldMapping | undefined | null): Record<string, string> {
	return mapping?.extraFields ?? {};
}

/** R17/E9: sanitizes every view's tree in place before anything else touches it. */
function sanitizeViewsApiFields(views: View[]): void {
	for (const view of views) {
		for (const node of view.root) sanitizeApiFields(node);
	}
}

/** PR-1.F2 (C25): a duplicated Folder source's managed rows must belong to the copy, not the original, so
 * each source's flags and visibility are decided by its own rules. Rows nested under a managed row keep
 * their owner too, so the whole duplicated subtree is walked. Rows owned by any other source are left alone. */
function remapFolderSourceOwner(nodes: ViewNode[], fromOwnerId: string, toOwnerId: string): void {
	for (const node of nodes) {
		if (node.folderSourceOwnerId === fromOwnerId) node.folderSourceOwnerId = toOwnerId;
		remapFolderSourceOwner(node.children, fromOwnerId, toOwnerId);
	}
}

/** G7: a deep copy of a source config — `duplicateNode`'s clone must never share `mapping` (or any
 * later-added nested object) by reference with the original, or editing one's field mapping would
 * silently edit the other's too. */
function cloneApiSource(source: ApiSourceConfig): ApiSourceConfig {
	return {
		...source,
		mapping: {
			...source.mapping,
			extraFields: source.mapping.extraFields ? { ...source.mapping.extraFields } : undefined,
		},
	};
}

/** PR-1.S1: same deep-copy reasoning as `cloneApiSource`, applied to `folderSource`. `filters` must
 * not share its rule objects with the original, and `removedRefs` is copied too, since it is the same
 * kind of list. */
function cloneFolderSource(source: FolderSourceConfig): FolderSourceConfig {
	return {
		...source,
		removedRefs: source.removedRefs ? [...source.removedRefs] : undefined,
		filters: source.filters ? structuredClone(source.filters) : undefined,
	};
}

/** PR-7: same deep-copy reasoning as `cloneApiSource` above, applied to `csvSource`. */
function cloneCsvSource(source: CsvSourceConfig): CsvSourceConfig {
	return {
		...source,
		mapping: {
			...source.mapping,
			extraFields: source.mapping.extraFields ? { ...source.mapping.extraFields } : undefined,
		},
	};
}

/** PR-8: same deep-copy reasoning as `cloneApiSource` above, applied to `markdownTableSource`. */
function cloneMarkdownTableSource(source: MarkdownTableSourceConfig): MarkdownTableSourceConfig {
	return {
		...source,
		mapping: {
			...source.mapping,
			extraFields: source.mapping.extraFields ? { ...source.mapping.extraFields } : undefined,
		},
	};
}

export interface ApiSourceIdPair {
	originalId: string;
	cloneId: string;
}

/** G7/R3: `cloneNode` deep-copies `apiSource` itself, but the device-local request headers for it live
 * outside this tree entirely, in `ApiHeadersStore` (keyed by node id) — a duplicate's headers have no
 * home in `duplicateNode`'s return value, so the caller (`explorer-view.ts`) walks the original and its
 * clone side by side (identical shape/order — both built by the same `cloneNode` recursion) and copies
 * each sourced node's headers entry across using these pairs. Covers nested sourced Folders in the
 * duplicated subtree too, not just the duplicated node itself. */
export function collectApiSourceNodeIdPairs(original: ViewNode, clone: ViewNode): ApiSourceIdPair[] {
	const pairs: ApiSourceIdPair[] = [];
	if (original.apiSource) pairs.push({ originalId: original.id, cloneId: clone.id });
	for (let i = 0; i < original.children.length; i++) {
		pairs.push(...collectApiSourceNodeIdPairs(original.children[i], clone.children[i]));
	}
	return pairs;
}

/** PR-5 (G6/F6 mirror of R3/G7 above): an Outside-Vault Folder source's device-local absolute path
 * (`FolderSourcePathStore`, keyed by node id) has no home in `duplicateNode`'s return value either —
 * same id-pairing approach, scoped to `folderSource?.location === "outside"` instead of `apiSource`. */
export function collectOutsideFolderSourceNodeIdPairs(original: ViewNode, clone: ViewNode): ApiSourceIdPair[] {
	const pairs: ApiSourceIdPair[] = [];
	if (original.folderSource?.location === "outside") pairs.push({ originalId: original.id, cloneId: clone.id });
	for (let i = 0; i < original.children.length; i++) {
		pairs.push(...collectOutsideFolderSourceNodeIdPairs(original.children[i], clone.children[i]));
	}
	return pairs;
}

/** G7 (extended to G4's static rows): a deep copy of a Folder's per-id row state — `noteRef` is itself
 * an object, so a shallow copy of the map would still leave both copies' rows pointing at (and able to
 * mutate) the very same `UnitRef`. */
function cloneApiItemState(state: Record<string, ApiItemState>): Record<string, ApiItemState> {
	const out: Record<string, ApiItemState> = {};
	for (const [id, item] of Object.entries(state)) {
		out[id] = { ...item, noteRef: item.noteRef ? { ...item.noteRef } : item.noteRef };
	}
	return out;
}

/** G4/T2: a Folder has API rows to show — either a live source (even before its first refresh
 * fills any rows) or static rows left behind by "Remove data source" — gated on this, never on
 * `apiSource` alone, so removing the source doesn't also hide the rows it leaves behind. PR-7:
 * `csvSource` is the same kind of live source as `apiSource` for this purpose. PR-8: so is
 * `markdownTableSource`. */
export function nodeHasApiRows(node: Pick<ViewNode, "apiSource" | "csvSource" | "markdownTableSource" | "apiItemOrder">): boolean {
	return (
		Boolean(node.apiSource) ||
		Boolean(node.csvSource) ||
		Boolean(node.markdownTableSource) ||
		Boolean(node.apiItemOrder && node.apiItemOrder.length > 0)
	);
}

/** PR-1 (G11a): every bucket node can hold a data source — an Atlas folder (meta), a unit (file, module,
 * block or promoted folder). One predicate serves every source setter, `refreshFolderSource`, and the
 * explorer's source walks, so no call site needs to know which kind of node it was handed. */
export function canHoldSource(node: Pick<ViewNode, "type">): boolean {
	return node.type === "meta" || node.type === "unit";
}

export interface MetaTarget {
	id: string | null;
	label: string;
}

/** Every meta folder in a view's tree, breadcrumb-labelled, for "Place in view ▸" pickers. */
export function flattenMetaFolders(nodes: ViewNode[], trail: string[] = []): MetaTarget[] {
	const out: MetaTarget[] = [];
	for (const node of nodes) {
		if (node.type !== "meta") continue;
		const label = [...trail, node.label ?? ""].join(" › ");
		out.push({ id: node.id, label });
		out.push(...flattenMetaFolders(node.children, [...trail, node.label ?? ""]));
	}
	return out;
}

interface FoundNode {
	node: ViewNode;
	siblings: ViewNode[];
	index: number;
}

/** A managed row found by `ViewsManager.collectManagedMatches`: its parent list, its slot there, and how
 * deep it sits in the view. */
type ManagedMatch = { list: ViewNode[]; index: number; node: ViewNode; depth: number };

/**
 * F9 — views (named arrangements of units into a bucket tree) with storage/integrity. The bucket
 * is a drawing over the vault, never a second copy of it: placing/removing/reparenting a node here
 * never touches the filesystem (Part 7's own warning) — the only paths that do are F3/F4's
 * `createInterfaceNote`/`Add block`, both outside this file entirely.
 */
export class ViewsManager {
	private views: View[];
	private activeViewId: string;
	private changeListeners = new Set<() => void>();
	/** PR-1.S1 (E10): false until `metadataCache` has resolved, seeded in the constructor (T1). */
	private metadataResolved: boolean;

	constructor(private app: App, initialViews: View[], initialActiveViewId: string, private persist: () => void) {
		sanitizeViewsApiFields(initialViews);
		this.views = initialViews.length > 0 ? initialViews : [createEmptyView(generateNodeId(), DEFAULT_VIEW_NAME)];
		this.activeViewId = this.views.some((v) => v.id === initialActiveViewId) ? initialActiveViewId : this.views[0].id;
		this.metadataResolved = metadataCacheIdle(app);
	}

	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	private save(): void {
		this.persist();
		this.notifyChange();
	}

	/** Re-renders listeners without persisting anything — for a change that is only visible on screen
	 * (e.g. an Outside-Vault source's unresolved/reconnected state), which `save` alone would skip. */
	private notifyChange(): void {
		for (const cb of this.changeListeners) cb();
	}

	getViews(): View[] {
		return this.views;
	}

	getActiveViewId(): string {
		return this.activeViewId;
	}

	getActiveView(): View {
		return this.views.find((v) => v.id === this.activeViewId) ?? this.views[0];
	}

	getView(id: string): View | undefined {
		return this.views.find((v) => v.id === id);
	}

	setActiveViewId(id: string): void {
		if (!this.views.some((v) => v.id === id) || id === this.activeViewId) return;
		this.activeViewId = id;
		this.save();
	}

	/** F9 edge case: view names must be unique (case-insensitive, so "Default"/"default" collide). */
	private nameTaken(name: string, excludingId?: string): boolean {
		const lower = name.trim().toLowerCase();
		return this.views.some((v) => v.id !== excludingId && v.name.toLowerCase() === lower);
	}

	createView(name: string): View | null {
		const trimmed = name.trim();
		if (!trimmed || this.nameTaken(trimmed)) return null;
		const view = createEmptyView(generateNodeId(), trimmed);
		this.views.push(view);
		this.save();
		return view;
	}

	renameView(id: string, name: string): boolean {
		const trimmed = name.trim();
		const view = this.getView(id);
		if (!trimmed || !view || this.nameTaken(trimmed, id)) return false;
		view.name = trimmed;
		this.save();
		return true;
	}

	/** F9 edge case: deleting the last view recreates "Default". */
	deleteView(id: string): void {
		this.views = this.views.filter((v) => v.id !== id);
		if (this.views.length === 0) {
			this.views.push(createEmptyView(generateNodeId(), DEFAULT_VIEW_NAME));
		}
		if (this.activeViewId === id) {
			this.activeViewId = this.views[0].id;
		}
		this.save();
	}

	private findNode(nodes: ViewNode[], nodeId: string): FoundNode | null {
		for (let i = 0; i < nodes.length; i++) {
			if (nodes[i].id === nodeId) return { node: nodes[i], siblings: nodes, index: i };
			const found = this.findNode(nodes[i].children, nodeId);
			if (found) return found;
		}
		return null;
	}

	/** R9(b): an Outside-Vault-managed child's `ref.path` is a bare name relative to its source's
	 * root (see `listOutsideChildrenWith`), not a vault path — it can collide with a real vault-root
	 * unit of the same name. Every ref-identity walk below (`findUnitNode`/`allPathsToRef`) must skip
	 * these nodes, or a real vault unit wrongly counts as "placed" (and vanishes from the Inbox)
	 * whenever some Outside source happens to have a same-named child. `root` is the whole view's
	 * tree, not just the subtree currently being walked, since a managed child can be dragged/nested
	 * anywhere in the view (R1 fix) — its owner is looked up by id across the full tree, never assumed
	 * to be an ancestor. */
	private isOutsideOwned(root: ViewNode[], node: ViewNode): boolean {
		if (!node.folderSourceManaged || !node.folderSourceOwnerId) return false;
		const owner = this.findNode(root, node.folderSourceOwnerId);
		return owner?.node.folderSource?.location === "outside";
	}

	private findUnitNode(nodes: ViewNode[], ref: UnitRef, root: ViewNode[] = nodes): FoundNode | null {
		for (let i = 0; i < nodes.length; i++) {
			if (nodes[i].type === "unit" && nodes[i].ref && unitRefsEqual(nodes[i].ref as UnitRef, ref) && !this.isOutsideOwned(root, nodes[i])) {
				return { node: nodes[i], siblings: nodes, index: i };
			}
			const found = this.findUnitNode(nodes[i].children, ref, root);
			if (found) return found;
		}
		return null;
	}

	isPlaced(viewId: string, ref: UnitRef): boolean {
		const view = this.getView(viewId);
		return !!view && this.findUnitNode(view.root, ref) !== null;
	}

	isPlacedAnywhere(ref: UnitRef): boolean {
		return this.views.some((v) => this.findUnitNode(v.root, ref) !== null);
	}

	/** PR-1.F1: every unit ref key placed in any view, collected in one walk. The "+" picker tests
	 * each candidate against this Set rather than calling `isPlacedAnywhere` per folder (a tree walk
	 * each time). Skips the same Outside-owned nodes `findUnitNode` skips. */
	placedRefKeys(): Set<string> {
		const keys = new Set<string>();
		const collect = (nodes: ViewNode[], root: ViewNode[]): void => {
			for (const node of nodes) {
				if (node.type === "unit" && node.ref && !this.isOutsideOwned(root, node)) keys.add(unitRefKey(node.ref));
				collect(node.children, root);
			}
		};
		for (const view of this.views) collect(view.root, view.root);
		return keys;
	}

	/** Every placement of this ref across every view, as breadcrumb-able (view name, meta-folder
	 * path) pairs. PR 13: one entry per *placement*, not per view — duplicating a unit can now put
	 * it in more than one spot within the very same view, and the old first-match-only walk would
	 * have silently under-reported that (only ever showing one of the two, or more, placements). */
	getPlacements(ref: UnitRef): { viewName: string; path: string[] }[] {
		const placements: { viewName: string; path: string[] }[] = [];
		for (const view of this.views) {
			for (const path of this.allPathsToRef(view.root, ref, [])) {
				placements.push({ viewName: view.name, path });
			}
		}
		return placements;
	}

	/** PR 12: a unit can now be a meta-nesting parent too, not just meta folders — walked here using
	 * its own basename as the breadcrumb segment rather than the fully-resolved display text
	 * `resolveRef` would give (that needs async work this synchronous path-builder has no access
	 * to; a raw basename is a reasonable stand-in for a tooltip trail). Without this, a unit placed
	 * under another unit would silently report as "not placed anywhere" here, even though it is.
	 * PR 13: collects *every* match in the subtree instead of stopping at the first — a duplicated
	 * unit can now legitimately appear more than once in the same view, including nested inside a
	 * different placement of itself. */
	private allPathsToRef(nodes: ViewNode[], ref: UnitRef, trail: string[], root: ViewNode[] = nodes): string[][] {
		const out: string[][] = [];
		for (const node of nodes) {
			if (node.type === "unit" && node.ref && unitRefsEqual(node.ref, ref) && !this.isOutsideOwned(root, node)) out.push(trail);
			if (node.type === "meta") {
				out.push(...this.allPathsToRef(node.children, ref, [...trail, node.label ?? ""], root));
			} else if (node.type === "unit" && node.ref && node.children.length > 0) {
				const basename = node.ref.path.split("/").pop() ?? node.ref.path;
				out.push(...this.allPathsToRef(node.children, ref, [...trail, basename], root));
			}
		}
		return out;
	}

	/** Places `ref` under `parentId` (or bucket root if null). Moves it if already placed elsewhere
	 * in this view, rather than creating a duplicate node for the same unit. PR 13 review (A16): the
	 * "already placed" branch used to splice out that instance and replace it with a brand-new node
	 * (`children: []`), discarding whatever it had — dead code before duplication existed (only one
	 * placement per ref per view was ever possible), now reachable: "Place in view…" onto a ref that
	 * has meta-nested children silently dropped the subtree. Fixed the same way `handleDrop`'s
	 * reparent path and `unplaceUnit` already were — move the real node in place instead of
	 * discarding and recreating it, so its id/children travel with it. */
	placeUnit(viewId: string, ref: UnitRef, parentId: string | null): void {
		const view = this.getView(viewId);
		if (!view) return;
		const existing = this.findUnitNode(view.root, ref);
		const parent = parentId ? this.findNode(view.root, parentId) : null;
		const targetChildren = parent ? parent.node.children : view.root;
		if (existing) {
			const [node] = existing.siblings.splice(existing.index, 1);
			targetChildren.push(node);
		} else {
			const node: ViewNode = { id: generateNodeId(), type: "unit", ref, children: [] };
			targetChildren.push(node);
		}
		this.save();
	}

	/** Removes *every* placement of `ref` in this view — used when the ref itself has stopped being
	 * a valid unit (demoted/deleted) and needs purging wherever it appears, not just one instance.
	 * PR 13: a duplicated unit can now legitimately have more than one placement in the same view,
	 * so this loops until none are left rather than stopping after the first match (which used to
	 * leave stale duplicates behind). For removing one specific row the user is actually looking at,
	 * use `unplaceNode` instead — this one doesn't know or care which instance you meant. PR 12: each
	 * removal promotes that instance's own children up one level, the same rule `deleteMetaFolder`
	 * already applies for meta folders — nothing organizational should silently vanish. */
	unplaceUnit(viewId: string, ref: UnitRef): void {
		const view = this.getView(viewId);
		if (!view) return;
		let changed = false;
		let found = this.findUnitNode(view.root, ref);
		while (found) {
			found.siblings.splice(found.index, 1, ...found.node.children);
			changed = true;
			found = this.findUnitNode(view.root, ref);
		}
		if (changed) this.save();
	}

	/** Removes one specific node instance by id, regardless of what other placements of the same
	 * unit (if any, via PR 13's duplication) might also exist — this is what "Remove from view",
	 * the Delete key, and dragging a row back to the inbox all actually mean: get rid of *this* row,
	 * not every copy of the unit it happens to reference. Same children-promotion rule as
	 * `unplaceUnit`/`deleteMetaFolder`. */
	unplaceNode(viewId: string, nodeId: string): void {
		const view = this.getView(viewId);
		if (!view) return;
		const found = this.findNode(view.root, nodeId);
		if (!found) return;
		this.rememberFolderSourceRemoval(view, found.node);
		found.siblings.splice(found.index, 1, ...found.node.children);
		this.save();
	}

	/** R1 fix: when a Folder-source-managed row is removed from the view entirely (not moved or
	 * renested elsewhere, which `refreshFolderSource`'s whole-view search already tolerates without
	 * this), remembers its ref on the owning source's `removedRefs` so the next refresh treats it as
	 * "the user removed this," not "never resolved yet," and doesn't recreate it — the same permanence
	 * any other removal in this codebase already has. No-op for a node that isn't Folder-source-managed,
	 * or whose owning node no longer carries a Folder source. */
	private rememberFolderSourceRemoval(view: View, node: ViewNode): void {
		if (!node.folderSourceManaged || !node.ref || !node.folderSourceOwnerId) return;
		// PR-1.F2 (F4/G7): removing a "filtered out" row never blocks it. If it matches again, it returns as
		// a fresh row on the next refresh, so nothing is remembered.
		if (this.managedRowFilterState(view.id, node) === "filteredOut") return;
		const owner = this.findNode(view.root, node.folderSourceOwnerId);
		const source = owner?.node.folderSource;
		if (!source) return;
		const key = unitRefKey(node.ref);
		if (!source.removedRefs) source.removedRefs = [key];
		else if (!source.removedRefs.includes(key)) source.removedRefs.push(key);
	}

	/** PR-1.F2 (G5/G6/E11): the render-time state of one managed row under its Folder source's YAML rules,
	 * read from the metadata cache on every call and never stored. Before the cache resolves, a row of a
	 * rule-filtered source is `hidden`, so no unfiltered row flashes (E10). A row whose file is gone keeps
	 * its normal look, since the existing delete rule owns that case. */
	managedRowFilterState(viewId: string, node: ViewNode): FolderRowFilterState {
		if (!node.folderSourceManaged || node.type !== "unit" || node.ref?.kind !== "file" || !node.folderSourceOwnerId) return "shown";
		const source = this.getNode(viewId, node.folderSourceOwnerId)?.folderSource;
		const rules = source && source.location === "inside" ? activeFolderRules(source) : [];
		if (!source || rules.length === 0) return "shown";
		if (!this.metadataResolved) return "hidden";
		const matches = this.rowMatches(node, rules);
		if (matches === undefined) return "shown";
		return folderRowFilterState(node, source.mode ?? "merge", matches);
	}

	/** PR-1.F2: whether a managed file row's file currently satisfies `rules`. `undefined` when the file is
	 * not in the vault (deleted or missing), so the caller leaves the row alone. Frontmatter comes from
	 * `metadataCache` only. */
	private rowMatches(node: ViewNode, rules: YamlFilterRule[]): boolean | undefined {
		const file = node.ref ? this.app.vault.getAbstractFileByPath(node.ref.path) : null;
		if (!(file instanceof TFile)) return undefined;
		return fileMatchesFolderRules(file, rules, (f) => this.app.metadataCache.getFileCache(f)?.frontmatter);
	}

	/** PR-1.F2 (G4): Save with changed rules sets or clears each managed row of this owner. A row that
	 * doesn't match is flagged hidden-at-save in merge and overwrite, and append never hides a row. A row
	 * that matches is unflagged, and every row is unflagged once no rules remain. Mode changes alone do
	 * not re-flag anything, so E11's render-time mode switch stays as it is. */
	private applyRulesToHiddenAtSave(view: View, ownerId: string, source: FolderSourceConfig | undefined): void {
		const rules = source && source.location === "inside" ? activeFolderRules(source) : [];
		const walk = (nodes: ViewNode[]): void => {
			for (const node of nodes) {
				if (node.folderSourceManaged && node.type === "unit" && node.ref?.kind === "file" && node.folderSourceOwnerId === ownerId) {
					const matches = rules.length === 0 ? true : this.rowMatches(node, rules);
					if (matches === true) delete node.folderSourceHiddenAtSave;
					else if (matches === false && source?.mode !== "append") node.folderSourceHiddenAtSave = true;
				}
				walk(node.children);
			}
		};
		walk(view.root);
	}

	/** PR-1.F2 (G6): unflags every managed file row that matches again, in every view or in one owner's
	 * rows only. Returns whether anything changed, so a caller saves only when there is something to save. */
	private clearMatchedHiddenAtSave(views: View[], ownerId?: string): boolean {
		let changed = false;
		for (const view of views) {
			const owners = new Map<string, FolderSourceConfig>();
			const index = (nodes: ViewNode[]): void => {
				for (const node of nodes) {
					if (node.folderSource?.location === "inside") owners.set(node.id, node.folderSource);
					index(node.children);
				}
			};
			index(view.root);
			const walk = (nodes: ViewNode[]): void => {
				for (const node of nodes) {
					const source = node.folderSourceOwnerId ? owners.get(node.folderSourceOwnerId) : undefined;
					if (node.folderSourceHiddenAtSave && source && (ownerId === undefined || node.folderSourceOwnerId === ownerId)) {
						const rules = activeFolderRules(source);
						if (rules.length === 0 || this.rowMatches(node, rules) === true) {
							delete node.folderSourceHiddenAtSave;
							changed = true;
						}
					}
					walk(node.children);
				}
			};
			walk(view.root);
		}
		return changed;
	}

	addMetaFolder(viewId: string, parentId: string | null, label: string): ViewNode | null {
		const view = this.getView(viewId);
		if (!view) return null;
		const node: ViewNode = { id: generateNodeId(), type: "meta", label: label.trim() || "New folder", children: [] };
		const parent = parentId ? this.findNode(view.root, parentId) : null;
		(parent ? parent.node.children : view.root).push(node);
		this.save();
		return node;
	}

	renameMetaFolder(viewId: string, nodeId: string, label: string): boolean {
		const trimmed = label.trim();
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!trimmed || !found || found.node.type !== "meta") return false;
		found.node.label = trimmed;
		this.save();
		return true;
	}

	/** Deleting a meta folder moves its children up one level, at the position it occupied — never
	 * deletes the children themselves, and never touches disk (they're labels, not folders). */
	deleteMetaFolder(viewId: string, nodeId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || found.node.type !== "meta") return;
		found.siblings.splice(found.index, 1, ...found.node.children);
		this.save();
	}

	/** PR 13: deep-clones a node (unit or meta) — including its whole meta-nested subtree, if it
	 * has one — as a new sibling immediately after the original. New node ids throughout, but every
	 * clone still points at the same underlying unit (`ref`) or carries the same `label` as its
	 * original counterpart, and never touches disk. Grilled with Dan directly: no naming/numbering
	 * scheme — there's no non-fake way to give two siblings that reference the same disk path
	 * different display names, so duplicate labels are allowed outright rather than inventing a
	 * "meta name" override field just for this. */
	duplicateNode(viewId: string, nodeId: string): ViewNode | null {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return null;
		const clone = this.cloneNode(found.node);
		found.siblings.splice(found.index + 1, 0, clone);
		this.save();
		return clone;
	}

	/** PR 18: a duplicate keeps the same status assignment its original had at the moment of
	 * duplication (grilled default from TASKS.md, resolved during this PR's build — no reason for a
	 * clone to start "blank" when everything else about it, including its own children, is copied).
	 * The shallow `{ ...node }` spread is enough for every scalar `StatusGovernance` field
	 * (`statusEnabled`, `statusSetId`, `inheritToSubfolders`, `explicitStatusId`, the hide flags), but
	 * `applyTo`/`truncatedStatuses` are objects — spreading would leave the clone sharing the *same*
	 * object reference as the original. Every write site (`modals.ts`, `updateStatusGovernance`)
	 * happens to replace that reference wholesale rather than mutating in place, so this wouldn't
	 * currently cause a visible bug either way — but a clone silently entangled with its original is
	 * a landmine for the next person to touch this, so copy them explicitly rather than lean on that.
	 *
	 * G7: the same shallow-spread hazard applies to a Folder's API fields, and here it *was* live —
	 * `apiSource`/`apiItemState`/`apiItemOrder` would otherwise be the very same objects on both nodes,
	 * so editing one's mapping or an item's status would silently edit the other's too. A duplicate's
	 * source is deep-copied; its cache and rows are never carried over at all (G7: "copy starts with
	 * grey dot, no rows until first refresh") — a node with leftover static rows but no source (G4) still
	 * gets its own independent copy of those, for the same reference-sharing reason. */
	private cloneNode(node: ViewNode): ViewNode {
		const clone: ViewNode = {
			...node,
			id: generateNodeId(),
			applyTo: node.applyTo ? { ...node.applyTo } : node.applyTo,
			truncatedStatuses: node.truncatedStatuses ? { ...node.truncatedStatuses } : node.truncatedStatuses,
			children: node.children.map((child) => this.cloneNode(child)),
		};

		if (node.apiSource) {
			clone.apiSource = cloneApiSource(node.apiSource);
			clone.apiItemState = {};
			clone.apiItemOrder = [];
		} else if (node.csvSource) {
			// PR-7: same reference-sharing hazard and "copy starts with grey dot, no rows until first
			// refresh" rule as `apiSource` above.
			clone.csvSource = cloneCsvSource(node.csvSource);
			clone.apiItemState = {};
			clone.apiItemOrder = [];
		} else if (node.markdownTableSource) {
			// PR-8: same reference-sharing hazard and "copy starts with grey dot, no rows until first
			// refresh" rule as `apiSource`/`csvSource` above.
			clone.markdownTableSource = cloneMarkdownTableSource(node.markdownTableSource);
			clone.apiItemState = {};
			clone.apiItemOrder = [];
		} else if (node.apiItemState) {
			clone.apiItemState = cloneApiItemState(node.apiItemState);
			clone.apiItemOrder = node.apiItemOrder ? [...node.apiItemOrder] : [];
		}
		clone.apiCache = undefined;
		clone.apiAwaitingConfirmation = undefined;

		// PR-4: same reference-sharing hazard as `apiSource` above — a shallow `{...node}` spread
		// would leave both nodes' `folderSource` pointing at the very same object.
		clone.folderSource = node.folderSource ? cloneFolderSource(node.folderSource) : node.folderSource;
		if (node.folderSource) remapFolderSourceOwner(clone.children, node.id, clone.id);

		return clone;
	}

	private isSameOrDescendant(node: ViewNode, targetId: string): boolean {
		if (node.id === targetId) return true;
		return node.children.some((child) => this.isSameOrDescendant(child, targetId));
	}

	/** Reparents/reorders any node (unit or meta) within the bucket. Refuses a node being dropped
	 * into its own descendant, or onto itself (Part 4 edge case / PR 12 — would disconnect the tree
	 * or self-reference). PR 12: any node can now be a parent, not just meta folders — meta-nesting
	 * via drop (issue 3) lets a module/file/block become an organizational parent the same way a
	 * meta folder already could, without a real disk move. */
	moveNode(viewId: string, nodeId: string, newParentId: string | null, index: number): boolean {
		const view = this.getView(viewId);
		if (!view) return false;
		const found = this.findNode(view.root, nodeId);
		if (!found) return false;
		if (newParentId && this.isSameOrDescendant(found.node, newParentId)) return false;

		const newParent = newParentId ? this.findNode(view.root, newParentId) : null;
		if (newParentId && !newParent) return false;

		found.siblings.splice(found.index, 1);
		const targetChildren = newParent ? newParent.node.children : view.root;
		targetChildren.splice(Math.max(0, Math.min(index, targetChildren.length)), 0, found.node);
		this.save();
		return true;
	}

	/** PR-4 (G4/G5): `unitIndex` is optional only so existing callers/tests that predate dismiss state
	 * keep compiling unchanged — every real caller passes it. A row is excluded once dismissed per the
	 * OR-check `UnitIndex.isDismissed` already implements: global mode only ever reads the global
	 * dismiss set (so a non-Global dismiss never hides a row from Global, per G4's "no over-broad
	 * write"), while view mode reads that view's own set OR'd with the global set (so a Global-view
	 * dismiss cascades here without this method needing to enumerate views itself). */
	getInboxUnits(allUnits: Unit[], viewId: string, mode: "view" | "global", unitIndex?: UnitIndex): Unit[] {
		const placed =
			mode === "global"
				? allUnits.filter((u) => !this.isPlacedAnywhere(unitToRef(u)))
				: allUnits.filter((u) => !this.isPlaced(viewId, unitToRef(u)));
		if (!unitIndex) return placed;
		return placed.filter((u) => {
			const ref = unitToRef(u);
			if (unitIndex.isLinkOnlyInNoAutoPromoteFolder(u)) return false;
			return mode === "global" ? !unitIndex.isDismissed(ref, "global") : !unitIndex.isDismissed(ref, "view", viewId);
		});
	}

	/** PR-5 (G8): the complement of `getInboxUnits` — same placed-filter, but returns only units
	 * dismissed for this scope, so "Show Dismissed" can reveal exactly the rows the plain inbox
	 * excludes. Shares the same mode semantics as `getInboxUnits` (global reads only the global
	 * dismiss set; view reads that view's own set OR'd with global), so toggling never reveals a row
	 * that `getInboxUnits` wouldn't otherwise have hidden for the same `(viewId, mode)`. */
	getDismissedInboxUnits(allUnits: Unit[], viewId: string, mode: "view" | "global", unitIndex: UnitIndex): Unit[] {
		const placed =
			mode === "global"
				? allUnits.filter((u) => !this.isPlacedAnywhere(unitToRef(u)))
				: allUnits.filter((u) => !this.isPlaced(viewId, unitToRef(u)));
		return placed.filter((u) => {
			const ref = unitToRef(u);
			if (unitIndex.isLinkOnlyInNoAutoPromoteFolder(u)) return false;
			return mode === "global" ? unitIndex.isDismissed(ref, "global") : unitIndex.isDismissed(ref, "view", viewId);
		});
	}

	setNodeCollapsed(viewId: string, nodeId: string, collapsed: boolean): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.collapsed = collapsed;
		this.save();
	}

	/** PR 15: this node's minimal status assignment (master toggle + which set) governing its own
	 * *direct children* — never this node's own displayed status (Dan's spec: "the statuses apply
	 * to the first direct children under that item"). `statusSetId: null` clears the assignment's
	 * set without necessarily disabling it (the "Statuses" modal keeps the toggle's state
	 * independent of whether a set has been chosen yet, matching PR 17's later "greyed out until
	 * master toggle on" framing). */
	setNodeStatus(viewId: string, nodeId: string, enabled: boolean, statusSetId: string | null): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.statusEnabled = enabled;
		found.node.statusSetId = statusSetId ?? undefined;
		this.save();
	}

	/** PR 16: which status within its *governor's* set this exact node currently shows — set from
	 * the status-picker popup opened by clicking the node's own dot. No "clear" path (grilled: the
	 * reference plugin's own equivalent is dead code, never wired to any UI) — reverting to the
	 * governor's default is just picking that status from the same popup like any other choice. */
	setExplicitStatus(viewId: string, nodeId: string, statusId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.explicitStatusId = statusId;
		this.save();
	}

	getNode(viewId: string, nodeId: string): ViewNode | null {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		return found ? found.node : null;
	}

	/** PR 17: a governor is either a specific node (`nodeId` set — right-clicked from the bucket) or
	 * the view root itself (`nodeId: null` — right-clicked from the view-name selector). Both are
	 * `StatusGovernance` and behave identically to `resolveNodeStatus`'s own ancestor walk; these two
	 * methods are just the read/write side, generic over which kind of governor is being edited so
	 * the "Statuses" modal doesn't need two parallel code paths for what's otherwise the same UI. */
	getStatusGovernance(viewId: string, nodeId: string | null): StatusGovernance | null {
		if (nodeId === null) return this.getView(viewId) ?? null;
		return this.getNode(viewId, nodeId);
	}

	updateStatusGovernance(viewId: string, nodeId: string | null, patch: Partial<StatusGovernance>): void {
		const target: StatusGovernance | null = nodeId === null ? this.getView(viewId) ?? null : this.getNode(viewId, nodeId);
		if (!target) return;
		Object.assign(target, patch);
		this.save();
	}

	/** PR 12: also collapses unit nodes that have gained meta-nested children — meta folders always
	 * collapse here regardless of child count (existing behavior, a folder is always a foldable
	 * concept even empty), but a unit only ever shows a chevron once it actually has a child (Q5),
	 * so collapsing a childless one would be a no-op with nothing to reflect it visually anyway. */
	collapseAll(viewId: string): void {
		const view = this.getView(viewId);
		if (!view) return;
		const walk = (nodes: ViewNode[]) => {
			for (const node of nodes) {
				if (node.type === "meta" || node.children.length > 0) {
					node.collapsed = true;
					walk(node.children);
				}
			}
		};
		walk(view.root);
		this.save();
	}

	setInboxMode(viewId: string, mode: "view" | "global"): void {
		const view = this.getView(viewId);
		if (!view || view.inboxMode === mode) return;
		view.inboxMode = mode;
		this.save();
	}

	/** Create Module on a root file: every node (every view, every duplicate) referencing the file
	 * becomes a module node, keeping id, position, fold state, status settings and children. Also
	 * matches `<folder>/<folder>.md`, so it gives the same result before or after the rename hook.
	 * With `unitIndex`, manual promotions are converted too. Data-only (never touches disk); saves
	 * and notifies once, and not at all when nothing matched. Block refs are left to the rename hook. */
	convertFileNodesToModule(filePath: string, folderPath: string, unitIndex?: UnitIndex): { nodes: number; manualPromotions: number } {
		const interfacePath = `${folderPath}/${folderPath.split("/").pop()}.md`;
		let nodes = 0;
		const walk = (list: ViewNode[]) => {
			for (const node of list) {
				const ref = node.ref;
				if (node.type === "unit" && ref?.kind === "file" && (ref.path === filePath || ref.path === interfacePath)) {
					node.ref = { kind: "folder", path: folderPath };
					nodes++;
				}
				walk(node.children);
			}
		};
		for (const view of this.views) walk(view.root);
		const manualPromotions = unitIndex?.convertManualPromotionToModule(filePath, folderPath) ?? 0;
		if (nodes > 0 || manualPromotions > 0) this.save();
		return { nodes, manualPromotions };
	}

	/** Create on a meta folder: the meta node becomes a unit node in place. Same id, position, fold
	 * state, status settings and children (all left as they are); only `type`/`ref` change and the
	 * label goes. Returns false, changing nothing, unless `nodeId` is a meta node in `viewId`. */
	replaceMetaNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || found.node.type !== "meta") return false;
		found.node.type = "unit";
		found.node.ref = ref;
		delete found.node.label;
		this.save();
		return true;
	}

	/** PR-2 (G8/G9/G10/G5): swaps the spot `nodeId` in place to point at `ref`. Same id, position, nested
	 * children, `explicitStatusId`, and data source; only `type`/`ref` change and any old label goes. Works
	 * on the one spot only, so other placements of the old or new item are untouched. Never goes through
	 * `placeUnit`/`findUnitNode`, which move the first copy they find. Returns false, changing nothing, for
	 * a missing view or node, a `folderSourceManaged` node (G2), or a swap to the node's own current ref. */
	swapNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || found.node.folderSourceManaged) return false;
		if (found.node.type === "unit" && found.node.ref && unitRefsEqual(found.node.ref, ref)) return false;
		found.node.type = "unit";
		found.node.ref = ref;
		delete found.node.label;
		this.save();
		return true;
	}

	/** PR-2 (G4/G9/G10): turns the spot `nodeId` into an Atlas folder called `label`, in place. Same id,
	 * position, nested children, `explicitStatusId`, and data source as `swapNodeWithUnit`; the old ref goes.
	 * Returns false, changing nothing, for a missing view or node, a `folderSourceManaged` node, a node that
	 * is already an Atlas folder, or an empty label. */
	swapNodeForAtlasFolder(viewId: string, nodeId: string, label: string): boolean {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		const trimmed = label.trim();
		if (!found || found.node.folderSourceManaged || found.node.type !== "unit" || !trimmed) return false;
		found.node.type = "meta";
		found.node.label = trimmed;
		delete found.node.ref;
		this.save();
		return true;
	}

	/** G1/G4/E6: sets a Folder's API data source, or removes it (passing `undefined` — "Remove data
	 * source", G4). Removing drops the cache and the awaiting-confirmation flag (meaningless without a
	 * live source, and it stops refreshing entirely — no more dot at all) but deliberately keeps
	 * `apiItemState`/`apiItemOrder` untouched: the rows themselves, with whatever status/notes they
	 * already had, survive as plain static rows. The device-local headers entry is a separate store the
	 * caller owns (see `ApiHeadersStore`); this method only ever touches the synced view data.
	 *
	 * R1 fix: `apiSource`, `csvSource`, and (PR-8) `markdownTableSource` share the same `apiCache`/
	 * `apiAwaitingConfirmation` fields (all three produce the same kind of placeholder row), so setting
	 * one live must clear the other two — otherwise they'd all keep refreshing into the same state and
	 * stomp each other's rows. */
	setApiSource(viewId: string, nodeId: string, source: ApiSourceConfig | undefined): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || !canHoldSource(found.node)) return;
		const hadOtherSource = found.node.csvSource !== undefined || found.node.markdownTableSource !== undefined;
		found.node.apiSource = source;
		if (source) {
			found.node.csvSource = undefined;
			found.node.markdownTableSource = undefined;
		}
		if (!source || hadOtherSource) {
			found.node.apiCache = undefined;
			found.node.apiAwaitingConfirmation = undefined;
		}
		this.save();
	}

	/** PR-7 (G17-G19/G22-G23): sets a Folder's CSV data source, or removes it (passing `undefined`) —
	 * exact mirror of `setApiSource`, since a CSV source produces the same kind of placeholder rows and
	 * the same "removal keeps the rows as static, drops only cache/confirmation" rule applies.
	 *
	 * R1 fix: mirrors `setApiSource`'s clearing of the other source types — see its doc comment. */
	setCsvSource(viewId: string, nodeId: string, source: CsvSourceConfig | undefined): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || !canHoldSource(found.node)) return;
		const hadOtherSource = found.node.apiSource !== undefined || found.node.markdownTableSource !== undefined;
		found.node.csvSource = source;
		if (source) {
			found.node.apiSource = undefined;
			found.node.markdownTableSource = undefined;
		}
		if (!source || hadOtherSource) {
			found.node.apiCache = undefined;
			found.node.apiAwaitingConfirmation = undefined;
		}
		this.save();
	}

	/** PR-8 (G17-G20/G22-G24): sets a Folder's Markdown Table data source, or removes it (passing
	 * `undefined`) — exact mirror of `setApiSource`/`setCsvSource`, since a Markdown Table source
	 * produces the same kind of placeholder rows and the same "removal keeps the rows as static, drops
	 * only cache/confirmation" rule applies.
	 *
	 * R1 fix: mirrors `setApiSource`'s clearing of the other source types — see its doc comment. */
	setMarkdownTableSource(viewId: string, nodeId: string, source: MarkdownTableSourceConfig | undefined): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || !canHoldSource(found.node)) return;
		const hadOtherSource = found.node.apiSource !== undefined || found.node.csvSource !== undefined;
		found.node.markdownTableSource = source;
		if (source) {
			found.node.apiSource = undefined;
			found.node.csvSource = undefined;
		}
		if (!source || hadOtherSource) {
			found.node.apiCache = undefined;
			found.node.apiAwaitingConfirmation = undefined;
		}
		this.save();
	}

	/** PR-4 (G4/G5/G10): sets a Folder's Folder data source, or removes it (passing `undefined` —
	 * "Remove data source"). Unlike `setApiSource`, removal needs no special-case cleanup: Folder-
	 * source children are ordinary real `ViewNode` units (not placeholder rows tied to a live source),
	 * so they simply stop being managed/refreshed and stay exactly where they are, like any other
	 * manually-placed unit. */
	setFolderSource(viewId: string, nodeId: string, source: FolderSourceConfig | undefined): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || !canHoldSource(found.node)) return;
		// PR-1.F2 (G4): only a change to the rules is a definition that flags rows. An unchanged save, or a
		// mode change alone, leaves every flag as it was.
		const rulesBefore = JSON.stringify(found.node.folderSource?.filters ?? null);
		found.node.folderSource = source;
		if (view && rulesBefore !== JSON.stringify(source?.filters ?? null)) this.applyRulesToHiddenAtSave(view, nodeId, source);
		this.save();
	}

	/** PR-4 (G3/G5/G10/G16): resolves the Folder source's target and reconciles this node's children
	 * against it (adds newly-appeared children, drops any whose kind got toggled off, leaves
	 * everything else — including a since-deleted managed child's now-missing ref — exactly as it
	 * is; see `buildFolderSourceChildren`'s own doc comment for the full reconciliation contract). A
	 * no-op if the node isn't a meta node with a Folder source. Read-only against the vault: this
	 * never creates/moves/deletes anything on disk (F5). */
	refreshFolderSource(viewId: string, nodeId: string, outsidePath?: string): void {
		const view = this.getView(viewId);
		if (!view) return;
		const found = this.findNode(view.root, nodeId);
		if (!found || !canHoldSource(found.node) || !found.node.folderSource) return;
		const ownerId = found.node.id;
		const before = JSON.stringify([found.node.children, found.node.apiItemState, found.node.apiItemOrder]);
		// PR-2 (R2-Q2): an Outside-Vault source's deletes and renames are reconciled before the add pass,
		// so a renamed row keeps its node and a deleted one is demoted per mode. An unresolved path is
		// left alone, as it always was.
		if (found.node.folderSource.location === "outside" && outsidePath && resolveOutsidePath(outsidePath)) {
			this.reconcileOutsideChildChanges(view.root, found.node, found.node.folderSource, listOutsideChildren(outsidePath, found.node.folderSource));
		}
		found.node.children = buildFolderSourceChildren(
			this.app.vault,
			found.node.folderSource,
			found.node.children,
			(ref) => ({
				id: generateNodeId(),
				type: "unit",
				ref,
				children: [],
				folderSourceManaged: true,
				folderSourceOwnerId: ownerId,
			}),
			{
				sourceNodeId: ownerId,
				viewRoot: view.root,
				// PR-1.S1: frontmatter comes from the metadata cache only (never file content).
				filter: { metadataResolved: this.metadataResolved, frontmatterOf: (file) => this.app.metadataCache.getFileCache(file)?.frontmatter },
			},
			outsidePath
		);
		this.sweepFolderSourceDeletedPlaceholders(found.node);
		// PR-1.F2 (G6): unflag this owner's rows that match the rules again before deciding whether to save.
		const unflagged = this.clearMatchedHiddenAtSave([view], ownerId);
		// PR-1 (F2): a refresh that finds nothing new writes nothing — every view load and every live
		// folder event runs through here, so an unchanged source must not cost a `data.json` write.
		// PR-1 (R1): but it still re-renders, because an unchanged Outside-Vault source can change what
		// the explorer shows (unplugged or reconnected drive) without any stored data changing.
		if (unflagged || JSON.stringify([found.node.children, found.node.apiItemState, found.node.apiItemOrder]) !== before) this.save();
		else this.notifyChange();
	}

	/** PR-1 (G5): the ids of this view's Inside-Vault Folder sources whose target folder is one of
	 * `folderPaths`. Exact, case-sensitive path match (the same rule `isExcluded` uses). Outside-Vault
	 * sources never match: their `path` is meaningless and they refresh on load/focus instead. Scoped
	 * to a single view, so the live trigger follows the same active-view-only rule as every other
	 * refresh. */
	getInsideFolderSourceNodeIds(viewId: string, folderPaths: Set<string>): string[] {
		const view = this.getView(viewId);
		if (!view) return [];
		const ids: string[] = [];
		const walk = (nodes: ViewNode[]): void => {
			for (const node of nodes) {
				if (node.type === "meta" && node.folderSource?.location === "inside" && folderPaths.has(node.folderSource.path)) {
					ids.push(node.id);
				}
				walk(node.children);
			}
		};
		walk(view.root);
		return ids;
	}

	/** PR-1.S1 (E10): called from `main.ts`'s existing `metadataCache "resolved"` listener, before
	 * `UnitIndex.onMetadataResolved`. On the first resolve only, it flips the held-back flag and
	 * re-reconciles every rule-filtered Folder source, so files held back at startup appear now.
	 * Later resolves do nothing: new files join only on a refresh (G8/F7), and re-saving on every
	 * metadata event would be wasted work. `refreshFolderSource` saves, which notifies the explorer
	 * through the existing change path, so no second listener is needed. */
	onMetadataResolved(): void {
		if (this.metadataResolved) {
			// PR-1.F2 (G5/G6): a later resolve re-evaluates rows only. It unflags rows that match again, and
			// the render reads drop-outs from the cache. It never adds a file, so new files still join only
			// on a refresh (F7). Notify even without a save, so a live drop-out repaints.
			if (this.clearMatchedHiddenAtSave(this.views)) this.save();
			else this.notifyChange();
			return;
		}
		this.metadataResolved = true;
		const filtered: { viewId: string; nodeId: string }[] = [];
		const walk = (viewId: string, nodes: ViewNode[]): void => {
			for (const node of nodes) {
				if (node.type === "meta" && node.folderSource?.filters) filtered.push({ viewId, nodeId: node.id });
				walk(viewId, node.children);
			}
		};
		for (const view of this.views) walk(view.id, view.root);
		for (const { viewId, nodeId } of filtered) this.refreshFolderSource(viewId, nodeId);
	}

	/** PR-6: the "next reconciliation pass" half of the mode-switch edge cases — re-applies
	 * `reconcileFolderSourceChildDelete` to every placeholder this Folder source previously demoted a
	 * deleted child into, using the source's *current* `mode` rather than whatever mode was active at
	 * the moment each one was created. Switching to "overwrite" sweeps every one of them away with no
	 * warning (G14, read at reconciliation time); switching between "merge"/"append" reshapes them in
	 * place.
	 *
	 * R2 fix: only ever touches an entry already marked `folderSourceDeleted` — a node can carry
	 * `apiItemState` rows that did NOT come from this demotion (e.g. it still has leftover entries
	 * from when it was an `apiSource`, with `setApiSource`/`setFolderSource` each leaving the other's
	 * state alone), and this sweep must never fold one of those into "not found"/append-link limbo
	 * just because it happens to share the same node.
	 *
	 * R1 fix: passes every existing field (`secondary`, `noteRef`, `position`) through as `base`, not
	 * just four of them, so a `noteRef`/`secondary` attached since the original delete (e.g. via "Add
	 * note") survives this and every later sweep instead of being silently dropped. */
	private sweepFolderSourceDeletedPlaceholders(node: ViewNode): void {
		if (!node.folderSource || !node.apiItemState) return;
		const mode = node.folderSource.mode ?? "merge";
		for (const [id, item] of Object.entries(node.apiItemState)) {
			if (!item.folderSourceDeleted) continue;
			const base = {
				id: item.id,
				label: item.label,
				lastSeenAt: item.lastSeenAt ?? new Date().toISOString(),
				explicitStatusId: item.explicitStatusId,
				secondary: item.secondary,
				noteRef: item.noteRef,
				position: item.position,
			};
			const reconciled = reconcileFolderSourceChildDelete(mode, base);
			if (!reconciled) {
				delete node.apiItemState[id];
				if (node.apiItemOrder) node.apiItemOrder = node.apiItemOrder.filter((x) => x !== id);
			} else {
				node.apiItemState[id] = reconciled;
			}
		}
	}

	/** T1 fix: every ref currently managed by an Inside-Vault Folder source, across every view.
	 * `main.ts` feeds this straight into `UnitIndex.setFolderSourceRefs` after every change
	 * (`onChange`) so Folder-source children resolve through `ExplorerView.resolveRef`'s normal
	 * `unitsByRefKey` lookup as real units (G3), instead of only existing as `ViewNode`s the index
	 * never knew about and falling through to the generic missing-ref fallback. Walks every view (not
	 * just the active one) since the index is shared/global, not per-view.
	 *
	 * R4 fix: an Outside-Vault-managed child's `ref.path` is now just an entry name relative to its
	 * source's root (never the absolute device path — see `listOutsideChildrenWith`'s own doc
	 * comment), which makes it exactly the kind of short, ordinary-looking string a real vault path
	 * could also be, or that two different Outside sources could each produce. `UnitIndex`'s global
	 * `unitsByRefKey`-shaped map has no notion of "which source owns this," so folding these in here
	 * would risk colliding with a real vault unit, or with another Outside source's same-named child.
	 * `ExplorerView.resolveOutsideManagedRowInfo` already bypasses the index entirely for these rows
	 * (G8's own doc comment), so excluding them here costs nothing — they were never looked up through
	 * this path. */
	getFolderSourceManagedRefs(): UnitRef[] {
		const refs: UnitRef[] = [];
		for (const view of this.views) {
			const byId = new Map<string, ViewNode>();
			const index = (nodes: ViewNode[]): void => {
				for (const node of nodes) {
					byId.set(node.id, node);
					index(node.children);
				}
			};
			index(view.root);
			const walk = (nodes: ViewNode[]): void => {
				for (const node of nodes) {
					if (node.type === "unit" && node.folderSourceManaged && node.ref) {
						const owner = node.folderSourceOwnerId ? byId.get(node.folderSourceOwnerId) : undefined;
						if (owner?.folderSource?.location !== "outside") refs.push(node.ref);
					}
					walk(node.children);
				}
			};
			walk(view.root);
		}
		return refs;
	}

	/** G8: sets one API item's own explicit status — the item has no real `ViewNode`, so
	 * `setExplicitStatus` (which addresses a node by id) can't be reused directly. */
	setApiItemStatus(viewId: string, nodeId: string, itemId: string, statusId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		const item = found?.node.apiItemState?.[itemId];
		if (!item) return;
		item.explicitStatusId = statusId;
		this.save();
	}

	/** G9: attaches (or replaces) the one note a given API item opens by default. */
	setApiItemNoteRef(viewId: string, nodeId: string, itemId: string, noteRef: UnitRef): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		const item = found?.node.apiItemState?.[itemId];
		if (!item) return;
		item.noteRef = noteRef;
		this.save();
	}

	/** G26/G29: removes a placeholder row's `apiItemState` entry outright — gated by the caller on
	 * the row's shared placeholder tag plus `notFound` (E6: removal still proceeds even if the row
	 * flipped back to found between menu-open and click, since this method itself never re-checks
	 * `notFound`). No bulk variant exists (F3) and there is no undo (F4) — this is the only way an
	 * entry is deleted here. */
	removeApiItem(viewId: string, nodeId: string, itemId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found?.node.apiItemState || !(itemId in found.node.apiItemState)) return;
		delete found.node.apiItemState[itemId];
		if (found.node.apiItemOrder) {
			found.node.apiItemOrder = found.node.apiItemOrder.filter((id) => id !== itemId);
		}
		this.save();
	}

	/** G28/G29: manual backstop that clears only a placeholder row's stale `noteRef`, independent of
	 * whether G27's vault-delete auto-clear already ran (or ever could) — usable for any reason the
	 * reference went stale. The row's other fields (`notFound`/`lastSeenAt` included) are untouched.
	 * A no-op, safely, if `noteRef` is already unset. */
	clearApiItemNoteRef(viewId: string, nodeId: string, itemId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		const item = found?.node.apiItemState?.[itemId];
		if (!item) return;
		item.noteRef = undefined;
		this.save();
	}

	/** G1/G6/G11: for callers (`ApiSourceController`) that mutate a node's `apiCache`/`apiItemState`
	 * fields directly rather than through a dedicated setter — persists and notifies the same as any
	 * other change here. */
	notifyExternalMutation(): void {
		this.save();
	}

	/** F9 rename integrity: rewrite every matching ref (exact + prefix) across every view. */
	onVaultRename(oldPath: string, newPath: string): void {
		let changed = false;
		const nowIso = new Date().toISOString();
		// PR-1 (R2-Q1): a managed child renamed or moved out of its source folder leaves that source per
		// the source's mode, exactly as a delete does. Checked before the rewrite below, so the owner
		// folder's path is first rewritten here (a renamed source folder still counts as "still inside").
		const leftSource = (owner: ViewNode | undefined): boolean => {
			if (!owner?.folderSource) return true;
			const sourcePath = owner.folderSource.path;
			// R2: a renamed parent folder's child can arrive before the folder's own rename event, so the
			// source path is still the old one here. A source folder that no longer exists at its old path
			// means its parent was renamed — the child is still inside, so it must not be detached.
			if (parentFolderPath(oldPath) === sourcePath && !this.app.vault.getAbstractFileByPath(sourcePath)) return false;
			return parentFolderPath(newPath) !== rewritePathString(sourcePath, oldPath, newPath);
		};
		for (const view of this.views) {
			if (this.reconcileFolderSourceDeletesForPath(view.root, oldPath, nowIso, leftSource, false)) changed = true;
		}
		for (const view of this.views) {
			if (this.rewriteTree(view.root, oldPath, newPath, view.root)) changed = true;
		}
		if (changed) this.save();
	}

	private rewriteTree(nodes: ViewNode[], oldPath: string, newPath: string, root: ViewNode[]): boolean {
		let changed = false;
		for (const node of nodes) {
			// R9(a): an Outside-Vault-managed child's `ref.path` is a bare name relative to its source's
			// root, not a vault path — it must never be rewritten just because it happens to collide
			// with a renamed vault-root path (see `isOutsideOwned`'s own doc comment).
			if (node.type === "unit" && node.ref && !this.isOutsideOwned(root, node)) {
				const rewritten = rewriteRefPath(node.ref, oldPath, newPath);
				if (rewritten !== node.ref) {
					node.ref = rewritten;
					changed = true;
				}
			}
			// R12: an API item's attached note/block/module (`setApiItemNoteRef`) is a `UnitRef` just
			// like a unit node's own `ref` — it goes stale on the same renames and needs the same
			// rewrite, or the default click (G9) silently does nothing once the target moves.
			if (node.apiItemState) {
				for (const item of Object.values(node.apiItemState)) {
					if (!item.noteRef) continue;
					const rewritten = rewriteRefPath(item.noteRef, oldPath, newPath);
					if (rewritten !== item.noteRef) {
						item.noteRef = rewritten;
						changed = true;
					}
				}
			}
			// PR-4 (G5): `folderSource.path` is a plain vault-relative string, not a `UnitRef` — same
			// rename-integrity rule, via the same shared helper `rewriteRefPath` itself now delegates to.
			// PR-4 (R8): `folderSource.removedRefs` is a set of `unitRefKey` strings, each embedding a
			// path of its own — they go stale on the same rename unless rewritten the same way, or a
			// removed row's key stops matching and the row comes back on the next refresh.
			// R9(a): both fields are meaningless while `location` is "outside" (the device-local path
			// lives in `FolderSourcePathStore`, and `removedRefs` keys are root-relative Outside names,
			// never vault paths) — rewriting either on a rename would corrupt them for no reason.
			if (node.folderSource && node.folderSource.location !== "outside") {
				const rewrittenPath = rewritePathString(node.folderSource.path, oldPath, newPath);
				const removedRefs = node.folderSource.removedRefs;
				const rewrittenRemovedRefs = removedRefs?.map((key) => rewriteRefKeyPath(key, oldPath, newPath));
				const removedRefsChanged =
					!!removedRefs && !!rewrittenRemovedRefs && removedRefs.some((key, i) => key !== rewrittenRemovedRefs[i]);
				if (rewrittenPath !== node.folderSource.path || removedRefsChanged) {
					node.folderSource = { ...node.folderSource, path: rewrittenPath, removedRefs: rewrittenRemovedRefs };
					changed = true;
				}
			}
			// PR-7 (G18): `csvSource.path` is the same kind of plain vault-relative string as
			// `folderSource.path` — same rename-integrity rule via the same shared helper.
			if (node.csvSource) {
				const rewrittenCsvPath = rewritePathString(node.csvSource.path, oldPath, newPath);
				if (rewrittenCsvPath !== node.csvSource.path) {
					node.csvSource = { ...node.csvSource, path: rewrittenCsvPath };
					changed = true;
				}
			}
			// PR-8 (G18): `markdownTableSource.path` is the same kind of plain vault-relative string as
			// `csvSource.path` — same rename-integrity rule via the same shared helper.
			if (node.markdownTableSource) {
				const rewrittenMdPath = rewritePathString(node.markdownTableSource.path, oldPath, newPath);
				if (rewrittenMdPath !== node.markdownTableSource.path) {
					node.markdownTableSource = { ...node.markdownTableSource, path: rewrittenMdPath };
					changed = true;
				}
			}
			if (this.rewriteTree(node.children, oldPath, newPath, root)) changed = true;
		}
		return changed;
	}

	/** G27: a vault `delete` event clears any placeholder row's `noteRef` that pointed at the
	 * deleted path — additive alongside `unitIndex.onVaultDelete`/`graduation.handleDelete`
	 * (`main.ts`), independent of `onVaultRename`'s path-rewrite logic above (rename rewrites;
	 * delete clears, since there is no new path to rewrite to). Only the `noteRef` field is cleared;
	 * the `apiItemState` entry itself survives untouched (E5: a path matching nothing is a no-op;
	 * clears every matching entry across every node/view, not just the first). Exact-path match
	 * only — a single deleted file, not a deleted folder's whole subtree — so a delete immediately
	 * followed (same tick) by a recreate at the same path, where the `noteRef` was already rewritten
	 * elsewhere to a different path, is never mistaken for this file's reference. */
	onVaultDelete(path: string): void {
		let changed = false;
		const nowIso = new Date().toISOString();
		// PR-6 (G12-G14): demote any Folder-source-managed child at `path` into a placeholder on its
		// owning Folder node *before* the clear sweep below, so an append-mode placeholder's freshly
		// attached `noteRef` (deliberately pointed at the just-deleted path so G27's existing clear
		// mechanism picks it up) is cleared within this same call — genuine reuse of that mechanism,
		// not a second copy of it.
		for (const view of this.views) {
			if (this.reconcileFolderSourceDeletesForPath(view.root, path, nowIso)) changed = true;
		}
		for (const view of this.views) {
			if (this.clearNoteRefsForPath(view.root, path)) changed = true;
		}
		if (changed) this.save();
	}

	/** PR-6 (G12-G14): the delete-time half of the mode-reconciliation rule — finds every real
	 * `ViewNode` this view's Folder sources manage whose `ref.path` is the just-deleted `path`, lifts
	 * its own children up one level (same contract as any other removal here), and demotes it per its
	 * owning source's *current* `mode` via `reconcileFolderSourceChildDelete` (shared with the later
	 * reconciliation-time sweep in `sweepFolderSourceDeletedPlaceholders`, so this stays the one
	 * parameterized rule rather than its own ad-hoc branch). An Outside-Vault-owned child is skipped
	 * outright — its `ref.path` is a bare root-relative name, never a real vault path, and Outside
	 * deletions are PR-5's own unresolved-path contract, not a vault `delete` event. */
	private reconcileFolderSourceDeletesForPath(
		root: ViewNode[],
		path: string,
		nowIso: string,
		detaches: (owner: ViewNode | undefined) => boolean = () => true,
		deleted = true
	): boolean {
		const matches = this.collectManagedMatches(root, (node) => node.type === "unit" && node.ref?.path === path);
		if (matches.length === 0) return false;
		const byId = this.indexNodesById(root);
		// Outside-Vault-owned rows are skipped: their refs are root-relative names, never vault paths.
		const applicable = matches.filter(({ node }) => {
			const owner = node.folderSourceOwnerId ? byId.get(node.folderSourceOwnerId) : undefined;
			return owner?.folderSource?.location !== "outside" && detaches(owner);
		});
		this.demoteManagedMatches(applicable, byId, nowIso, deleted);
		return true;
	}

	/** PR-2 (R2-Q2): the Outside-Vault half of delete and rename reconciliation, run by `refreshFolderSource`
	 * before its ordinary add pass. An outside source's refs are bare root-relative names, so only this
	 * owner's own managed rows are considered. A rename keeps the same node, with its children, status
	 * and position, and changes only its ref. A delete is demoted per the source's current mode, with no
	 * `noteRef`, since there is no vault file for it to link to. */
	private reconcileOutsideChildChanges(root: ViewNode[], owner: ViewNode, source: FolderSourceConfig, listed: UnitRef[]): void {
		const shown = (ref: UnitRef): boolean => (ref.kind === "folder" ? source.showFolders : source.showFiles);
		const matches = this.collectManagedMatches(root, (node) => node.folderSourceOwnerId === owner.id && !!node.ref && shown(node.ref));
		if (matches.length === 0) return;
		const managedRefs = matches.map(({ node }) => node.ref as UnitRef);
		const { renamed, gone } = diffOutsideChildren(managedRefs, listed, new Set(source.removedRefs ?? []));
		const byKey = new Map(matches.map((match) => [unitRefKey(match.node.ref as UnitRef), match]));
		for (const { from, to } of renamed) {
			const match = byKey.get(unitRefKey(from));
			if (match) match.node.ref = to;
		}
		const goneKeys = new Set(gone.map(unitRefKey));
		const goneMatches = matches.filter(({ node }) => goneKeys.has(unitRefKey(node.ref as UnitRef)));
		this.demoteManagedMatches(goneMatches, this.indexNodesById(root), new Date().toISOString(), false);
	}

	/** Every managed `unit` node under `root` that `isMatch` accepts, with the list it sits in, its slot
	 * there, and its depth. Recurses into each match's own children too, since a managed row can be
	 * nested anywhere in the view. */
	private collectManagedMatches(root: ViewNode[], isMatch: (node: ViewNode) => boolean): ManagedMatch[] {
		const matches: ManagedMatch[] = [];
		const collect = (list: ViewNode[], depth: number): void => {
			for (let i = 0; i < list.length; i++) {
				const node = list[i];
				if (node.folderSourceManaged && isMatch(node)) matches.push({ list, index: i, node, depth });
				collect(node.children, depth + 1);
			}
		};
		collect(root, 0);
		return matches;
	}

	private indexNodesById(root: ViewNode[]): Map<string, ViewNode> {
		const byId = new Map<string, ViewNode>();
		const indexIds = (nodes: ViewNode[]): void => {
			for (const node of nodes) {
				byId.set(node.id, node);
				indexIds(node.children);
			}
		};
		indexIds(root);
		return byId;
	}

	/** Demotes each match in turn. Deepest first, then highest index first within a depth: a nested match
	 * is spliced out of its parent's children before the parent lifts them, so no splice ever works on a
	 * stale list, and no splice shifts another match's index. */
	private demoteManagedMatches(matches: ManagedMatch[], byId: Map<string, ViewNode>, nowIso: string, deleted: boolean): void {
		const ordered = [...matches].sort((a, b) => b.depth - a.depth || b.index - a.index);
		for (const { list, index, node } of ordered) {
			const owner = node.folderSourceOwnerId ? byId.get(node.folderSourceOwnerId) : undefined;
			const ref = node.ref as UnitRef;
			const mode = owner?.folderSource?.mode ?? "merge";
			// R3 fix: strip the extension off a file's basename (matching what the row displayed while
			// the file still existed), rather than the raw last path segment — "a.md" showing where "a"
			// used to be was the bug.
			const label = basenameForDeletedRef(ref);
			// R3 fix: `index` is this node's slot among `owner`'s real children right now, before the
			// splice below removes it — `renderNodeList` uses it to put the resulting row back in
			// (approximately) that same slot instead of always appending it after every real child.
			const base = { id: unitRefKey(ref), label, lastSeenAt: nowIso, explicitStatusId: node.explicitStatusId, position: index };
			// A move-out is not a delete: the append placeholder gets no `noteRef` (nothing to clear), and
			// the file's new location is never shown as a stale link.
			const placeholder = reconcileFolderSourceChildDelete(mode, base, deleted ? ref : undefined);
			list.splice(index, 1, ...node.children);
			if (placeholder && owner) {
				if (!owner.apiItemState) owner.apiItemState = {};
				if (!owner.apiItemOrder) owner.apiItemOrder = [];
				owner.apiItemState[placeholder.id] = placeholder;
				if (!owner.apiItemOrder.includes(placeholder.id)) owner.apiItemOrder.push(placeholder.id);
			}
		}
	}

	/** PR-2 (G9): the active view's Outside-Vault Folder source node ids, for the watcher registry. */
	getOutsideFolderSourceNodeIds(viewId: string): string[] {
		const view = this.getView(viewId);
		if (!view) return [];
		const ids: string[] = [];
		const walk = (nodes: ViewNode[]): void => {
			for (const node of nodes) {
				if (node.type === "meta" && node.folderSource?.location === "outside") ids.push(node.id);
				walk(node.children);
			}
		};
		walk(view.root);
		return ids;
	}

	private clearNoteRefsForPath(nodes: ViewNode[], path: string): boolean {
		let changed = false;
		for (const node of nodes) {
			if (node.apiItemState) {
				for (const item of Object.values(node.apiItemState)) {
					if (item.noteRef && item.noteRef.path === path) {
						item.noteRef = undefined;
						changed = true;
					}
				}
			}
			if (this.clearNoteRefsForPath(node.children, path)) changed = true;
		}
		return changed;
	}
}
