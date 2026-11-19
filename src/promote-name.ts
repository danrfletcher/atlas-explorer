import { folderBaseName, renameRefusalText, slugSourceName } from "./source-name-rules";
import { VAULT_SOURCE_NAME } from "./sources-links";

/**
 * PR-12 (G6): the words of Make its own source / Return to parent. Pure.
 *
 * The name of a new source is G3's rule for a folder, applied to the folder's own name: lowercased, each space
 * `-` (`My Tools` -> `my-tools`), nothing else changed. A folder whose name can't be a source name (`@@@`,
 * unicode) is sent as it is and Tephra's reason is shown: Atlas keeps no second rulebook for it.
 */
export function promotedSourceName(folderPath: string): string {
	return slugSourceName(folderBaseName(folderPath));
}

/** What the confirm calls the source the folder leaves: the vault is "the vault", a source is its own name. */
export function parentLabel(parent: string | null): string {
	return parent === null || parent === VAULT_SOURCE_NAME ? "the vault" : parent;
}

/** The confirm text for Make its own source. It shows the name that will be used. */
export function promoteConfirmText(name: string, parent: string | null): string {
	return `Make ${name} its own source? It will be hidden in ${parentLabel(parent)}.`;
}

/** The confirm text for Return to parent. */
export function returnConfirmText(name: string, parent: string | null): string {
	return `Return ${name} to ${parentLabel(parent)}? Its section goes and the folder comes back in ${parentLabel(parent)}.`;
}

/**
 * The Notice for a request Tephra refused or never answered. A refusal (`rpc`) is Tephra's own sentence word for
 * word (`the name "tephra" is taken by the source "tephra"`, `…is nested inside its root`), after Atlas's lead-in. A
 * call that got no answer is said in Atlas's words (nothing reached Tephra's logic, so there is no reason to quote).
 */
export function promoteRefusalNotice(action: "promote" | "return", name: string, error: { kind: string; message: string }): string {
	const what = action === "promote" ? `make ${name} its own source` : `return ${name} to its parent`;
	return `Atlas: couldn't ${what}: ${renameRefusalText(error)}.`.replace(/\.\.$/, ".");
}
