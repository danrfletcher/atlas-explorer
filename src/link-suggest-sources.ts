/**
 * G8 — the sources the `[[@` popup lists. Computed per call from what Atlas already has in memory (the
 * connection's last `source.list`, the recorded links, the folders under `Sources/`); nothing is stored
 * (F1).
 */
import { NOTES_SOURCE } from "./source-links";
import type { TephraSource, TephraSourceStatus } from "./tephra-client";

export interface KnownSource {
	name: string;
	status: TephraSourceStatus;
}

export interface KnownSourcesInput {
	/** The last `source.list` while Tephra is online; null when it isn't (then the fallbacks below are used). */
	online: readonly TephraSource[] | null;
	/** Names Atlas has linked into `Sources/` (`settings.tephraLinks`). */
	linkedNames: readonly string[];
	/** Folder names found under the vault's `Sources/`. */
	folderNames: readonly string[];
}

/**
 * Every source the popup can offer: the vault (`notes`) first, then the rest A–Z. Online, Tephra's own
 * list is the answer (it knows which are missing, E5). Offline (G13/E1), the sources Atlas already linked
 * and the folders under `Sources/` stand in, so `[[@name:text` keeps working.
 */
export function knownSources(input: KnownSourcesInput): KnownSource[] {
	const byLower = new Map<string, KnownSource>();
	const add = (name: string, status: TephraSourceStatus) => {
		const key = name.toLowerCase();
		if (key === "" || key === NOTES_SOURCE || byLower.has(key)) return;
		byLower.set(key, { name, status });
	};
	if (input.online) {
		for (const source of input.online) add(source.name, source.status);
	} else {
		for (const name of input.linkedNames) add(name, "offline");
		for (const name of input.folderNames) add(name, "offline");
	}
	const rest = [...byLower.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	return [{ name: NOTES_SOURCE, status: "online" }, ...rest];
}

/** Case-insensitive lookup of a typed source name; null when unknown. */
export function findKnownSource(sources: readonly KnownSource[], typed: string): KnownSource | null {
	const wanted = typed.toLowerCase();
	return sources.find((source) => source.name.toLowerCase() === wanted) ?? null;
}
