import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, Platform, TFile, TFolder } from "obsidian";
import { AddFileSuggestModal } from "../../src/explorer-view";
import { unitRefKey, type ViewNode } from "../../src/types";
import { makeSourcesRig, rowByKey, sectionEl, sectionRows, sectionTitles, type SourcesRig } from "../sources-explorer-fixture";
import { sourcesVaultPaths } from "../sources-vault";

// PR-4 (G1, E5): the real explorer over `tests/fixtures/sources-vault/` and a fake Tephra answering over HTTP
// (`tests/sources-explorer-fixture.ts` says what is real and what stands in). Everything a user does here goes
// through the shipped row, header, menu and drop handlers; what is asserted is the DOM and the stored state.

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await rig?.teardown();
	rig = null;
	Platform.isMobile = false;
});

const KEY = (path: string) => unitRefKey({ kind: "file", path });
const FOLDER_KEY = (path: string) => unitRefKey({ kind: "folder", path });

/** Right-click `row`; the items of the menu the row's own handler built. */
function menuOf(row: HTMLElement): Menu {
	let built: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	vi.restoreAllMocks();
	return built!;
}
const itemTitles = (menu: Menu) => menu.items.map((item) => item.title);
const click = (menu: Menu, title: string) => menu.items.find((item) => item.title === title)!.clickHandler!();

/** Drags `row` (its real dragstart) and drops it on `target` (the real drop zone's own listener). */
function dragTo(row: HTMLElement, target: HTMLElement): void {
	row.dispatchEvent(new Event("dragstart", { bubbles: true }));
	target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
}
const bucketDrop = (r: SourcesRig) => r.h.panel().querySelector<HTMLElement>(".atlas-bucket .atlas-meta-children-inner")!;
const bucketRowTexts = (r: SourcesRig) => [...r.h.panel().querySelectorAll(".atlas-bucket .atlas-row-text")].map((el) => el.textContent);
const flatNodes = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((node) => [node, ...flatNodes(node.children ?? [])]);

describe("GP1: the fixture vault's Inbox sections", () => {
	it("the vault's Inbox first (its notes, nothing from Sources/), then [tephra] and [whoop] A-Z, each with its own top-level rows", async () => {
		rig = await makeSourcesRig();
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["Leg Day", "README", "Weekly Review"]);
		// Tephra's top level for the fixture: Cargo.toml, README.md, and the folders crates/, docs/, scripts/.
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(["Cargo", "README", "crates", "docs", "scripts"]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(["Leg Day", "Workout Plan"]);
		// Each section's count badge says how many rows it has.
		expect([...rig.h.panel().querySelectorAll(".atlas-inbox > .atlas-section-header .atlas-count-badge")].map((el) => el.textContent)).toEqual(["3", "5", "2"]);
		// What came over the wire: one source.list per check and one unit.list per listed source.
		expect(rig.daemon.requests.filter((r) => r.method === "unit.list").map((r) => (r.params as { source: string }).source).sort()).toEqual(expect.arrayContaining(["tephra", "whoop"]));
	});

	it("a folder row is a module (its icon is the module icon), a file row is not; selection keys are by full Sources/<name>/ path", async () => {
		rig = await makeSourcesRig();
		for (const folder of ["crates", "docs", "scripts"]) {
			const row = rowByKey(rig.h, FOLDER_KEY(`Sources/tephra/${folder}`));
			expect(row, folder).toBeTruthy();
			expect(row.querySelector(".atlas-icon")!.classList.contains("atlas-module-icon"), folder).toBe(true);
		}
		for (const file of ["Cargo.toml", "README.md"]) {
			const row = rowByKey(rig.h, KEY(`Sources/tephra/${file}`));
			expect(row.querySelector(".atlas-icon")!.classList.contains("atlas-module-icon"), file).toBe(false);
		}
		// The vault's README and the source's README are two rows, told apart by path.
		expect(rowByKey(rig.h, KEY("README.md"))).toBeTruthy();
		expect(rowByKey(rig.h, KEY("Sources/tephra/README.md"))).toBeTruthy();
		expect(rowByKey(rig.h, KEY("Sources/whoop/Leg Day.md")).closest(".atlas-inbox-source")!.getAttribute("data-source")).toBe("whoop");
	});

	it("long-press on a source module opens Module Contents on Sources/<name>/<folder>", async () => {
		rig = await makeSourcesRig();
		const row = rowByKey(rig.h, FOLDER_KEY("Sources/tephra/crates"));
		vi.useFakeTimers();
		row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 4, clientY: 4, button: 0 }));
		vi.advanceTimersByTime(500);
		vi.useRealTimers();
		const modal = (rig.h.explorer as unknown as { openModuleModal: { folder: TFolder } | null }).openModuleModal;
		expect(modal?.folder).toBeInstanceOf(TFolder);
		expect(modal!.folder.path).toBe("Sources/tephra/crates");
		expect(document.querySelector(".modal-title")!.textContent).toBe("crates");
	});

	it("clicking a module's icon opens the same Module Contents", async () => {
		rig = await makeSourcesRig();
		rowByKey(rig.h, FOLDER_KEY("Sources/tephra/docs")).querySelector<HTMLElement>(".atlas-module-icon")!.click();
		expect((rig.h.explorer as unknown as { openModuleModal: { folder: TFolder } }).openModuleModal.folder.path).toBe("Sources/tephra/docs");
	});
});

