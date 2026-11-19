/**
 * PR-5 (G3): the system folder picker, in one place so a test can stand in for it. Obsidian's desktop app is
 * Electron: the picker is `dialog.showOpenDialog` with `openDirectory`. Nothing else in Atlas opens it.
 *
 * Resolves the chosen absolute folder path, or `null` when the user cancels. Throws when this Obsidian
 * doesn't expose the picker (the caller says so in a Notice); it never falls back to a made-up path.
 */
export async function pickFolder(): Promise<string | null> {
	const dialog = findDialog();
	if (!dialog) throw new Error("The folder picker isn't available in this version of Obsidian");
	const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose a folder to add as a source" });
	if (result.canceled) return null;
	const [first] = result.filePaths;
	return typeof first === "string" && first.length > 0 ? first : null;
}

interface OpenDialogResult {
	canceled: boolean;
	filePaths: string[];
}

interface ElectronDialog {
	showOpenDialog(options: { properties: string[]; title?: string }): Promise<OpenDialogResult>;
}

/** Obsidian exposes Electron's `dialog` through `electron.remote`; `window.require` is how a plugin reaches it. */
function findDialog(): ElectronDialog | null {
	const globalRequire = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof globalRequire !== "function") return null;
	try {
		const electron = globalRequire("electron") as { remote?: { dialog?: ElectronDialog } } | undefined;
		const dialog = electron?.remote?.dialog;
		return dialog && typeof dialog.showOpenDialog === "function" ? dialog : null;
	} catch {
		return null;
	}
}
