import { describe, expect, it, vi } from "vitest";
import * as obsidianMock from "obsidian";
import { App, FuzzyMatch } from "obsidian";
import {
	SWAP_BLOCK_TEXT_LIMIT,
	SWAP_KIND_ICON,
	SWAP_RESULT_CAP,
	SwapCandidate,
	SwapCandidateInput,
	SwapPickerModal,
	buildSwapCandidates,
	canSwapForAtlasFolder,
	canSwapNode,
	isSwapHiddenPath,
	limitSwapResults,
} from "../../src/swap";
import { UnitRef, ViewNode, unitRefKey } from "../../src/types";

const file = (path: string) => ({ path, name: path.split("/").pop()! });
const FILE_KEY = (path: string) => unitRefKey({ kind: "file", path });

function input(over: Partial<SwapCandidateInput> = {}): SwapCandidateInput {
	return {
		files: [],
		folderPaths: [],
		blocks: [],
		knownKeys: new Set(),
		excludedFolders: [],
		poolFolder: "_pool",
		...over,
	};
}

describe("buildSwapCandidates (PR-2 G6): the candidate rules", () => {
	const cases: { name: string; input: SwapCandidateInput; expectPaths: string[] }[] = [
		{
			name: "every file type, attachments included",
			input: input({ files: [file("Note.md"), file("Report.pdf"), file("Photo.png")] }),
			expectPaths: ["Note.md", "Report.pdf", "Photo.png"],
		},
		{
			name: "folders are offered",
			input: input({ folderPaths: ["Boat", "Projects/Career"] }),
			expectPaths: ["Boat", "Projects/Career"],
		},
		{
			name: "excluded folders are absent, and so is anything inside them",
			input: input({
				files: [file("Keep.md"), file("Archive/Old.md")],
				folderPaths: ["Archive", "Archive/Deep", "Keep"],
				excludedFolders: ["Archive"],
			}),
			expectPaths: ["Keep.md", "Keep"],
		},
		{
			name: "dot-folders are absent, at any depth",
			input: input({ folderPaths: [".trash", "Work/.hidden", "Work"], files: [file(".trash/x.md")] }),
			expectPaths: ["Work"],
		},
		{
			name: "the pool folder is exempt from exclusion, as UnitIndex does",
			input: input({ files: [file("_pool/20260101000000-aaaa.md")], excludedFolders: ["_pool"] }),
			expectPaths: ["_pool/20260101000000-aaaa.md"],
		},
		{
			name: "the item being replaced is not offered back",
			input: input({ files: [file("Old.md"), file("New.md")], replacedRef: { kind: "file", path: "Old.md" } }),
			expectPaths: ["New.md"],
		},
		{
			name: "a replaced folder is not offered back either",
			input: input({ folderPaths: ["Boat", "Car"], replacedRef: { kind: "folder", path: "Boat" } }),
			expectPaths: ["Car"],
		},
	];

	it.each(cases)("$name", ({ input: given, expectPaths }) => {
		expect(buildSwapCandidates(given).map((c) => c.path)).toEqual(expectPaths);
	});

	it("labels a block as `File › block text`, cut to 60 characters", () => {
		const long = "x".repeat(SWAP_BLOCK_TEXT_LIMIT + 20);
		const [candidate] = buildSwapCandidates(
			input({ blocks: [{ ref: { kind: "block", path: "Notes.md", subpath: "^abc" }, text: long }] })
		);
		expect(candidate.kind).toBe("block");
		expect(candidate.name).toBe(`Notes.md › ${"x".repeat(SWAP_BLOCK_TEXT_LIMIT)}`);
		expect(candidate.known).toBe(true);
	});

	it("labels an empty block so the row never reads as a bare separator", () => {
		const [candidate] = buildSwapCandidates(input({ blocks: [{ ref: { kind: "block", path: "Notes.md", subpath: "^a" }, text: "" }] }));
		expect(candidate.name).toBe("Notes.md › (empty block)");
	});

	it("a free block that is also a vault file shows once, as a block (blocks are listed first)", () => {
		const freeBlockPath = "_pool/20260101000000-aaaa.md";
		const out = buildSwapCandidates(
			input({
				files: [file(freeBlockPath)],
				blocks: [{ ref: { kind: "file", path: freeBlockPath }, text: "Ideas" }],
				knownKeys: new Set([FILE_KEY(freeBlockPath)]),
			})
		);
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe("block");
	});

	it("marks already-known units, and only those, as known", () => {
		const out = buildSwapCandidates(
			input({ files: [file("Known.md"), file("Stranger.md")], knownKeys: new Set([FILE_KEY("Known.md")]) })
		);
		expect(Object.fromEntries(out.map((c) => [c.path, c.known]))).toEqual({ "Known.md": true, "Stranger.md": false });
	});

	it("keeps a promoted block's own ref, so picking it never creates a second promotion", () => {
		const blockRef: UnitRef = { kind: "block", path: "Notes.md", subpath: "^abc" };
		const [candidate] = buildSwapCandidates(input({ blocks: [{ ref: blockRef, text: "Hi" }] }));
		expect(candidate.ref).toEqual(blockRef);
	});
});

