import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import * as obsidianMock from "obsidian";
import { AddFileSuggestModal, AtlasExplorerView, candidateFilesForAdd } from "../../src/explorer-view";
import type { Unit, UnitRef, View } from "../../src/types";
import { createEmptyView } from "../../src/types";
import { seedRoot } from "../helpers";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { resolveUnit } from "../../src/unit-display";

const file = (path: string): UnitRef => ({ kind: "file", path });

function filesOf(app: App, paths: string[]): TFile[] {
	return paths.map((p) => app.vault.getAbstractFileByPath(p) as TFile);
}

/** Mirrors `unit-index.test.ts`'s `stubLinks` — wires `getFileCache`/`getFirstLinkpathDest` so a
 * real `UnitIndex.rebuild()` sees the given link graph. */
function stubLinks(app: App, caches: Record<string, CachedMetadata>, resolve: Record<string, string>): void {
	app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const destPath = resolve[linkpath];
		return destPath ? (app.vault.getAbstractFileByPath(destPath) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
}

// --- candidateFilesForAdd: G2 exclusion rules, F3 eligibility-blindness -----------------------------

describe("candidateFilesForAdd (G2, E4, F3)", () => {
	it("returns every vault file when nothing is a unit or placed anywhere", () => {
		const app = new App();
		seedRoot(app, ["A.md", "B.md"]);
		const result = candidateFilesForAdd(app.vault.getFiles(), [], () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["A.md", "B.md"]);
	});

	it("G2/E4: excludes a file already present as an auto-promoted unit", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Promoted.md", "Other.md"], ["ModuleA"]);
		const units: Unit[] = [{ type: "promoted-file", path: "ModuleA/Promoted.md", topLevelFolder: "ModuleA" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["Other.md"]);
	});

	it("G2/E4: excludes a file already present as a manually promoted unit", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Manual.md", "Other.md"], ["ModuleA"]);
		// Manual promotions are folded into the same promoted-file classification by the index —
		// candidateFilesForAdd only ever sees the resulting Unit, never the manualPromotions list itself.
		const units: Unit[] = [{ type: "promoted-file", path: "ModuleA/Manual.md", topLevelFolder: "ModuleA" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["Other.md"]);
	});

	it("G2/E4: excludes a file already present as a manually-added unit (prevents double-adding)", () => {
		const app = new App();
		seedRoot(app, ["Areas/Added.md", "Other.md"], ["Areas"]);
		const units: Unit[] = [{ type: "added-file", path: "Areas/Added.md" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["Other.md"]);
	});

	it("R2: a file whose only unit is a promoted block (no file-level unit) is still offered — a block unit is not 'the file already present as a unit' (G2)", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/WithBlock.md", "Other.md"], ["ModuleA"]);
		const units: Unit[] = [{ type: "promoted-block", path: "ModuleA/WithBlock.md", subpath: "^abc123" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["ModuleA/WithBlock.md", "Other.md"]);
	});

	it("G2: excludes a file already placed/nested as a node in any view, even though it is not classified as any Unit", () => {
		const app = new App();
		seedRoot(app, ["Areas/Placed.md", "Areas/Eligible.md"], ["Areas"]);
		const isPlacedAnywhere = (ref: UnitRef) => ref.path === "Areas/Placed.md";
		const result = candidateFilesForAdd(app.vault.getFiles(), [], isPlacedAnywhere);
		expect(result.map((f) => f.path).sort()).toEqual(["Areas/Eligible.md"]);
	});

	it("F3: a file that fails the auto-promotion eligibility rule (no outside-module references, so never auto-promoted) is still a candidate — no eligibility check is invoked here", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/NeverReferenced.md"], ["ModuleA"]);
		// units=[] simulates exactly this: the file was never auto-promoted (fails the parent ticket's
		// "references outside the module" rule) and was never manually promoted/added either.
		const result = candidateFilesForAdd(app.vault.getFiles(), [], () => false);
		expect(result.map((f) => f.path)).toEqual(["ModuleA/NeverReferenced.md"]);
	});

	it("combines all four exclusion states at once against a mixed fixture (integration-shaped)", () => {
		const app = new App();
		seedRoot(
			app,
			["ModuleA/AutoPromoted.md", "ModuleA/ManualPromoted.md", "ModuleA/Added.md", "ModuleA/Placed.md", "ModuleA/Eligible.md"],
			["ModuleA"],
		);
		const units: Unit[] = [
			{ type: "promoted-file", path: "ModuleA/AutoPromoted.md", topLevelFolder: "ModuleA" },
			{ type: "promoted-file", path: "ModuleA/ManualPromoted.md", topLevelFolder: "ModuleA" },
			{ type: "added-file", path: "ModuleA/Added.md" },
		];
		const isPlacedAnywhere = (ref: UnitRef) => ref.path === "ModuleA/Placed.md";
		const result = candidateFilesForAdd(app.vault.getFiles(), units, isPlacedAnywhere);
		expect(result.map((f) => f.path)).toEqual(["ModuleA/Eligible.md"]);
	});

	it("opening with zero eligible files returns an empty list without throwing", () => {
		const app = new App();
		seedRoot(app, ["Only.md"]);
		const units: Unit[] = [{ type: "added-file", path: "Only.md" }];
		expect(() => candidateFilesForAdd(app.vault.getFiles(), units, () => false)).not.toThrow();
		expect(candidateFilesForAdd(app.vault.getFiles(), units, () => false)).toEqual([]);
	});

	// R4(d): the hand-built Unit[] fixtures above are what let R1/R2 go unnoticed — a real UnitIndex
	// computes promoted-block/promoted-file classifications itself, so feeding its actual getUnits()
	// output through here exercises the same code path a live vault would.
	it("integration: against a real UnitIndex, a file whose only unit is a promoted block stays a candidate, and an added file survives a later block reference into it (R1, R2)", () => {
		const app = new App();
		seedRoot(
			app,
			["ModuleA/Source.md", "ModuleA/WithBlock.md", "Areas/Added.md", "Areas/Eligible.md"],
			["ModuleA", "Areas"],
		);
		stubLinks(
			app,
			{
				"ModuleA/Source.md": {
					links: [
						{ link: "WithBlock#^b1", original: "[[WithBlock#^b1]]" } as never,
						{ link: "Added#^b2", original: "[[Added#^b2]]" } as never,
					],
				},
			},
			{ WithBlock: "ModuleA/WithBlock.md", Added: "Areas/Added.md" },
		);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], [{ ref: file("Areas/Added.md"), tag: "added" }]);
		index.rebuild();

		const result = candidateFilesForAdd(app.vault.getFiles(), index.getUnits(), () => false).map((f) => f.path).sort();

		// WithBlock.md has only a promoted-block unit — R2 says that's not "already a unit" for G2's
		// purposes, so it must still be offered.
		expect(result).toContain("ModuleA/WithBlock.md");
		expect(result).toContain("Areas/Eligible.md");
		// Added.md is already an added-file unit (surfaced per R1/R3 despite the block reference into
		// it) — it must be excluded so "+" can't double-add it.
		expect(result).not.toContain("Areas/Added.md");
	});
});