describe("placing a source row in a view", () => {
	it("dragging it into the bucket stores the Sources/<name>/ path, and the row leaves its section and shows in the bucket", async () => {
		rig = await makeSourcesRig();
		const key = KEY("Sources/tephra/README.md");
		dragTo(rowByKey(rig.h, key), bucketDrop(rig));
		await rig.settle();
		const stored = flatNodes(rig.viewsManager.getActiveView().root).filter((node) => node.type === "unit");
		expect(stored.map((node) => node.ref)).toEqual([{ kind: "file", path: "Sources/tephra/README.md" }]);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(["Cargo", "crates", "docs", "scripts"]);
		expect(rig.h.panel().querySelector(`.atlas-inbox [data-select-key="${key}"]`)).toBeNull();
		// The vault's own README is a different unit and stays.
		expect(sectionRows(sectionEl(rig.h, null))).toContain("README");
		expect(bucketRowTexts(rig)).toEqual(["README"]);
	});

	it("\"Place in view…\" on a module row stores the folder's Sources/<name>/ path too", async () => {
		rig = await makeSourcesRig();
		const menu = menuOf(rowByKey(rig.h, FOLDER_KEY("Sources/tephra/crates")));
		expect(itemTitles(menu)).toContain("Place in view…");
		dragTo(rowByKey(rig.h, FOLDER_KEY("Sources/tephra/crates")), bucketDrop(rig));
		await rig.settle();
		const stored = flatNodes(rig.viewsManager.getActiveView().root).filter((node) => node.type === "unit");
		expect(stored.map((node) => node.ref)).toEqual([{ kind: "folder", path: "Sources/tephra/crates" }]);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).not.toContain("crates");
	});
});