describe("limitSwapResults (PR-2 G6 cap)", () => {
	it("caps at 50", () => {
		expect(SWAP_RESULT_CAP).toBe(50);
		const many = Array.from({ length: 120 }, (_, i) => i);
		expect(limitSwapResults(many)).toHaveLength(50);
	});

	it("an empty query lists the first 50, in order", () => {
		const many = Array.from({ length: 80 }, (_, i) => i);
		expect(limitSwapResults(many)[0]).toBe(0);
		expect(limitSwapResults(many)[49]).toBe(49);
	});

	it("passes a short list through unchanged", () => {
		expect(limitSwapResults([1, 2, 3])).toEqual([1, 2, 3]);
	});
});

describe("isSwapHiddenPath", () => {
	it("hides excluded paths and their children, not a sibling that only shares a prefix", () => {
		expect(isSwapHiddenPath("Archive", ["Archive"], "_pool")).toBe(true);
		expect(isSwapHiddenPath("Archive/x", ["Archive"], "_pool")).toBe(true);
		expect(isSwapHiddenPath("ArchiveNew", ["Archive"], "_pool")).toBe(false);
	});
});

describe("eligibility (PR-2 G1/G2/G4)", () => {
	const node = (over: Partial<ViewNode>): ViewNode => ({ id: "n", type: "unit", ref: { kind: "file", path: "a.md" }, children: [], ...over });

	it("a managed node cannot be swapped at all", () => {
		expect(canSwapNode(node({ folderSourceManaged: true }))).toBe(false);
	});

	it("an ordinary unit or Atlas folder can be swapped", () => {
		expect(canSwapNode(node({}))).toBe(true);
		expect(canSwapNode(node({ type: "meta", label: "Folder", ref: undefined }))).toBe(true);
	});

	it("'Swap for Atlas folder' is offered on units only, never on an Atlas folder", () => {
		expect(canSwapForAtlasFolder(node({}))).toBe(true);
		expect(canSwapForAtlasFolder(node({ type: "meta", label: "Folder", ref: undefined }))).toBe(false);
		expect(canSwapForAtlasFolder(node({ folderSourceManaged: true }))).toBe(false);
	});
});

describe("SwapPickerModal", () => {
	const candidates = buildSwapCandidates(input({ files: [file("A.md"), file("B.md")] }));

	it("getItemText is name plus path, so fuzzy search matches either", () => {
		const modal = new SwapPickerModal(new App(), candidates, vi.fn());
		expect(modal.getItems()).toEqual(candidates);
		expect(modal.getItemText(candidates[0])).toBe("A.md A.md");
	});

	it("shows 'Swap with…' as its visible search placeholder (a prompt-style modal does not render its title)", () => {
		const modal = new SwapPickerModal(new App(), candidates, vi.fn());
		expect(modal.placeholder).toBe("Swap with…");
	});

	it("fuzzy-matches the typed query against name and path", () => {
		const modal = new SwapPickerModal(new App(), buildSwapCandidates(input({ files: [file("Customer Discovery.md"), file("Boat.md")] })), vi.fn());
		expect(modal.getSuggestions("Customer Disc").map((m) => m.item.path)).toEqual(["Customer Discovery.md"]);
	});

	it("draws a type icon for each result: file, folder or block (G6)", () => {
		const setIconSpy = vi.spyOn(obsidianMock, "setIcon");
		const modal = new SwapPickerModal(new App(), candidates, vi.fn());
		const kinds = buildSwapCandidates(
			input({
				files: [file("A.md")],
				folderPaths: ["Boat"],
				blocks: [{ ref: { kind: "block", path: "Notes.md", subpath: "^a" }, text: "Hi" }],
			})
		);
		for (const candidate of kinds) {
			const el = document.createElement("div");
			modal.renderSuggestion({ item: candidate, match: { score: 0, matches: [] } } as FuzzyMatch<SwapCandidate>, el);
			expect(setIconSpy).toHaveBeenLastCalledWith(expect.any(HTMLElement), SWAP_KIND_ICON[candidate.kind]);
			expect(el.querySelector(".atlas-swap-name")?.textContent).toBe(candidate.name);
			expect(el.querySelector(".atlas-swap-path")?.textContent).toBe(`${candidate.kind} · ${candidate.path}`);
		}
		expect(SWAP_KIND_ICON).toEqual({ file: "file", folder: "folder", block: "text-quote" });
		setIconSpy.mockRestore();
	});

	it("a double pick applies the swap once", () => {
		const onChoose = vi.fn();
		const modal = new SwapPickerModal(new App(), candidates, onChoose);
		modal.onChooseItem(candidates[1]);
		modal.onChooseItem(candidates[1]);
		expect(onChoose).toHaveBeenCalledTimes(1);
		expect(onChoose).toHaveBeenCalledWith(candidates[1]);
	});
});