// --- AddFileSuggestModal: thin FuzzySuggestModal subclass, mirrors ViewSuggestModal ----------------

describe("AddFileSuggestModal (G2 structural, G3 wiring)", () => {
	it("getItems/getItemText/onChooseItem pass through unmodified — real fuzzy matching is inherited from FuzzySuggestModal, never reimplemented here", () => {
		const app = new App();
		seedRoot(app, ["A.md", "B.md"]);
		const files = filesOf(app, ["A.md", "B.md"]);
		const onChoose = vi.fn();
		const modal = new AddFileSuggestModal(app, files, onChoose);
		expect(modal.getItems()).toBe(files);
		expect(modal.getItemText(files[0])).toBe("A.md");
		modal.onChooseItem(files[1]);
		expect(onChoose).toHaveBeenCalledWith(files[1]);
	});
});

// --- AtlasExplorerView.openAddFileModal: full add-flow wiring (G2, G3, GP3) -------------------------

type FakeThis = {
	plugin: {
		app: { vault: { getFiles: () => TFile[]; getAllLoadedFiles: () => TFile[] } };
		settings: { poolFolder: string; excludedFolders: string[] };
		unitIndex: { getUnits: () => Unit[]; markAdded: ReturnType<typeof vi.fn> };
		viewsManager: { placedRefKeys: () => Set<string> };
		flushSave: ReturnType<typeof vi.fn>;
	};
	render: ReturnType<typeof vi.fn>;
};

