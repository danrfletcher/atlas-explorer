import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ViewsManager } from "../../src/views";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { SwapCandidate, SwapPickerModal } from "../../src/swap";
import { UnitRef, View, ViewNode, unitRefKey, unitToRef } from "../../src/types";
import { Setup, clone, file, folder, meta, setup, unit } from "./create-from-meta-fixtures";

// PR-2 end-to-end: the Swap actions run through the real explorer methods (`swapPicked`,
// `openSwapForFolder`) against a real ViewsManager and UnitIndex. The swap must never touch the vault.
const captured = vi.hoisted(() => ({ prompts: [] as { title: string; initial: string; onSubmit: (v: string) => void }[] }));

vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingPrompt {
		constructor(_app: unknown, public title: string, public initial: string, public onSubmit: (v: string) => void) {
			captured.prompts.push(this);
		}
		open(): void {}
	}
	return { ...actual, TextPromptModal: RecordingPrompt };
});

type Fake = Record<string, any>;
const explorerProto = AtlasExplorerView.prototype as unknown as Record<string, (this: Fake, ...args: unknown[]) => any>;
const BOAT_FILE: UnitRef = { kind: "file", path: "Boat.md" };
const BOAT_FOLDER: UnitRef = { kind: "folder", path: "Boat" };
const notices = () => Notice.instances.map((n) => n.message);

let s: Setup;
let fake: Fake;
let flushSave: ReturnType<typeof vi.fn>;
let vaultSpies: { create: ReturnType<typeof vi.spyOn>; delete: ReturnType<typeof vi.spyOn>; rename: ReturnType<typeof vi.spyOn>; renameFile: ReturnType<typeof vi.spyOn> };
let queueRender: ReturnType<typeof vi.fn>;

/** A real explorer method set bound to a plain object, wired to the real `s.views`/`s.index`. */
function explorerFor(setupState: Setup): Fake {
	const f: Fake = Object.create(AtlasExplorerView.prototype);
	Object.assign(f, {
		plugin: {
			app: setupState.app,
			settings: DEFAULT_SETTINGS,
			viewsManager: setupState.views,
			unitIndex: setupState.index,
			statusesManager: setupState.statuses,
			flushSave,
		},
		queueRender,
	});
	return f;
}

function viewOf(root: ViewNode[]): View {
	return { id: "default", name: "Default", inboxMode: "view", root };
}

function boot(root: ViewNode[], extra: Partial<Parameters<typeof setup>[1]> = {}): { view: View; spot: ViewNode } {
	s = setup(root, extra);
	flushSave = vi.fn(async () => void s.persist());
	queueRender = vi.fn();
	fake = explorerFor(s);
	vaultSpies = {
		create: vi.spyOn(s.app.vault, "create"),
		delete: vi.spyOn(s.app.vault, "delete"),
		rename: vi.spyOn(s.app.vault, "rename"),
		renameFile: vi.spyOn(s.app.fileManager, "renameFile"),
	};
	const view = s.views.getView("default")!;
	return { view, spot: view.root[0] };
}

function vaultWasUntouched(): void {
	expect(vaultSpies.create).not.toHaveBeenCalled();
	expect(vaultSpies.delete).not.toHaveBeenCalled();
	expect(vaultSpies.rename).not.toHaveBeenCalled();
	expect(vaultSpies.renameFile).not.toHaveBeenCalled();
}

async function swapPicked(view: View, node: ViewNode, candidate: SwapCandidate): Promise<void> {
	await explorerProto.swapPicked.call(fake, view, node, candidate);
}

const candidate = (kind: SwapCandidate["kind"], ref: UnitRef, name: string, known = true): SwapCandidate => ({
	kind,
	ref,
	name,
	path: ref.path,
	known,
});

beforeEach(() => {
	Notice.reset();
	captured.prompts.length = 0;
});

describe("GP1: swap a placed file for another file, in place", () => {
	it("rewrites the spot to the picked file, keeps id and position, and saves", async () => {
		const { view } = boot([unit("A", folder("Archive")), unit("spot", file("Existing.md")), unit("B", folder("Sub"))]);
		await swapPicked(view, view.root[1], candidate("file", file("Report.pdf"), "Report.pdf"));
		const root = s.views.getView("default")!.root;
		expect(root.map((n) => n.id)).toEqual(["A", "spot", "B"]);
		expect(root[1]).toMatchObject({ id: "spot", type: "unit", ref: file("Report.pdf") });
		expect(flushSave).toHaveBeenCalledTimes(1);
		expect(s.persist).toHaveBeenCalled();
		expect(queueRender).toHaveBeenCalledTimes(1);
		vaultWasUntouched();
	});
});

