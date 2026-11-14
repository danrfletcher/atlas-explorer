import type { App } from "obsidian";
import { openNameDialog } from "./name-dialog";
import { SOURCES_FOLDER, isInSourcesFolder } from "./sources-path";
import { VAULT_SOURCE_NAME, errorCode, normalizeRoot, type SourcesFs } from "./sources-links";
import { folderBaseName, slugSourceName, validateSourceName } from "./source-name-rules";
import { parseTephraSources, type TephraCallResult, type TephraError, type TephraSource } from "./tephra-client";
import type { TephraSnapshot } from "./tephra-connection";
import type { RemoveSourceLinkOutcome } from "./sources-folder";

/** G3/G5: what the Add and Remove flows need from the live Tephra connection. */
export interface SourceActionsConnection {
	getSnapshot(): TephraSnapshot;
	call(method: string, params?: unknown): Promise<TephraCallResult>;
	/** Asks for a `source.list` check now; the result reaches the `Sources/` folder and the Inbox through the
	 * connection's own listeners. */
	requestCheck(): void;
}

export interface SourceActionsDeps {
	app: App;
	/** The live connection, or null while the Tephra toggle is off (or on mobile). Never created here. */
	getConnection: () => SourceActionsConnection | null;
	/** The system folder picker (`pickFolder` in production): the chosen path, `null` on cancel. */
	pickFolder: () => Promise<string | null>;
	/** The vault's folder on disk; null when there isn't one. */
	getVaultPath: () => string | null;
	fs: Pick<SourcesFs, "lstat" | "readdir">;
	/** Resolves symlinks in a path (`fs.promises.realpath`), so a folder chosen through a link is still seen to be inside the vault. */
	realpath: (path: string) => Promise<string>;
	sourcesFolder: { removeSource(name: string, remaining: TephraSource[]): Promise<RemoveSourceLinkOutcome> };
	/** Shows a confirm and calls `onConfirm` only when the user confirms (`ConfirmModal` in production). */
	confirm: (message: string, confirmLabel: string, onConfirm: () => void) => void;
	notify: (message: string) => void;
	/** The name dialog; replaced by tests only. */
	openNameDialog?: typeof openNameDialog;
}

export const TEPHRA_NOT_RUNNING = "Tephra isn't running";

/** The reason Tephra gave, without Atlas's own "Tephra error:" prefix. */
function refusalText(error: TephraError): string {
	if (error.kind === "network" || error.kind === "no-token") return TEPHRA_NOT_RUNNING;
	return error.message.replace(/^Tephra error:\s*/, "");
}

/** Tephra's answer when a source is already gone (removed with `tephractl`): the goal is met. */
function isNoSuchSource(error: TephraError): boolean {
	return error.kind === "rpc" && /no source named/i.test(error.message);
}

function trimTrailingSlashes(path: string): string {
	return normalizeRoot(path) ?? path.replace(/[\\/]+$/, "");
}

