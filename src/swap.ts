import { App, FuzzyMatch, FuzzySuggestModal, setIcon } from "obsidian";
import { UnitRef, ViewNode, unitRefKey } from "./types";

/** PR-2 (G6): the picker shows at most this many matches. */
export const SWAP_RESULT_CAP = 50;
/** PR-2 (G6): a block's text is cut to this many characters in its picker label. */
export const SWAP_BLOCK_TEXT_LIMIT = 60;

export type SwapCandidateKind = "file" | "folder" | "block";

export interface SwapCandidate {
	kind: SwapCandidateKind;
	ref: UnitRef;
	/** A file's or folder's own name, or `File › block text` for a block. */
	name: string;
	/** Vault path, shown under the name. */
	path: string;
	/** Atlas already knows this as a unit, so picking it needs no hand-promotion (G7). */
	known: boolean;
}

export interface SwapSourceFile {
	path: string;
	name: string;
}

/** A known free or promoted block, with its text already resolved (the picker's list is built synchronously). */
export interface SwapSourceBlock {
	ref: UnitRef;
	text: string;
}

export interface SwapCandidateInput {
	files: SwapSourceFile[];
	folderPaths: string[];
	blocks: SwapSourceBlock[];
	/** `unitRefKey`s of every unit Atlas already knows. */
	knownKeys: ReadonlySet<string>;
	excludedFolders: string[];
	poolFolder: string;
	/** The ref of the item being replaced, if it has one. It is never offered back to itself. */
	replacedRef?: UnitRef;
}

/** Excluded folders (and anything inside them) and dot-folders are kept out of the picker. The pool folder
 * is exempt from exclusion, the same rule `UnitIndex` applies. */
export function isSwapHiddenPath(path: string, excludedFolders: string[], poolFolder: string): boolean {
	if (path.split("/").some((segment) => segment.startsWith("."))) return true;
	if (path === poolFolder || path.startsWith(`${poolFolder}/`)) return false;
	return excludedFolders.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

/** PR-2 (G6): the picker's full candidate list, in the order blocks → files → folders. Blocks come first so
 * a known unit is never shadowed by its plain-file twin: a free block is also a vault file, and the
 * block entry (with its label) wins the shared ref key. */
export function buildSwapCandidates(input: SwapCandidateInput): SwapCandidate[] {
	const out: SwapCandidate[] = [];
	const seen = new Set<string>();
	const replacedKey = input.replacedRef ? unitRefKey(input.replacedRef) : null;
	const add = (candidate: SwapCandidate): void => {
		const key = unitRefKey(candidate.ref);
		if (key === replacedKey || seen.has(key)) return;
		seen.add(key);
		out.push(candidate);
	};
	const hidden = (path: string): boolean => isSwapHiddenPath(path, input.excludedFolders, input.poolFolder);

	for (const block of input.blocks) {
		if (hidden(block.ref.path)) continue;
		const text = block.text.slice(0, SWAP_BLOCK_TEXT_LIMIT) || "(empty block)";
		// PR-2 T10: a free block's ref is its pool file path (`unitToRef` gives it `kind: "file"`, not
		// "block" — only a promoted block gets that), and the pool filename is an auto-generated id that
		// is never shown to users (same rule as every other free-block display). A promoted block's path
		// is a real, recognizable file, so its "File › text" format stays.
		const name = block.ref.kind === "file" ? text : `${basename(block.ref.path)} › ${text}`;
		add({ kind: "block", ref: block.ref, name, path: block.ref.path, known: true });
	}
	for (const file of input.files) {
		if (hidden(file.path)) continue;
		const ref: UnitRef = { kind: "file", path: file.path };
		add({ kind: "file", ref, name: file.name, path: file.path, known: input.knownKeys.has(unitRefKey(ref)) });
	}
	for (const folderPath of input.folderPaths) {
		// The pool exemption covers block and file candidates only: the pool folder is never a folder candidate (T8).
		const inPool = folderPath === input.poolFolder || folderPath.startsWith(`${input.poolFolder}/`);
		if (inPool || hidden(folderPath)) continue;
		const ref: UnitRef = { kind: "folder", path: folderPath };
		add({ kind: "folder", ref, name: basename(folderPath), path: folderPath, known: input.knownKeys.has(unitRefKey(ref)) });
	}
	return out;
}

/** PR-2 (G6): trims a list of matches to the picker's cap. Applied to the fuzzy-matched list, not the
 * candidate list, so a query can still reach a file that sits past the 50th candidate. */
export function limitSwapResults<T>(results: T[]): T[] {
	return results.slice(0, SWAP_RESULT_CAP);
}

/** PR-2 (G2/G4): whether a node can be swapped at all. Data-source rows never reach this (they aren't tree
 * nodes), and a linked-folder node (`folderSourceManaged`) is refused wherever it sits in the view. */
export function canSwapNode(node: ViewNode): boolean {
	return !node.folderSourceManaged;
}

/** PR-2 (G6): the lucide icon drawn beside each picker result, by kind. */
export const SWAP_KIND_ICON: Record<SwapCandidateKind, string> = {
	file: "file",
	folder: "folder",
	block: "text-quote",
};

/** PR-2 (G4): "Swap for Atlas folder" is offered on any swappable item that isn't already an Atlas folder. */
export function canSwapForAtlasFolder(node: ViewNode): boolean {
	return canSwapNode(node) && node.type === "unit";
}

/** PR-2 (G6): the "Swap with…" picker. Its label is the search box placeholder: a prompt-style fuzzy modal
 * does not render its title, so the placeholder is the only visible "Swap with…". Results are the fuzzy
 * matches of `buildSwapCandidates`' list, capped at `SWAP_RESULT_CAP`; a second pick is ignored. */
export class SwapPickerModal extends FuzzySuggestModal<SwapCandidate> {
	private chosen = false;

	constructor(app: App, private candidates: SwapCandidate[], private onChoose: (candidate: SwapCandidate) => void) {
		super(app);
		this.setPlaceholder("Swap with…");
	}

	getItems(): SwapCandidate[] {
		return this.candidates;
	}

	getItemText(candidate: SwapCandidate): string {
		return `${candidate.name} ${candidate.path}`;
	}

	getSuggestions(query: string): FuzzyMatch<SwapCandidate>[] {
		return limitSwapResults(super.getSuggestions(query));
	}

	renderSuggestion(match: FuzzyMatch<SwapCandidate>, el: HTMLElement): void {
		const { item } = match;
		el.addClass("atlas-swap-suggestion");
		setIcon(el.createDiv({ cls: "atlas-swap-icon" }), SWAP_KIND_ICON[item.kind]);
		const text = el.createDiv({ cls: "atlas-swap-text" });
		text.createDiv({ cls: "atlas-swap-name", text: item.name });
		text.createDiv({ cls: "atlas-swap-path", text: `${item.kind} · ${item.path}` });
	}

	onChooseItem(candidate: SwapCandidate): void {
		if (this.chosen) return;
		this.chosen = true;
		this.onChoose(candidate);
	}
}
