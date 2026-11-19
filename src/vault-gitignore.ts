import { SOURCES_FOLDER } from "./sources-path";
import { errorCode, type SourcesFs } from "./sources-links";

/** The one line Atlas adds to the vault-root `.gitignore` (G2). */
export const GITIGNORE_LINE = `${SOURCES_FOLDER}/`;

/** Lines that already ignore the `Sources` folder, so adding another would only duplicate them. */
function ignoresSourcesFolder(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === `${SOURCES_FOLDER}/` || trimmed === `/${SOURCES_FOLDER}/` || trimmed === SOURCES_FOLDER || trimmed === `/${SOURCES_FOLDER}`;
}

/**
 * G2: makes sure the vault-root `.gitignore` ignores `Sources/`. The file is created when it's missing; when it
 * exists it is only ever appended to (existing lines, their order and line endings are kept), starting a new
 * line first if the last one has no newline, and ending with a newline. Does nothing when a line already
 * ignores `Sources`. Returns whether the file was written. Turning the toggle off never removes the line.
 */
export async function ensureGitignoreLine(fs: SourcesFs, vaultPath: string): Promise<boolean> {
	const path = `${vaultPath}/.gitignore`;
	let existing: string | null = null;
	try {
		existing = await fs.readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	if (existing === null) {
		await fs.appendFile(path, `${GITIGNORE_LINE}\n`);
		return true;
	}
	if (existing.split(/\r?\n/).some(ignoresSourcesFolder)) return false;
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	const needsBreak = existing.length > 0 && !existing.endsWith("\n");
	await fs.appendFile(path, `${needsBreak ? eol : ""}${GITIGNORE_LINE}${eol}`);
	return true;
}