describe("a status on a placed source unit (G1)", () => {
	const SRC_PATH = "Sources/tephra/README.md";
	const bucketRow = (r: SourcesRig, text: string) => [...r.h.panel().querySelectorAll<HTMLElement>(".atlas-bucket .atlas-row")].find((row) => row.querySelector(".atlas-row-text")?.textContent === text)!;

	it("a source unit dropped under a status governor shows the governor's default, and a pick is stored on the node keyed by the Sources/<name>/ path", async () => {
		rig = await makeSourcesRig();
		const view = rig.viewsManager.getActiveView();
		const governor = rig.viewsManager.addMetaFolder(view.id, null, "Tasks")!;
		rig.viewsManager.setNodeStatus(view.id, governor.id, true, "S");
		await rig.settle();
		dragTo(rowByKey(rig.h, KEY(SRC_PATH)), bucketRow(rig, "Tasks"));
		await rig.settle();

		const placed = () => flatNodes(rig!.viewsManager.getActiveView().root).find((node) => node.type === "unit")!;
		expect(placed().ref).toEqual({ kind: "file", path: SRC_PATH });
		expect(placed().explicitStatusId).toBeUndefined();

		const dot = bucketRow(rig, "README").querySelector<HTMLElement>(".atlas-status-dot-circle")!;
		expect(dot).not.toBeNull();
		// the set's default (Todo, #888888)
		expect(dot.style.backgroundColor).toBe("rgb(136, 136, 136)");

		// Pick "Doing" in the real popup.
		dot.click();
		const items = [...document.body.querySelectorAll<HTMLElement>(".atlas-choice-popup-item")];
		expect(items.map((el) => el.textContent)).toEqual(["Todo", "Doing", "Done", "Cancelled"]);
		items.find((el) => el.textContent === "Doing")!.click();
		await rig.settle();
		expect(placed().explicitStatusId).toBe("doing");
		expect(placed().ref).toEqual({ kind: "file", path: SRC_PATH });
		expect(bucketRow(rig, "README").querySelector<HTMLElement>(".atlas-status-dot-circle")!.style.backgroundColor).toBe("rgb(0, 136, 255)");

		// It is keyed by the vault path: a re-render from stored state, and a Tephra change, keep it.
		await rig.push();
		expect(placed().explicitStatusId).toBe("doing");
		expect(bucketRow(rig, "README").querySelector<HTMLElement>(".atlas-status-dot-circle")!.style.backgroundColor).toBe("rgb(0, 136, 255)");
		// and the vault's own README is a different unit with no status
		expect(sectionRows(sectionEl(rig.h, null))).toContain("README");
	});
});

describe("dismiss and unhide a source row", () => {
	it("Dismiss takes it out of its section only; Show Dismissed brings it back marked Unhide; Unhide puts it back for good", async () => {
		rig = await makeSourcesRig();
		const key = KEY("Sources/tephra/Cargo.toml");
		const menu = menuOf(rowByKey(rig.h, key));
		expect(itemTitles(menu)).toContain("Dismiss");
		click(menu, "Dismiss");
		await rig.settle();
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(["README", "crates", "docs", "scripts"]);
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["Leg Day", "README", "Weekly Review"]); // another section is untouched
		expect(rig.unitIndex.isDismissed({ kind: "file", path: "Sources/tephra/Cargo.toml" }, "view", rig.viewsManager.getActiveView().id)).toBe(true);

		// "Show Dismissed" from a source header's own menu.
		const header = sectionEl(rig.h, "tephra").querySelector<HTMLElement>(".atlas-section-header")!;
		click(menuOf(header), "Show Dismissed");
		await rig.settle();
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toContain("Cargo");
		const revealed = menuOf(rowByKey(rig.h, key));
		expect(itemTitles(revealed)).toContain("Unhide");
		expect(itemTitles(revealed)).not.toContain("Dismiss");
		click(revealed, "Unhide");
		await rig.settle();
		click(menuOf(header), "Hide Dismissed");
		await rig.settle();
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(["Cargo", "README", "crates", "docs", "scripts"]);
		expect(rig.unitIndex.isDismissed({ kind: "file", path: "Sources/tephra/Cargo.toml" }, "view", rig.viewsManager.getActiveView().id)).toBe(false);
	});
});

describe("filter and sort inside each section", () => {
	const type = async (r: SourcesRig, text: string) => {
		const input = r.h.panel().querySelector<HTMLInputElement>("input.atlas-filter")!;
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await r.settle();
	};

	it("the filter box narrows every section by its own rows, never mixing them", async () => {
		rig = await makeSourcesRig();
		await type(rig, "readme");
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["README"]);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(["README"]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual([]);
		expect(rowByKey(rig.h, KEY("Sources/tephra/README.md")).closest(".atlas-inbox-source")!.getAttribute("data-source")).toBe("tephra");

		await type(rig, "leg");
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["Leg Day"]);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual([]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(["Leg Day"]);

		await type(rig, "");
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toHaveLength(5);
	});

	it("A-Z sorts each section's own rows (modules among the files), and flipping back restores the default order", async () => {
		rig = await makeSourcesRig();
		const sortButton = rig.h.panel().querySelector<HTMLElement>('.atlas-toolbar-btn[aria-label="Sort: manual / A–Z"]')!;
		const before = sectionRows(sectionEl(rig.h, "tephra"));
		expect(before).toEqual(["Cargo", "README", "crates", "docs", "scripts"]); // files by recency, then modules by name
		sortButton.click();
		await rig.settle();
		const alphabetical = sectionRows(sectionEl(rig.h, "tephra"));
		expect(alphabetical).toEqual(["Cargo", "crates", "docs", "README", "scripts"]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(["Leg Day", "Workout Plan"]);
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["Leg Day", "README", "Weekly Review"]);
		rig.h.panel().querySelector<HTMLElement>('.atlas-toolbar-btn[aria-label="Sort: manual / A–Z"]')!.click();
		await rig.settle();
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(before);
	});
});

