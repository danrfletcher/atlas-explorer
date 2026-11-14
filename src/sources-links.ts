import { isUsableSourceName, type TephraSource } from "./tephra-client";
import { SOURCES_FOLDER } from "./sources-path";

/** The vault itself is registered in Tephra under this name and never gets a `Sources/` link. */
export const VAULT_SOURCE_NAME = "notes";

/** What a directory entry in `Sources/` is, as `lstat` sees it (a symlink is never followed). */
export type LinkEntry = { kind: "symlink"; target: string } | { kind: "other" };

/** The slice of Node's `fs.promises` the `Sources/` folder code uses. Injectable: tests pass an in-memory fake
 * or the real module over a temp dir. Every call is on a path inside the vault except reading a source's
 * own `.gitignore`. */
export interface SourcesFs {
	lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
	readdir(path: string): Promise<string[]>;
	readlink(path: string): Promise<string>;
	symlink(target: string, path: string): Promise<void>;
	unlink(path: string): Promise<void>;
	mkdir(path: string): Promise<unknown>;
	rmdir(path: string): Promise<void>;
	readFile(path: string, encoding: "utf8"): Promise<string>;
	appendFile(path: string, data: string): Promise<void>;
}

/** `lstat` that answers null for "nothing there" instead of throwing. Other errors still throw. */
export async function lstatOrNull(fs: SourcesFs, path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean } | null> {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

/** A source's root as a clean absolute path: no trailing slashes. Null when it can't be a link target
 * (empty, or relative: a relative target would resolve against `Sources/` and point nowhere). */
export function normalizeRoot(path: string): string | null {
	if (!path.startsWith("/")) return null;
	const trimmed = path.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

function isInsideOrSame(path: string, root: string): boolean {
	return root === "/" || path === root || path.startsWith(`${root}/`);
}

export interface TopLevelSource {
	name: string;
	root: string;
}

export interface TopLevelResult {
	linked: TopLevelSource[];
	/** Sources that were left out and why, for the console. The vault and nested sources are expected and
	 * not listed here. */
	skipped: { name: string; reason: "relative-path" | "contains-vault" | "unusable-name" }[];
}

/**
 * G2: the sources that get a `Sources/<name>` link. Not `notes` (the vault), and not a source whose root is
 * inside another source's root, the vault's included (a promoted or nested source is a label inside its
 * parent's link: Obsidian ignores a folder link whose target is inside another's). Two sources with the
 * same root: the first by name keeps it. A source whose root holds the vault itself is left out too: its
 * link would contain the vault and loop.
 */
export function selectTopLevelSources(sources: TephraSource[], vaultPath: string | null): TopLevelResult {
	const skipped: TopLevelResult["skipped"] = [];
	const vaultRoot = vaultPath === null ? null : normalizeRoot(vaultPath);
	const candidates: TopLevelSource[] = [];
	const notes = sources.find((s) => s.name === VAULT_SOURCE_NAME);
	// The vault is the `notes` source whether or not Tephra lists it yet (Atlas doesn't register it in this PR):
	// a source inside the vault must never be linked back into it, so the vault's own path always counts as a
	// containing root, next to whatever root Tephra reports for `notes`.
	const containingRoots = [notes ? normalizeRoot(notes.path) : null, vaultRoot].filter((root): root is string => root !== null);

	for (const source of [...sources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (source.name === VAULT_SOURCE_NAME) continue;
		if (!isUsableSourceName(source.name)) {
			skipped.push({ name: source.name, reason: "unusable-name" }); // never a path outside `Sources/`
			continue;
		}
		const root = normalizeRoot(source.path);
		if (root === null) {
			skipped.push({ name: source.name, reason: "relative-path" });
			continue;
		}
		if (vaultRoot !== null && isInsideOrSame(vaultRoot, root)) {
			skipped.push({ name: source.name, reason: "contains-vault" });
			continue;
		}
		candidates.push({ name: source.name, root });
	}

	const linked = candidates.filter((candidate) => {
		if (containingRoots.some((root) => isInsideOrSame(candidate.root, root))) return false;
		return !candidates.some((other) => {
			if (other === candidate) return false;
			if (other.root === candidate.root) return other.name < candidate.name; // same folder: the first name keeps the link
			return isInsideOrSame(candidate.root, other.root);
		});
	});
	return { linked, skipped };
}

export type LinkSkipReason = "clash" | "foreign-link";

export type LinkAction =
	| { type: "create"; name: string; target: string }
	/** The link is ours and points somewhere else now: unlink it and link the new root. */
	| { type: "replace"; name: string; target: string; from: string }
	/** The link is ours and its source is gone: unlink it. */
	| { type: "remove"; name: string }
	/** A symlink we did not record but that already points where we want one: record it, change nothing. */
	| { type: "adopt"; name: string; target: string }
	/** The record is stale (the entry is gone, or is no longer a link): forget it, touch nothing on disk. */
	| { type: "forget"; name: string }
	/** E2: something that isn't ours is in the way. The link is not made and nothing is touched. */
	| { type: "skip"; name: string; reason: LinkSkipReason };

export interface LinkPlanInput {
	/** The top-level sources that should be linked (from `selectTopLevelSources`). */
	wanted: TopLevelSource[];
	/** What `Sources/` holds now, by entry name. */
	entries: Map<string, LinkEntry>;
	/** `tephraLinks` in `data.json`: the links Atlas made, by name, with the target it gave each. */
	recorded: Record<string, string>;
}

/**
 * Diffs what Tephra says should be linked against what `Sources/` holds and what Atlas recorded making.
 * Pure; the caller runs the actions. Ownership is by record: a link not in `recorded` is never replaced or
 * removed, and a real folder or file is never touched whatever its name. Idempotent: planning again after the
 * actions ran gives no actions (apart from persistent `skip`s).
 */
export function planSourceLinks(input: LinkPlanInput): LinkAction[] {
	const actions: LinkAction[] = [];
	const wantedByName = new Map(input.wanted.map((w) => [w.name, w]));
	const has = (name: string) => Object.prototype.hasOwnProperty.call(input.recorded, name);

	for (const want of input.wanted) {
		const entry = input.entries.get(want.name);
		if (entry === undefined) {
			actions.push({ type: "create", name: want.name, target: want.root });
		} else if (entry.kind === "other") {
			actions.push({ type: "skip", name: want.name, reason: "clash" });
		} else if (has(want.name)) {
			if (normalizeRoot(entry.target) !== want.root) actions.push({ type: "replace", name: want.name, target: want.root, from: entry.target });
			else if (input.recorded[want.name] !== want.root) actions.push({ type: "adopt", name: want.name, target: want.root }); // record out of date, link right
		} else if (normalizeRoot(entry.target) === want.root) {
			actions.push({ type: "adopt", name: want.name, target: want.root });
		} else {
			actions.push({ type: "skip", name: want.name, reason: "foreign-link" });
		}
	}

	for (const name of Object.keys(input.recorded)) {
		if (wantedByName.has(name)) continue;
		if (!isUsableSourceName(name)) {
			actions.push({ type: "forget", name }); // a hand-edited record: never a filesystem path
			continue;
		}
		const entry = input.entries.get(name);
		if (entry?.kind === "symlink") actions.push({ type: "remove", name });
		else actions.push({ type: "forget", name }); // gone, or replaced by something real that is not ours to remove
	}

	return actions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** E13: the verdict on whether Atlas may take over `Sources/` when the toggle is turned on. */
export type OwnershipResult = { ok: true } | { ok: false; path: string; reason: string };

/**
 * E13: Atlas owns `Sources/` only when it doesn't exist, or is a real folder whose every entry is a symlink
 * recorded in `tephraLinks`. An empty folder Atlas made earlier passes, and so does a reload with the links
 * in place. A file or a link called `Sources` (exact name: `Sources.md` is fine) is refused, and so is a
 * folder holding anything of the user's.
 */
export async function checkSourcesOwnership(fs: SourcesFs, vaultPath: string, recorded: Record<string, string>): Promise<OwnershipResult> {
	const dir = `${vaultPath}/${SOURCES_FOLDER}`;
	const refuse = (reason: string): OwnershipResult => ({ ok: false, path: SOURCES_FOLDER, reason });
	const stat = await lstatOrNull(fs, dir);
	if (stat === null) return { ok: true };
	if (stat.isSymbolicLink()) return refuse("it is a link, not a folder");
	if (!stat.isDirectory()) return refuse("it is a file");
	for (const name of await fs.readdir(dir)) {
		const entry = await lstatOrNull(fs, `${dir}/${name}`);
		if (entry === null) continue; // vanished while we looked
		if (!entry.isSymbolicLink() || !Object.prototype.hasOwnProperty.call(recorded, name)) return refuse(`it holds "${name}", which Atlas didn't create`);
	}
	return { ok: true };
}

/** What `Sources/` holds now, by entry name; an empty map when the folder isn't there. */
export async function readSourcesEntries(fs: SourcesFs, dir: string): Promise<Map<string, LinkEntry>> {
	const entries = new Map<string, LinkEntry>();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return entries;
		throw error;
	}
	for (const name of names) {
		const stat = await lstatOrNull(fs, `${dir}/${name}`);
		if (stat === null) continue;
		if (stat.isSymbolicLink()) entries.set(name, { kind: "symlink", target: await fs.readlink(`${dir}/${name}`) });
		else entries.set(name, { kind: "other" });
	}
	return entries;
}
