import { AddUnderNamedDeps, startAddUnderNamed } from "./add-under-named";
import { ViewNode } from "./types";

/** PR-3.F2 (G2): "Add under… > File" on the clicked row — a real note at the vault root, nested as
 * the clicked row's last child. The flow itself is `startAddUnderNamed("file", …)` in
 * `add-under-named.ts`, shared with Module so the two can't drift; this file only names the File
 * entry point and its deps. File never saves explicitly, so it takes no `save` dep. */
export type AddUnderFileDeps = Omit<AddUnderNamedDeps, "save">;

/** Creates `<name>.md` at the vault root (body `# <name>`) and nests it as the clicked row's last
 * child. Resolves to the new node, or `null` on a held lock, cancel or any failure. */
export function startAddUnderFile(deps: AddUnderFileDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	return startAddUnderNamed("file", deps, viewId, parentId);
}