describe("collapse", () => {
	it("the chevron collapses one source section only, and it stays collapsed through a Tephra-driven re-render", async () => {
		rig = await makeSourcesRig();
		const chevron = () => sectionEl(rig!.h, "tephra").querySelector<HTMLElement>(":scope > .atlas-section-header > .atlas-chevron")!;
		chevron().click();
		await rig.settle();
		const wrap = (name: string | null) => sectionEl(rig!.h, name).querySelector(":scope > .atlas-meta-children")!;
		expect(wrap("tephra").classList.contains("is-collapsed")).toBe(true);
		expect(wrap("whoop").classList.contains("is-collapsed")).toBe(false);
		expect(wrap(null).classList.contains("is-collapsed")).toBe(false);
		await rig.check(); // a check -> refreshForTephra -> render
		expect(wrap("tephra").classList.contains("is-collapsed")).toBe(true);
		chevron().click();
		await rig.settle();
		expect(wrap("tephra").classList.contains("is-collapsed")).toBe(false);
	});
});

describe("missing and recover (E5), through the real connection", () => {
	it("a source Tephra reports missing gets a grey (missing) header and no rows; it comes back on the next check", async () => {
		rig = await makeSourcesRig();
		rig.daemon.sources = rig.daemon.sources.map((s) => (s.name === "tephra" ? { ...s, status: "missing" as const } : s));
		await rig.check();
		const header = sectionEl(rig.h, "tephra").querySelector(".atlas-section-header")!;
		expect(header.classList.contains("is-missing")).toBe(true);
		expect(header.textContent).toContain("(missing)");
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual([]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(["Leg Day", "Workout Plan"]);

		rig.daemon.requests.length = 0;
		rig.daemon.sources = rig.daemon.sources.map((s) => ({ ...s, status: "online" as const }));
		await rig.check();
		expect(sectionEl(rig.h, "tephra").querySelector(".atlas-section-header")!.classList.contains("is-missing")).toBe(false);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(["Cargo", "README", "crates", "docs", "scripts"]);
		expect(rig.daemon.requests.some((r) => r.method === "unit.list" && (r.params as { source: string }).source === "tephra")).toBe(true);
	});

	it("a listing the daemon answers from its cache with the folder gone (offline) is shown as missing too", async () => {
		rig = await makeSourcesRig();
		rig.daemon.units.tephra = { entries: [{ name: "README.md", kind: "markdown" }], offline: true };
		// `source.list` is unchanged, so the connection fires nothing: this is the render the next vault event would queue.
		await rig.h.render();
		expect(sectionEl(rig.h, "tephra").textContent).toContain("(missing)");
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual([]);
	});
});

describe("graph:changed and the source list changing (G1), through refreshExplorersOnTephraChange", () => {
	it("a pushed graph:changed that finds a new source adds its section without a reload", async () => {
		rig = await makeSourcesRig({ sources: [{ name: "tephra", path: "/t", status: "online" }] });
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]"]);
		rig.daemon.sources = [...rig.daemon.sources, { name: "whoop", path: "/w", status: "online" }];
		await rig.push();
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(["Leg Day", "Workout Plan"]);
	});

	it("a source Tephra stops listing loses its section on the next check; the other sections stay", async () => {
		rig = await makeSourcesRig();
		rig.daemon.sources = rig.daemon.sources.filter((s) => s.name !== "whoop");
		await rig.check();
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]"]);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toHaveLength(5);
	});

	it("Tephra turning unreachable leaves the vault's Inbox alone; coming back restores the sections", async () => {
		rig = await makeSourcesRig();
		rig.daemon.sources = [];
		await rig.check();
		expect(sectionTitles(rig.h)).toEqual(["Inbox"]);
		rig.daemon.sources = [{ name: "tephra", path: "/t", status: "online" }];
		await rig.check();
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]"]);
	});

	it("with the toggle off, a Tephra change draws nothing and Tephra's listings are never asked for", async () => {
		rig = await makeSourcesRig({ settings: { tephraEnabled: false } });
		rig.daemon.requests.length = 0;
		await rig.check();
		expect(sectionTitles(rig.h)).toEqual(["Inbox"]);
		expect(rig.daemon.requests.filter((r) => r.method === "unit.list")).toEqual([]);
	});
});

