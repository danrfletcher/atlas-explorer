import { AddUnderNamedDeps, startAddUnderNamed } from "./add-under-named";
import { ViewNode } from "./types";

/** PR-3.F3 (G3): "Add under… > Module" on the clicked row — a real folder-plus-note module at the
 * vault root, nested as the clicked row's last child. The flow itself is
 * `startAddUnderNamed("module", …)` in `add-under-named.ts`, shared with File so the two can't
 * drift; this file only names the Module entry point and its deps. Unlike File, Module flushes
 * `data.json` after the add, so `save` is required. */
export type AddUnderModuleDeps = AddUnderNamedDeps & { save(): Promise<void> };

/** Creates `<name>/<name>.md` at the vault root (body `# <name>`) and nests the folder ref as the
 * clicked row's last child. Resolves to the new node, or `null` on a held lock, cancel or any failure. */
export function startAddUnderModule(deps: AddUnderModuleDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	return startAddUnderNamed("module", deps, viewId, parentId);
}