describe("GP2: swap a placed item for a folder", () => {
	it("turns the spot into a folder unit with its nested children intact", async () => {
		const kids = [unit("k1", file("Sub/Nested Note.md"))];
		const { view } = boot([meta("spot", "Interviews", kids)]);
		await swapPicked(view, view.root[0], candidate("folder", folder("Archive"), "Archive"));
		const node = s.views.getView("default")!.root[0];
		expect(node).toMatchObject({ id: "spot", type: "unit", ref: folder("Archive") });
		expect(node.children).toEqual(kids);
		vaultWasUntouched();
	});
});

describe("GP3: swap to a block", () => {
	it("a known block becomes the spot's ref without creating a new promotion", async () => {
		const { view } = boot([unit("spot", file("Existing.md"))]);
		const freeBlock = s.index.getUnits().find((u) => u.type === "free-block");
		expect(freeBlock).toBeDefined();
		const blockRef = unitToRef(freeBlock!);
		const unitsBefore = s.index.getUnits().length;
		await swapPicked(view, view.root[0], candidate("block", blockRef, "Ideas", true));
		expect(s.views.getView("default")!.root[0].ref).toEqual(blockRef);
		expect(s.index.getUnits().length).toBe(unitsBefore);
		expect(notices()).toEqual([]);
		vaultWasUntouched();
	});
});

describe("GP4: swap a folder unit back to a file unit", () => {
	it("works in both directions", async () => {
		const { view } = boot([unit("spot", folder("Archive"))]);
		await swapPicked(view, view.root[0], candidate("file", file("Existing.md"), "Existing.md"));
		expect(s.views.getView("default")!.root[0].ref).toEqual(file("Existing.md"));
		vaultWasUntouched();
	});
});

describe("E1: a candidate that has vanished changes nothing", () => {
	it("shows the notice, leaves the spot alone, and does not save", async () => {
		const { view } = boot([unit("spot", file("Existing.md"))]);
		const before = clone(s.views.getView("default")!.root);
		await swapPicked(view, view.root[0], candidate("file", file("Gone.md"), "Gone.md"));
		expect(notices()).toEqual(["Couldn't find Gone.md, nothing changed."]);
		expect(s.views.getView("default")!.root).toEqual(before);
		expect(flushSave).not.toHaveBeenCalled();
		vaultWasUntouched();
	});
});

describe("E2/E3: picking something already placed elsewhere makes a duplicate", () => {
	it("both places keep the item; the swapped-in spot is a second copy", async () => {
		const { view } = boot([unit("other", file("Existing.md")), unit("spot", file("Reading list.md"))]);
		await swapPicked(view, view.root[1], candidate("file", file("Existing.md"), "Existing.md"));
		const root = s.views.getView("default")!.root;
		expect(root[0].ref).toEqual(file("Existing.md"));
		expect(root[1].ref).toEqual(file("Existing.md"));
		expect(s.views.isPlacedAnywhere(file("Existing.md"))).toBe(true);
		vaultWasUntouched();
	});
});

describe("G7: an unknown file is promoted, not refused", () => {
	it("a file the index does not list is added as a manual promotion, then placed", async () => {
		// `_to_delete` is excluded, so UnitIndex has no unit for a file there until it is promoted.
		s = setup([unit("spot", file("Existing.md"))]);
		s.app.vault.seedFolder("_to_delete");
		s.app.vault.seedFile("_to_delete/Gone.md");
		s.index.rebuild();
		flushSave = vi.fn(async () => void s.persist());
		queueRender = vi.fn();
		fake = explorerFor(s);
		const ref = file("_to_delete/Gone.md");
		expect(s.index.getUnits().some((u) => unitRefKey(unitToRef(u)) === unitRefKey(ref))).toBe(false);

		await swapPicked(s.views.getView("default")!, s.views.getView("default")!.root[0], candidate("file", ref, "Gone.md", false));

		expect(s.views.getView("default")!.root[0].ref).toEqual(ref);
		expect(s.index.getUnits().some((u) => unitRefKey(unitToRef(u)) === unitRefKey(ref))).toBe(true);
		expect(notices()).toEqual([]);
		vaultWasUntouched();
	});
});

describe("G12: a swapped-away item returns to the Inbox", () => {
	it("after the swap, the old file is no longer placed and the new one is", async () => {
		const { view } = boot([unit("spot", BOAT_FILE)]);
		expect(s.views.isPlacedAnywhere(BOAT_FILE)).toBe(true);
		await swapPicked(view, view.root[0], candidate("file", file("Existing.md"), "Existing.md"));
		expect(s.views.isPlacedAnywhere(BOAT_FILE)).toBe(false);
		expect(s.views.isPlacedAnywhere(file("Existing.md"))).toBe(true);
	});
});