describe("the scoped \"+\" (G1)", () => {
	/** Clicks the "+" on a section header and returns the modal that opened (its real candidate list and chooser). */
	function openAdd(r: SourcesRig, name: string | null): AddFileSuggestModal {
		let opened: AddFileSuggestModal | undefined;
		const open = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			opened = this;
		});
		sectionEl(r.h, name).querySelector<HTMLElement>(".atlas-inbox-add-btn")!.click();
		open.mockRestore();
		return opened!;
	}
	const offered = (modal: AddFileSuggestModal) => modal.getItems().map((item) => (item instanceof TFolder ? `${item.path}/` : item.path)).sort();

	it("the vault's + with the toggle on offers nothing under Sources/ (and with it off, the same list does)", async () => {
		rig = await makeSourcesRig();
		expect(offered(openAdd(rig, null)).filter((path) => path.startsWith("Sources/"))).toEqual([]);

		await rig.teardown();
		rig = await makeSourcesRig({ settings: { tephraEnabled: false } });
		// Control: the same vault with the toggle off does offer Sources/ paths, so the empty list above means something.
		expect(offered(openAdd(rig, null)).some((path) => path.startsWith("Sources/"))).toBe(true);
	});

	it("a source's + offers only deeper entries under its own Sources/<name>/, minus excluded paths", async () => {
		rig = await makeSourcesRig({ settings: { tephraExcludes: { tephra: ["Sources/tephra/scripts"] } } });
		const list = offered(openAdd(rig, "tephra"));
		expect(list).toContain("Sources/tephra/docs/guide.md");
		expect(list).toContain("Sources/tephra/crates/tephrad/");
		expect(list).toContain("Sources/tephra/crates/tephrad/src/registry.rs");
		// Top-level entries are rows already; other sources and the vault's own notes are out of scope; excluded paths are hidden.
		expect(list.every((path) => path.startsWith("Sources/tephra/"))).toBe(true);
		expect(list).not.toContain("Sources/tephra/README.md");
		expect(list).not.toContain("Sources/tephra/docs/");
		expect(list).not.toContain("Sources/tephra/crates/");
		expect(list.some((path) => path.startsWith("Sources/tephra/scripts"))).toBe(false);
		expect(list.some((path) => path.startsWith("Sources/whoop"))).toBe(false);
		const whoopList = offered(openAdd(rig, "whoop"));
		expect(whoopList.every((path) => path.startsWith("Sources/whoop/"))).toBe(true);
	});

	it("picking one marks it added, and it shows in that source's section with the 'added' pill (and not in another)", async () => {
		rig = await makeSourcesRig();
		const modal = openAdd(rig, "tephra");
		const pick = modal.getSuggestions("guide.md")[0].item as TFile;
		expect(pick.path).toBe("Sources/tephra/docs/guide.md");
		(modal as unknown as { onChooseSuggestion: (m: { item: TFile }, e: unknown) => void }).onChooseSuggestion({ item: pick }, null);
		await rig.settle();
		expect(rig.unitIndex.isAdded({ kind: "file", path: "Sources/tephra/docs/guide.md" })).toBe(true);
		const row = rowByKey(rig.h, KEY("Sources/tephra/docs/guide.md"));
		expect(row.closest(".atlas-inbox-source")!.getAttribute("data-source")).toBe("tephra");
		expect([...row.querySelectorAll(".atlas-badge")].map((el) => el.textContent)).toEqual(["added"]);
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toContain("guide");
		// Once added it is no longer on offer.
		expect(offered(openAdd(rig, "tephra"))).not.toContain("Sources/tephra/docs/guide.md");
	});
});