function callOpenAddFileModal(fake: FakeThis): void {
	(AtlasExplorerView.prototype as unknown as { openAddFileModal: (this: FakeThis) => void }).openAddFileModal.call(fake);
}

function fakeFor(units: Unit[], files: TFile[], placedRefKeys: string[] = []): FakeThis {
	return {
		plugin: {
			app: { vault: { getFiles: () => files, getAllLoadedFiles: () => files } },
			settings: { poolFolder: "_pool", excludedFolders: [] },
			unitIndex: { getUnits: () => units, markAdded: vi.fn() },
			viewsManager: { placedRefKeys: () => new Set(placedRefKeys) },
			flushSave: vi.fn(async () => {}),
		},
		render: vi.fn(async () => {}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("AtlasExplorerView.openAddFileModal (G2, G3, E4, GP3)", () => {
	it("opens exactly one AddFileSuggestModal whose candidate list is the correctly-filtered set end to end", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Promoted.md", "ModuleA/Placed.md", "Areas/Career/Notes.md"], ["ModuleA", "Areas", "Areas/Career"]);
		const files = app.vault.getFiles();
		const units: Unit[] = [{ type: "promoted-file", path: "ModuleA/Promoted.md", topLevelFolder: "ModuleA" }];
		const fake = fakeFor(units, files, ["file:ModuleA/Placed.md"]);

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		callOpenAddFileModal(fake);

		expect(built).toBeDefined();
		expect(built!.getItems().map((f) => f.path)).toEqual(["Areas/Career/Notes.md"]);
	});

	it("GP3/G3: selecting a candidate marks it added, flushes the save, and re-renders — not the 'promoted' path", async () => {
		const app = new App();
		seedRoot(app, ["Areas/Career/Notes.md"], ["Areas", "Areas/Career"]);
		const files = app.vault.getFiles();
		const fake = fakeFor([], files);

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		callOpenAddFileModal(fake);
		built!.onChooseItem(files[0]);
		await Promise.resolve();

		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledWith(file("Areas/Career/Notes.md"));
		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledTimes(1);
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("E4/edge: opening when every file is already excluded shows an empty candidate list without throwing", () => {
		const app = new App();
		seedRoot(app, ["Only.md"]);
		const units: Unit[] = [{ type: "added-file", path: "Only.md" }];
		const fake = fakeFor(units, app.vault.getFiles());

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		expect(() => callOpenAddFileModal(fake)).not.toThrow();
		expect(built!.getItems()).toEqual([]);
	});

	it("edge: dismissing the modal without selecting anything never calls markAdded/flushSave/render (inbox unchanged)", () => {
		const app = new App();
		seedRoot(app, ["A.md"]);
		const fake = fakeFor([], app.vault.getFiles());

		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(() => {});

		callOpenAddFileModal(fake);

		expect(fake.plugin.unitIndex.markAdded).not.toHaveBeenCalled();
		expect(fake.plugin.flushSave).not.toHaveBeenCalled();
		expect(fake.render).not.toHaveBeenCalled();
	});

	it("R4(c): a folder in the vault is never offered — the candidate source is app.vault.getFiles(), which never includes folders", () => {
		const app = new App();
		seedRoot(app, ["Areas/Notes.md"], ["Areas", "Areas/Sub"]);
		const files = app.vault.getFiles();
		// getFiles() itself never returns a folder; assert that directly so a future change to the
		// candidate source (e.g. switching to getAllLoadedFiles()) would be caught here.
		expect(files.every((f) => f instanceof TFile)).toBe(true);
		const fake = fakeFor([], files);

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		callOpenAddFileModal(fake);

		expect(built!.getItems().map((f) => f.path)).toEqual(["Areas/Notes.md"]);
	});
});

// --- renderInboxRow: "added" badge rendering (G3), distinct from and mutually exclusive with
// the "promoted" badge (regression) ------------------------------------------------------------------

interface FakeRowInfo {
	text: string;
	icon: string;
	promoted: boolean;
	added: boolean;
	missing: boolean;
	secondary?: string;
}

function callRenderInboxRow(container: HTMLElement, ref: UnitRef, info: FakeRowInfo): HTMLElement {
	const fake = {
		selectedInboxRefKeys: new Set<string>(),
		setPlacementTooltip: vi.fn(),
	};
	return (
		AtlasExplorerView.prototype as unknown as {
			renderInboxRow: (this: typeof fake, container: HTMLElement, ref: UnitRef, info: FakeRowInfo) => HTMLElement;
		}
	).renderInboxRow.call(fake, container, ref, info);
}

// --- resolveUnit/resolveRef: added-file units carry added:true/promoted:false end to end (R5) ------

describe("resolveUnit on an added-file unit from a real UnitIndex (G3, R5)", () => {
	it("markAdded on a file that fails auto-promotion eligibility (no outside-module references) yields a unit that resolves to added: true, promoted: false", async () => {
		const app = new App();
		seedRoot(app, ["Areas/Career/Notes.md"], ["Areas", "Areas/Career"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], []);
		index.rebuild();
		index.markAdded(file("Areas/Career/Notes.md"));

		const units = index.getUnits();
		const addedUnit = units.find((u) => u.path === "Areas/Career/Notes.md");
		expect(addedUnit?.type).toBe("added-file");

		const resolved = await resolveUnit(app, DEFAULT_SETTINGS, addedUnit!);
		expect(resolved?.added).toBe(true);
		expect(resolved?.promoted).toBe(false);
	});

	it("renders through renderInboxRow with exactly one '.atlas-badge' reading 'added'", async () => {
		const app = new App();
		seedRoot(app, ["Areas/Career/Notes.md"], ["Areas", "Areas/Career"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], []);
		index.rebuild();
		index.markAdded(file("Areas/Career/Notes.md"));

		const addedUnit = index.getUnits().find((u) => u.path === "Areas/Career/Notes.md")!;
		const resolved = await resolveUnit(app, DEFAULT_SETTINGS, addedUnit);

		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("Areas/Career/Notes.md"), {
			text: resolved!.text,
			icon: resolved!.icon,
			promoted: resolved!.promoted,
			added: resolved!.added,
			missing: false,
		});
		const badges = Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
		expect(badges).toEqual(["added"]);
	});
});

describe("renderInboxRow — added badge (G3)", () => {
	it("renders an 'added' badge (atlas-badge class, 'added' text) when info.added is true, and no 'promoted' badge", () => {
		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("Areas/Career/Notes.md"), {
			text: "Notes",
			icon: "file",
			promoted: false,
			added: true,
			missing: false,
		});
		const badges = Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
		expect(badges).toEqual(["added"]);
	});

	it("regression: still renders a 'promoted' badge (not 'added') when info.promoted is true and info.added is false", () => {
		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("ModuleA/Promoted.md"), {
			text: "Promoted",
			icon: "file",
			promoted: true,
			added: false,
			missing: false,
		});
		const badges = Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
		expect(badges).toEqual(["promoted"]);
	});

	it("renders neither badge for a plain inbox unit (neither promoted nor added)", () => {
		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("Root.md"), {
			text: "Root",
			icon: "file",
			promoted: false,
			added: false,
			missing: false,
		});
		expect(row.querySelectorAll(".atlas-badge").length).toBe(0);
	});
});

