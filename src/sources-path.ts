/** The vault-root folder that holds Atlas's `Sources/<name>` folder links (G2). */
export const SOURCES_FOLDER = "Sources";

/** `path` is the `Sources` entry itself or anything below it. `SourcesX` and `Sources.md` are not. */
export function isInSourcesFolder(path: string): boolean {
	return path === SOURCES_FOLDER || path.startsWith(`${SOURCES_FOLDER}/`);
}

/** The vault path of one source's link: `Sources/<name>`. */
export function sourceLinkPath(name: string): string {
	return `${SOURCES_FOLDER}/${name}`;
}

/** Exact prefix rule (R3-4): `path` is `prefix` itself or lives under `prefix/`. `Sources/whoopx/a.md` is
 * not under `Sources/whoop`. */
export function isSameOrUnder(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** R3-1: with the Tephra toggle on (and this is desktop), the vault-side index, promotions and graduation
 * skip `Sources/` completely. With it off a real user folder called `Sources` is an ordinary module. */
export function skipsSourcesFolder(settings: { tephraEnabled: boolean }, isMobile: boolean): boolean {
	return settings.tephraEnabled === true && !isMobile;
}