describe("E5/G4: 'Swap for Atlas folder' through the name box", () => {
	it("submitting a name turns the unit into an Atlas folder, with that name", () => {
		const { view } = boot([unit("spot", BOAT_FILE)]);
		fake.openSwapForFolder(view, view.root[0], "Boat.md");
		const prompt = captured.prompts[0];
		expect(prompt.title).toBe("Swap for Atlas folder");
		expect(prompt.initial).toBe("Boat.md");
		prompt.onSubmit("Boat");
		expect(s.views.getView("default")!.root[0]).toMatchObject({ id: "spot", type: "meta", label: "Boat" });
		expect(flushSave).toHaveBeenCalledTimes(1);
		vaultWasUntouched();
	});

	it("cancelling (no submit) changes nothing", () => {
		const { view } = boot([unit("spot", BOAT_FILE)]);
		const before = clone(s.views.getView("default")!.root);
		fake.openSwapForFolder(view, view.root[0], "Boat.md");
		expect(captured.prompts).toHaveLength(1);
		expect(s.views.getView("default")!.root).toEqual(before);
		expect(flushSave).not.toHaveBeenCalled();
	});

	it("an empty name changes nothing", () => {
		const { view } = boot([unit("spot", BOAT_FILE)]);
		fake.openSwapForFolder(view, view.root[0], "Boat.md");
		captured.prompts[0].onSubmit("   ");
		expect(s.views.getView("default")!.root[0].type).toBe("unit");
		expect(flushSave).not.toHaveBeenCalled();
	});
});

describe("E7: the unchanged placement path still moves on first copy", () => {
	it("placeUnit of an already placed item moves it rather than duplicating", () => {
		boot([unit("A", BOAT_FILE), meta("B", "Other")]);
		s.views.placeUnit("default", BOAT_FILE, "B");
		const root = s.views.getView("default")!.root;
		const copies = JSON.stringify(root).split(`"path":"Boat.md"`).length - 1;
		expect(copies).toBe(1);
	});
});

describe("G14: swap survives a reload", () => {
	it("the saved views reload with the swapped spot and nothing of the old item", async () => {
		const { view } = boot([unit("spot", file("Existing.md"))]);
		await swapPicked(view, view.root[0], candidate("folder", folder("Archive"), "Archive"));
		const saved = clone(s.views.getViews());
		const again = new ViewsManager(s.app, saved, "default", vi.fn());
		expect(again.getView("default")!.root[0]).toMatchObject({ id: "spot", type: "unit", ref: folder("Archive") });
		expect(again.isPlacedAnywhere(file("Existing.md"))).toBe(false);
	});
});


describe("GP1 through the real picker: type, pick, close", () => {
	/** The picker resolves every known block's text first, so the fixture's free block needs content on disk. */
	const seedFreeBlockText = () => s.app.vault.contents.set("_pool/20260101000000-aaaa.md", "Ideas");

	it("typing 'Customer Disc' lists Customer Discovery.md; picking it swaps the spot and closes the picker", async () => {
		const { view, spot } = boot([meta("spot", "Customer interviews", [unit("k1", file("Sub/Nested Note.md"))])]);
		s.app.vault.seedFile("Customer Discovery.md");
		seedFreeBlockText();
		const openSpy = vi.spyOn(SwapPickerModal.prototype, "open");

		await fake.openSwapPicker(view, spot);

		expect(openSpy).toHaveBeenCalledTimes(1);
		const picker = openSpy.mock.contexts[0] as SwapPickerModal;
		expect(picker.placeholder).toBe("Swap with…");
		expect(document.querySelector(".modal-container")).not.toBeNull();

		const matches = picker.getSuggestions("Customer Disc");
		expect(matches.map((m) => m.item.path)).toEqual(["Customer Discovery.md"]);

		picker.onChooseSuggestion(matches[0], new MouseEvent("click"));
		await vi.waitFor(() => expect(flushSave).toHaveBeenCalledTimes(1));

		const node = s.views.getView("default")!.root[0];
		expect(node).toMatchObject({ id: "spot", type: "unit", ref: file("Customer Discovery.md") });
		expect(node.children).toEqual([unit("k1", file("Sub/Nested Note.md"))]);
		expect(document.querySelector(".modal-container")).toBeNull();
		expect(notices()).toEqual([]);
		vaultWasUntouched();
		openSpy.mockRestore();
	});

	it("escaping the picker changes nothing and does not save", async () => {
		const { view, spot } = boot([meta("spot", "Customer interviews")]);
		seedFreeBlockText();
		const before = clone(s.views.getView("default")!.root);
		const openSpy = vi.spyOn(SwapPickerModal.prototype, "open");

		await fake.openSwapPicker(view, spot);
		(openSpy.mock.contexts[0] as SwapPickerModal).close();

		expect(s.views.getView("default")!.root).toEqual(before);
		expect(flushSave).not.toHaveBeenCalled();
		vaultWasUntouched();
		openSpy.mockRestore();
	});
});