// --- renderInboxSection header: "+" icon placement/tooltip (G1), This view/Global toggle regression
// (R4a, R4b) ------------------------------------------------------------------------------------------

type FakeSectionThis = {
	inboxCollapsed: boolean;
	plugin: { viewsManager: { setInboxMode: ReturnType<typeof vi.fn> }; app: { vault: App["vault"] } };
	openAddFileModal: ReturnType<typeof vi.fn>;
	matchesFilter: ReturnType<typeof vi.fn>;
	sortMode: string;
	inboxSelectOrder: string[];
	inboxRefByKey: Map<string, UnitRef>;
	// units=[] in every test below means neither of these is ever exercised for real content — stubbed
	// only so the unconditional calls `renderInboxSection` makes don't hit the real (heavy) prototype
	// methods, which need far more of `this` than this header-focused test fakes.
	renderVirtualizedInboxRows: ReturnType<typeof vi.fn>;
	makeDropZone: ReturnType<typeof vi.fn>;
};

function fakeSectionThis(app: App): FakeSectionThis {
	return {
		inboxCollapsed: false,
		plugin: { viewsManager: { setInboxMode: vi.fn() }, app: { vault: app.vault } },
		openAddFileModal: vi.fn(),
		matchesFilter: vi.fn(() => true),
		sortMode: "alphabetical",
		inboxSelectOrder: [],
		inboxRefByKey: new Map(),
		renderVirtualizedInboxRows: vi.fn(),
		makeDropZone: vi.fn(),
	};
}

