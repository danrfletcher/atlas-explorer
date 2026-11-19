import { SOURCES_FOLDER, isInSourcesFolder, isSameOrUnder } from "./sources-path";

/** How long an expectation outlives the last delete it matched. Obsidian reports the deletes under an
 * unlinked folder a little after the fact, and a big source takes a while. */
export const EXPECTED_DELETE_TTL_MS = 30_000;

/**
 * - `expected`: Atlas caused it (it unlinked or replaced a `Sources/<name>` link, or removed `Sources/`). Not a
 *   delete of the user's. Adding or removing an Excluded files entry is not one: Obsidian keeps an excluded file
 *   in the vault (only search, the Quick Switcher and the graph hide it), so no delete event follows.
 * - `missing`: the source's folder is gone (deleted, or its drive unplugged), so its files vanished from
 *   under the link. The entries must come back with no change when the folder returns.
 * - `real`: an ordinary delete; every handler runs as it always has.
 */
export type SourceDeleteKind = "expected" | "missing" | "real";

export interface SourceDeleteClassifierDeps {
	/** Source name -> the folder its `Sources/<name>` link points at (what `tephraLinks` records). */
	getLinkTargets: () => Record<string, string>;
	/** PR-12 (G6): the promoted sources' roots, with the absolute folder each one is. A promoted source has no
	 * `Sources/<name>` link of its own, so a delete under it is read against its own folder, not the link of the
	 * source it lies in. Optional: absent, there are none. */
	getPromotedRoots?: () => readonly { name: string; vaultPath: string; absRoot?: string }[];
	/** Whether that folder exists right now. A synchronous probe: delete events are handled synchronously
	 * and the answer must not wait for Tephra's next status report. */
	targetExists: (target: string) => boolean;
	now?: () => number;
	ttlMs?: number;
}

interface Expectation {
	matches: (path: string) => boolean;
	expiresAt: number;
}

/**
 * R3-4: tells a delete event under `Sources/` that Atlas or a missing source caused from a real delete.
 * The classifier matches exact path prefixes only: `Sources/whoopx/` is not `Sources/whoop/`.
 *
 * A delete under a PROMOTED source's folder is `missing` when that folder is gone (see `getPromotedRoots`).
 *
 * An expectation is registered BEFORE Atlas unlinks a folder, then matches the deletes that follow. Each
 * match renews it, so a long stream of deletes from a big source keeps matching, and it lapses `ttlMs` after
 * the last one.
 */
export class SourceDeleteClassifier {
	private expectations: Expectation[] = [];
	private readonly now: () => number;
	private readonly ttlMs: number;
	/** Sources Tephra currently reports as missing. */
	private missingByStatus = new Set<string>();

	constructor(private readonly deps: SourceDeleteClassifierDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.ttlMs = deps.ttlMs ?? EXPECTED_DELETE_TTL_MS;
	}

	/** Atlas is about to remove `prefix` (a vault path): it and everything under it are expected deletes. */
	expectPrefix(prefix: string): void {
		this.add((path) => isSameOrUnder(path, prefix));
	}

	/** What the last `source.list` said: these sources' folders are missing. */
	setMissingSources(names: Iterable<string>): void {
		this.missingByStatus = new Set(names);
	}

	classify(path: string): SourceDeleteKind {
		if (!isInSourcesFolder(path)) return "real";
		const now = this.now();
		this.expectations = this.expectations.filter((e) => e.expiresAt > now);
		for (const expectation of this.expectations) {
			if (!expectation.matches(path)) continue;
			expectation.expiresAt = now + this.ttlMs;
			return "expected";
		}
		// A delete inside a promoted folder (`Sources/tephra/crates/tephrad/...`) maps to `tephra` by its first
		// segment, whose link target is still there. The promoted folder itself is what tells: Tephra reports it
		// missing, or it is gone on disk (probed here, because the delete arrives before Tephra's next status).
		// Every promoted root that holds the path counts, so a promoted folder inside a promoted folder is covered.
		for (const root of this.deps.getPromotedRoots?.() ?? []) {
			if (!isSameOrUnder(path, root.vaultPath)) continue;
			if (this.missingByStatus.has(root.name)) return "missing";
			if (root.absRoot !== undefined && !this.deps.targetExists(root.absRoot)) return "missing";
		}
		const name = this.linkNameFor(path);
		if (name === null) return "real";
		if (this.missingByStatus.has(name)) return "missing";
		const target = this.deps.getLinkTargets()[name];
		return target !== undefined && !this.deps.targetExists(target) ? "missing" : "real";
	}

	/** Forgets every expectation (test helper, and plugin teardown). */
	clear(): void {
		this.expectations = [];
	}

	private add(matches: (path: string) => boolean): void {
		this.expectations.push({ matches, expiresAt: this.now() + this.ttlMs });
	}

	/** The linked source `path` is inside (or is the link of): exact name segment, never a longer name that
	 * merely starts the same. */
	private linkNameFor(path: string): string | null {
		const rest = path.slice(SOURCES_FOLDER.length + 1);
		if (rest === "") return null;
		const slash = rest.indexOf("/");
		const name = slash === -1 ? rest : rest.slice(0, slash);
		return Object.prototype.hasOwnProperty.call(this.deps.getLinkTargets(), name) || this.missingByStatus.has(name) ? name : null;
	}
}
