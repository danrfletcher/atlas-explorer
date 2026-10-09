import { App, TFile, TFolder } from "obsidian";
import type { AtlasSettings } from "./settings";

/** F3: the folder's interface note, if one exists under the configured convention (or the
 * accepted `index.md` / `README.md` fallback names). Null means the folder-unit has no interface
 * note yet — the caller offers to create one rather than treating this as an error. */
export function findInterfaceNote(app: App, folder: TFolder, settings: AtlasSettings): TFile | null {
	const conventional = app.vault.getAbstractFileByPath(`${folder.path}/${folder.name}.md`);
	if (conventional instanceof TFile) return conventional;

	// PR-1.F1 T1: a case-variant sibling (e.g. `deep.md` where `Deep.md` is the convention) is the
	// same file on a case-insensitive filesystem, even though the vault index treats the two paths
	// as distinct. Without this, `findInterfaceNote` misses it, so a caller that falls back to
	// `createInterfaceNote` (link-suggest's `[[` pick) throws an uncaught "File already exists"
	// instead of using the note that's already there.
	const conventionalName = `${folder.name}.md`.toLowerCase();
	const caseVariant = folder.children.find(
		(child): child is TFile => child instanceof TFile && child.name.toLowerCase() === conventionalName
	);
	if (caseVariant) return caseVariant;

	if (settings.interfaceNoteAcceptAltNames) {
		for (const altName of ["index.md", "README.md"]) {
			const alt = app.vault.getAbstractFileByPath(`${folder.path}/${altName}`);
			if (alt instanceof TFile) return alt;
		}
	}
	return null;
}

/** Creates `<Folder>/<Folder>.md` with a one-line H1. Never overwrites an existing note — callers
 * should check `findInterfaceNote` first and only call this when it returned null. */
export async function createInterfaceNote(app: App, folder: TFolder): Promise<TFile> {
	const path = `${folder.path}/${folder.name}.md`;
	return app.vault.create(path, `# ${folder.name}\n`);
}
