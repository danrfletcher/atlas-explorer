import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile, TFolder, setIcon } from "obsidian";
import type { FuzzyMatch } from "obsidian";
import { AddFileSuggestModal, AtlasExplorerView } from "../../src/explorer-view";
import type { Unit, UnitRef } from "../../src/types";
import { seedRoot } from "../helpers";

// The mock has no icon or result-highlighting DOM. Spy on the two helpers the picker row calls, and
// render the text so the test can read the row back.
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		setIcon: vi.fn(),
		renderResults: (el: HTMLElement, text: string) => {
			el.textContent = text;
		},
	};
});

const match = <T>(item: T): FuzzyMatch<T> => ({ item, match: { score: 0, matches: [] } }) as unknown as FuzzyMatch<T>;

function vaultForGoldenPath(): App {
	const app = new App();
	seedRoot(app, ["Jobs/Acme/brief.md", "Jobs/Acme/notes.md"], ["Jobs", "Jobs/Acme"]);
	return app;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(setIcon).mockClear();
	document.body.innerHTML = "";
});

describe("AddFileSuggestModal mixed list (G1, GP2)", () => {
	it("renders a folder as path/ with a folder icon, and a file as path with a file icon", () => {
		const app = vaultForGoldenPath();
		const folder = app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder;
		const brief = app.vault.getAbstractFileByPath("Jobs/Acme/brief.md") as TFile;
		const modal = new AddFileSuggestModal(app, [folder, brief], vi.fn());

		const folderEl = document.createElement("div");
		modal.renderSuggestion(match<TFile | TFolder>(folder), folderEl);
		expect(folderEl.textContent).toBe("Jobs/Acme/");
		expect(folderEl.classList.contains("atlas-add-suggest-item")).toBe(true);
		expect(setIcon).toHaveBeenLastCalledWith(expect.any(HTMLElement), "folder");

		const fileEl = document.createElement("div");
		modal.renderSuggestion(match<TFile | TFolder>(brief), fileEl);
		expect(fileEl.textContent).toBe("Jobs/Acme/brief.md");
		expect(setIcon).toHaveBeenLastCalledWith(expect.any(HTMLElement), "file");
	});

	it("getItemText: a folder row is path/, a file row is path, so same-basename rows stay distinct (edge)", () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme.md"], ["Jobs", "Jobs/Acme"]);
		const folder = app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder;
		const file = app.vault.getAbstractFileByPath("Jobs/Acme.md") as TFile;
		const modal = new AddFileSuggestModal(app, [folder, file], vi.fn());
		expect(modal.getItemText(folder)).toBe("Jobs/Acme/");
		expect(modal.getItemText(file)).toBe("Jobs/Acme.md");
	});

	it("an empty candidate list is kept as an empty list, with no crash (edge)", () => {
		const modal = new AddFileSuggestModal(new App(), [], vi.fn());
		expect(modal.getItems()).toEqual([]);
	});
});

// --- openAddFileModal: picking a folder or a file (GP6 save, F1 one item, F4 file path unchanged) -----

type FakeThis = {
	plugin: {
		app: App;
		settings: { poolFolder: string; excludedFolders: string[] };
		unitIndex: { getUnits: () => Unit[]; markAdded: ReturnType<typeof vi.fn> };
		viewsManager: { placedRefKeys: () => Set<string> };
		flushSave: ReturnType<typeof vi.fn>;
	};
	render: ReturnType<typeof vi.fn>;
};

function openAddModalFor(app: App, units: Unit[] = [], placed: string[] = []): { fake: FakeThis; built: () => AddFileSuggestModal } {
	const fake: FakeThis = {
		plugin: {
			app,
			settings: { poolFolder: "_pool", excludedFolders: [] },
			unitIndex: { getUnits: () => units, markAdded: vi.fn() },
			viewsManager: { placedRefKeys: () => new Set(placed) },
			flushSave: vi.fn(async () => {}),
		},
		render: vi.fn(async () => {}),
	};
	let captured: AddFileSuggestModal | undefined;
	vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
		captured = this;
	});
	(AtlasExplorerView.prototype as unknown as { openAddFileModal: (this: FakeThis) => void }).openAddFileModal.call(fake);
	return {
		fake,
		built: () => {
			if (!captured) throw new Error("modal was not opened");
			return captured;
		},
	};
}

describe("AtlasExplorerView.openAddFileModal: folder and file picks (G2, GP6, F1, F4)", () => {
	it("offers the folder alongside its files in one list", () => {
		const app = vaultForGoldenPath();
		const { built } = openAddModalFor(app);
		const paths = built().getItems().map((item) => built().getItemText(item)).sort();
		expect(paths).toEqual(["Jobs/Acme/", "Jobs/Acme/brief.md", "Jobs/Acme/notes.md"]);
	});

	it("selecting a folder calls markAdded with a folder ref, saves once, and re-renders", async () => {
		const app = vaultForGoldenPath();
		const { fake, built } = openAddModalFor(app);
		const folder = app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder;

		built().onChooseItem(folder);
		await Promise.resolve();

		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledTimes(1);
		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledWith({ kind: "folder", path: "Jobs/Acme" } satisfies UnitRef);
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("selecting a file still calls markAdded with a file ref (F4)", async () => {
		const app = vaultForGoldenPath();
		const { fake, built } = openAddModalFor(app);
		const brief = app.vault.getAbstractFileByPath("Jobs/Acme/brief.md") as TFile;

		built().onChooseItem(brief);
		await Promise.resolve();

		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledWith({ kind: "file", path: "Jobs/Acme/brief.md" });
		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledTimes(1);
	});

	it("F1: picking one row adds exactly that one item; the modal takes no multi-select", () => {
		const app = vaultForGoldenPath();
		const { fake, built } = openAddModalFor(app);
		built().onChooseItem(app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder);
		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledTimes(1);
	});

	it("a folder already placed in a view is not in the list", () => {
		const app = vaultForGoldenPath();
		const { built } = openAddModalFor(app, [], ["folder:Jobs/Acme"]);
		expect(built().getItems().some((item) => item instanceof TFolder)).toBe(false);
	});
});
