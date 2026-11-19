import { Notice } from "obsidian";
import type { App, TFile } from "obsidian";

/** G7: which opener a file under `Sources/<name>/` gets. A source file is an ordinary vault file, so it opens
 * the way a vault file does: in Obsidian when Obsidian has a view for its extension (core types, plus whatever
 * VS Code Workbench or another plugin registered), otherwise in the file's own macOS app through Obsidian's
 * default-app path. `chooseOpener` is the one rule and is pure; `openSourceFile` applies it. */

export type Opener = "obsidian" | "default-app";

/** F8: Word, PowerPoint, Excel and Google Docs/Sheets files are never edited in Obsidian. They go to the
 * default app even when some plugin has registered a markdown/text view for the extension, so this list
 * beats the registry. PDF is not here: it is opened, read-only, by Obsidian's own PDF view (core registers
 * `pdf`, and Obsidian refuses a second registration of an existing extension, so no plugin can swap an editor
 * in); if the live registry has no `pdf` entry it falls to the default app like any unregistered type, never to
 * a text editor. */
export const DEFAULT_APP_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(["doc", "docx", "ppt", "pptx", "xls", "xlsx", "gdoc", "gsheet"]);

/** Extensions Obsidian's own views handle. The live registry is the source of truth; this list is only the
 * fallback used when the registry can't be read at all (it is not in the public API), so notes, images and
 * PDFs still go to Obsidian. A registry that WAS read is never topped up from it: `canvas` and `base` come
 * from core plugins the user can switch off, and Obsidian then drops them from the registry. */
export const CORE_EXTENSIONS: readonly string[] = [
	"md", "canvas", "base", "pdf",
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif",
	"mp3", "wav", "m4a", "ogg", "3gp", "flac", "mp4", "webm", "ogv", "mov", "mkv",
];

/** The one rule. `registered` holds lower-case extensions without the dot; the file's extension is lower-cased
 * here, so `.PDF` is `.pdf`. A file with no extension (`Makefile`, `LICENSE`) uses a registered view for the
 * empty extension if there is one, otherwise the default app. */
export function chooseOpener(file: { extension: string }, registered: ReadonlySet<string>): Opener {
	const ext = file.extension.toLowerCase();
	if (DEFAULT_APP_ONLY_EXTENSIONS.has(ext)) return "default-app";
	return registered.has(ext) ? "obsidian" : "default-app";
}

/** The internals this file reads. Neither is in Obsidian's typings; both exist in the desktop app. */
interface AppInternals {
	viewRegistry?: { typeByExtension?: Record<string, string> };
	openWithDefaultApp?: (path: string) => Promise<void> | void;
}

/** Every extension Obsidian has a view for right now, lower-cased. Exactly the live registry's keys when it can
 * be read (an object); `CORE_EXTENSIONS` only when it can't (missing or not an object). */
export function registeredExtensions(app: App): Set<string> {
	const byExtension = (app as unknown as AppInternals).viewRegistry?.typeByExtension;
	if (!byExtension || typeof byExtension !== "object") return new Set<string>(CORE_EXTENSIONS);
	return new Set<string>(Object.keys(byExtension).map((ext) => ext.toLowerCase()));
}

/** Opens `file` (a real vault `TFile`) by the rule. Never throws: a failed open (an unreadable symlink
 * target, say) shows Obsidian's own error, is logged, and leaves nothing half-done. Never writes. Returns
 * the opener used, or null when the open failed. */
export async function openSourceFile(app: App, file: TFile, newTab: boolean): Promise<Opener | null> {
	const opener = chooseOpener(file, registeredExtensions(app));
	try {
		if (opener === "obsidian") {
			await app.workspace.getLeaf(newTab).openFile(file);
		} else {
			const open = (app as unknown as AppInternals).openWithDefaultApp;
			if (typeof open !== "function") {
				new Notice(`Atlas: this Obsidian can't open ${file.name} in its default app.`);
				console.warn(`[Atlas] app.openWithDefaultApp is not available; "${file.path}" was not opened.`);
				return null;
			}
			await open.call(app, file.path);
		}
		return opener;
	} catch (error) {
		console.error(`[Atlas] Could not open "${file.path}"`, error);
		return null;
	}
}

/** Opens the block `subpath` (`^id`) inside `file`, a real vault `TFile` under `Sources/`, in an Obsidian tab.
 * Goes through `openFile` with the subpath as view state and never `openLinkText`: Obsidian's link resolver
 * can't resolve a path that runs through a `Sources/<name>` folder link (observed in 1.14.4), so
 * `openLinkText("Sources/<name>/<file>#^id")` treats it as unresolved and creates a new note in the user's real
 * folder. Never writes. Returns false when the open failed. */
export async function openSourceBlock(app: App, file: TFile, subpath: string, newTab: boolean): Promise<boolean> {
	try {
		await app.workspace.getLeaf(newTab).openFile(file, { eState: { subpath: subpath.startsWith("#") ? subpath : `#${subpath}` } });
		return true;
	} catch (error) {
		console.error(`[Atlas] Could not open "${file.path}${subpath}"`, error);
		return false;
	}
}