/** Whether `path` exists as anything at all, a dangling link included (`lstat` doesn't follow links). */
async function existsAsEntry(fs: Pick<SourcesFs, "lstat">, path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function insideOrSame(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/**
 * PR-5 (G3, G5): Add source and Remove source, driven from the Inbox. Both only run while the Tephra
 * toggle is on (the caller has no connection otherwise) and both refuse with a notice, before any request,
 * when Tephra isn't answering: Atlas never starts Tephra (F7).
 *
 * Add sends one `source.register { name, root }` and never sends it twice: a timeout is not retried, it is
 * followed by a fresh `source.list`. Remove sends one `source.unregister { name }`, then has the `Sources/`
 * folder code drop the link (the filesystem `unlink` of the link alone: nothing is deleted through the vault,
 * and the files under the source's own folder are never touched). After either request succeeds Atlas asks
 * the connection for a check at once, because Tephra announces no `graph:changed` for it today.
 */
export class SourceActions {
	/** Source names with a Remove in flight: a second confirm for the same name sends nothing. */
	private removing = new Set<string>();
	private adding = false;

	constructor(private readonly deps: SourceActionsDeps) {}

	/** G3: "Add source…". */
	async addSource(): Promise<void> {
		if (this.adding) return;
		const connection = this.liveConnection();
		if (!connection) return;
		this.adding = true;
		try {
			let picked: string | null;
			try {
				picked = await this.deps.pickFolder();
			} catch (error) {
				this.deps.notify(`Atlas: couldn't open the folder picker (${error instanceof Error ? error.message : String(error)}).`);
				return;
			}
			if (picked === null) return; // cancelled: no dialog, no request
			const root = trimTrailingSlashes(picked);
			const refusal = await this.refusalForFolder(root);
			if (refusal !== null) {
				this.deps.notify(`Atlas: ${refusal}`);
				return;
			}
			await this.askForName(connection, root);
		} finally {
			this.adding = false;
		}
	}

	/** G5: the confirm and the removal behind a source section's "Remove". */
	removeSource(name: string): void {
		if (name === VAULT_SOURCE_NAME) return; // the vault is never removed from here
		const connection = this.liveConnection();
		if (!connection) return;
		this.deps.confirm(`Remove source ${name}? Its files on disk are not touched; links to it will show as broken.`, "Remove", () => void this.unregister(name));
	}

	/** Tephra answered and is online, or a notice says it isn't (and nothing goes any further). */
	private liveConnection(): SourceActionsConnection | null {
		const connection = this.deps.getConnection();
		if (!connection || connection.getSnapshot().state !== "online") {
			this.deps.notify(`Atlas: ${TEPHRA_NOT_RUNNING}.`);
			return null;
		}
		return connection;
	}

	/** Why this folder can't be a source, or null. Inside the vault, the vault itself and `Sources/…` all fail, by real path too. */
	private async refusalForFolder(root: string): Promise<string | null> {
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath === null) return "this vault has no folder on disk, so a source can't be checked against it.";
		const forms = async (path: string): Promise<string[]> => {
			const real = await this.deps.realpath(path).catch(() => path);
			return [...new Set([trimTrailingSlashes(path), trimTrailingSlashes(real)])];
		};
		const [folderForms, vaultForms] = [await forms(root), await forms(vaultPath)];
		for (const vault of vaultForms) {
			for (const folder of folderForms) {
				if (!insideOrSame(folder, vault)) continue;
				if (folder === vault) return "that folder is the vault itself. Pick a folder outside the vault.";
				const rest = folder.slice(vault.length + 1);
				if (isInSourcesFolder(rest)) return `that folder is inside the vault's ${SOURCES_FOLDER} folder, which Atlas manages. Pick the source's own folder.`;
				return "that folder is inside the vault. Pick a folder outside it.";
			}
		}
		return null;
	}

	/** Names of what `Sources/` holds now (anything: a folder, a note, a stray link); empty when it isn't there. */
	private async sourcesEntries(): Promise<string[]> {
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath === null) return [];
		try {
			return await this.deps.fs.readdir(`${vaultPath}/${SOURCES_FOLDER}`);
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
			throw error;
		}
	}

	private async askForName(connection: SourceActionsConnection, root: string): Promise<void> {
		let sourcesEntries: string[];
		try {
			sourcesEntries = await this.sourcesEntries();
		} catch (error) {
			this.deps.notify(`Atlas: couldn't read ${SOURCES_FOLDER}/ (${errorCode(error) ?? "unknown error"}), so no source was added.`);
			return;
		}
		const open = this.deps.openNameDialog ?? openNameDialog;
		await open(this.deps.app, {
			title: "Add source",
			confirmLabel: "Add",
			initialValue: slugSourceName(folderBaseName(root)),
			// The registered names are read on every keystroke, so a source added elsewhere while the dialog is open is caught.
			validate: (name) => validateSourceName(name, { registered: connection.getSnapshot().sources.map((s) => s.name), sourcesEntries }),
			onSubmit: (name) => this.register(connection, name, root),
		});
	}

	/** One `source.register`. Resolves a reason to keep the dialog open, or null when it is done with. */
	private async register(connection: SourceActionsConnection, name: string, root: string): Promise<string | null> {
		// Checked at the moment of confirming, with `lstat` (it sees a link, even a dangling one), so an entry that
		// appeared while the dialog was open stops the request; on a case-insensitive disk the lookup matches too.
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath !== null) {
			try {
				if (await existsAsEntry(this.deps.fs, `${vaultPath}/${SOURCES_FOLDER}/${name}`)) return `${SOURCES_FOLDER}/${name} already exists in the vault`;
			} catch (error) {
				return `Couldn't check ${SOURCES_FOLDER}/${name} (${errorCode(error) ?? "unknown error"})`;
			}
		}
		const result = await connection.call("source.register", { name, root });
		if (result.ok) {
			connection.requestCheck(); // the section and `Sources/<name>` appear now, not at the next 10 s check
			return null;
		}
		if (result.error.kind === "timeout") {
			// The request may have reached Tephra: it is NOT sent again (a resent register reached the daemon twice).
			await this.confirmAfterTimeout(connection, name);
			return null;
		}
		return refusalText(result.error);
	}

	private async confirmAfterTimeout(connection: SourceActionsConnection, name: string): Promise<void> {
		const listed = await connection.call("source.list");
		const found = listed.ok && Array.isArray(listed.result) && parseTephraSources(listed.result).some((source) => source.name.toLowerCase() === name.toLowerCase());
		if (found) connection.requestCheck(); // the new section shows through the normal path
		else this.deps.notify(`Atlas: Couldn't confirm ${name} was added.`);
	}

	private async unregister(name: string): Promise<void> {
		if (this.removing.has(name)) return;
		this.removing.add(name);
		try {
			const connection = this.liveConnection();
			if (!connection) return;
			const result = await connection.call("source.unregister", { name });
			// "no source named …" means it is already gone (removed with `tephractl`): done, and no error.
			if (!result.ok && !isNoSuchSource(result.error)) {
				this.deps.notify(`Atlas: couldn't remove ${name}: ${refusalText(result.error)}`);
				return;
			}
			connection.requestCheck(); // the section goes now, not at the next 10 s check
			const remaining = connection.getSnapshot().sources.filter((source) => source.name !== name);
			const outcome = await this.deps.sourcesFolder.removeSource(name, remaining);
			if (outcome === "real-folder") {
				this.deps.notify(`Atlas: ${name} is no longer a source, but ${SOURCES_FOLDER}/${name} is a real folder, not a link, so Atlas left it alone.`);
			} else if (outcome === "kept") {
				this.deps.notify(`Atlas: ${name} is no longer a source, but ${SOURCES_FOLDER}/${name} is a link Atlas didn't make, so Atlas left it alone.`);
			} else if (outcome === "failed") {
				this.deps.notify(`Atlas: ${name} is no longer a source, but Atlas couldn't remove ${SOURCES_FOLDER}/${name}. See the developer console.`);
			}
		} finally {
			this.removing.delete(name);
		}
	}
}