function callRenderInboxSection(fake: FakeSectionThis, container: HTMLElement, view: View): Promise<void> {
	return (
		AtlasExplorerView.prototype as unknown as {
			renderInboxSection: (
				this: FakeSectionThis,
				container: HTMLElement,
				view: View,
				units: Unit[],
				dismissedUnits: Unit[],
				viewportScrollTop: number
			) => Promise<void>;
		}
	).renderInboxSection.call(fake, container, view, [], [], 0);
}

describe("renderInboxSection header (G1, R4a, R4b)", () => {
	it("R4a: renders a '.atlas-inbox-add-btn' with the 'plus' icon and the 'Add file to inbox' tooltip, next to '.atlas-inbox-mode', and clicking it opens the modal without toggling collapse", async () => {
		const app = new App();
		const setIconSpy = vi.spyOn(obsidianMock, "setIcon");
		const setTooltipSpy = vi.spyOn(obsidianMock, "setTooltip");
		const fake = fakeSectionThis(app);
		const container = document.createElement("div");

		await callRenderInboxSection(fake, container, createEmptyView("v1", "Default"));

		const header = container.querySelector(".atlas-section-header")!;
		const addBtn = header.querySelector<HTMLElement>(".atlas-inbox-add-btn")!;
		expect(addBtn).toBeTruthy();
		expect(header.querySelector(".atlas-inbox-mode")).toBeTruthy();
		// Sibling of (not nested inside) .atlas-inbox-mode, per the G1 implementation note.
		expect(addBtn.parentElement).toBe(header);

		expect(setIconSpy).toHaveBeenCalledWith(addBtn, "plus");
		expect(setTooltipSpy).toHaveBeenCalledWith(addBtn, "Add file to inbox");

		addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(fake.openAddFileModal).toHaveBeenCalledTimes(1);
		// The header's own click listener (added after the add button's, which stopPropagation()s)
		// toggles collapse — clicking "+" must never trigger that.
		expect(fake.inboxCollapsed).toBe(false);

		setIconSpy.mockRestore();
		setTooltipSpy.mockRestore();
	});

	it("R4b: the 'This view'/'Global' toggle still renders with the '+' icon present, and clicking a mode button still switches modes", async () => {
		const app = new App();
		const fake = fakeSectionThis(app);
		const container = document.createElement("div");
		const view = createEmptyView("v1", "Default");

		await callRenderInboxSection(fake, container, view);

		const header = container.querySelector(".atlas-section-header")!;
		const modeToggle = header.querySelector(".atlas-inbox-mode")!;
		const buttons = Array.from(modeToggle.querySelectorAll<HTMLElement>(".atlas-inbox-mode-btn"));
		expect(buttons.map((b) => b.textContent)).toEqual(["This view", "Global"]);
		expect(header.querySelector(".atlas-inbox-add-btn")).toBeTruthy();

		const globalBtn = buttons.find((b) => b.textContent === "Global")!;
		globalBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(fake.plugin.viewsManager.setInboxMode).toHaveBeenCalledWith("v1", "global");
	});
});
