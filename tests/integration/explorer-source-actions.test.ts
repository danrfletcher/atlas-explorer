import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, Platform } from "obsidian";
import { AddFileSuggestModal } from "../../src/explorer-view";
import { makeSourcesRig, sectionEl, type SourcesRig } from "../sources-explorer-fixture";

// PR-5 (G3, G5): the entry points in the real explorer. The "+" on the vault's Inbox, and a source section
// header's right-click menu, built by the shipped handlers. `plugin.sourceActions` is a spy: what Add and Remove
// then do is tested in tests/unit/add-source-flow.test.ts and tests/integration/source-remove.test.ts.

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
	Platform.isMobile = false;
});

function spyActions(r: SourcesRig) {
	const actions = { addSource: vi.fn(async () => {}), removeSource: vi.fn() };
	r.plugin.sourceActions = actions;
	return actions;
}

/** Runs `act` and returns the Menu the shipped handler showed (undefined when none was shown). */
function menuFrom(act: () => void): Menu | undefined {
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	act();
	show.mockRestore(); // only this spy: a test's own spies stay in place
	return built;
}
const titles = (menu: Menu | undefined) => menu?.items.map((item) => item.title);
const header = (r: SourcesRig, name: string | null) => sectionEl(r.h, name).querySelector<HTMLElement>(":scope > .atlas-section-header")!;
const plus = (r: SourcesRig, name: string | null) => header(r, name).querySelector<HTMLElement>(".atlas-inbox-add-btn")!;
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

describe("G3: the vault Inbox's +", () => {
	it("with Tephra on it opens a menu: Add file… and Add source…; Add source… starts the add flow, Add file… the usual modal", async () => {
		rig = await makeSourcesRig();
		const actions = spyActions(rig);
		const open = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(() => {});
		const menu = menuFrom(() => plus(rig!, null).click());
		expect(titles(menu)).toEqual(["Add file…", "Add source…"]);
		expect(open).not.toHaveBeenCalled(); // opening the menu alone opens nothing
		expect(actions.addSource).not.toHaveBeenCalled();

		menu!.items[1].clickHandler!();
		expect(actions.addSource).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();

		menu!.items[0].clickHandler!();
		expect(open).toHaveBeenCalledTimes(1);
		expect(actions.addSource).toHaveBeenCalledTimes(1);
	});

	it("a source section's + is unchanged: straight to its scoped Add file modal, no menu", async () => {
		rig = await makeSourcesRig();
		const actions = spyActions(rig);
		const open = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(() => {});
		const menu = menuFrom(() => plus(rig!, "whoop").click());
		expect(menu).toBeUndefined();
		expect(open).toHaveBeenCalledTimes(1);
		expect(actions.addSource).not.toHaveBeenCalled();
	});

	it("with the Tephra toggle off the + opens the Add file modal directly, as it always did, and there is no Add source anywhere", async () => {
		rig = await makeSourcesRig({ settings: { tephraEnabled: false } });
		const actions = spyActions(rig);
		const open = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(() => {});
		const menu = menuFrom(() => plus(rig!, null).click());
		expect(menu).toBeUndefined();
		expect(open).toHaveBeenCalledTimes(1);
		const headerMenu = menuFrom(() => rightClick(header(rig!, null)));
		expect(titles(headerMenu)).toEqual(["Show Dismissed"]);
		expect(actions.addSource).not.toHaveBeenCalled();
	});

	it("on mobile (Tephra can't run) the + is the plain Add file modal", async () => {
		Platform.isMobile = true;
		rig = await makeSourcesRig();
		const open = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(() => {});
		const menu = menuFrom(() => plus(rig!, null).click());
		expect(menu).toBeUndefined();
		expect(open).toHaveBeenCalledTimes(1);
	});
});

describe("G5: a source section header's right-click menu", () => {
	it("[whoop] offers Show Dismissed and Remove; Remove asks the actions to remove whoop", async () => {
		rig = await makeSourcesRig();
		const actions = spyActions(rig);
		const menu = menuFrom(() => rightClick(header(rig!, "whoop")));
		expect(titles(menu)).toEqual(["Show Dismissed", "Remove"]);
		expect(menu!.separators).toBe(1);
		menu!.items.find((item) => item.title === "Remove")!.clickHandler!();
		expect(actions.removeSource).toHaveBeenCalledExactlyOnceWith("whoop");
	});

	it("[tephra]'s Remove names tephra, not whoop", async () => {
		rig = await makeSourcesRig();
		const actions = spyActions(rig);
		menuFrom(() => rightClick(header(rig!, "tephra")))!.items.find((item) => item.title === "Remove")!.clickHandler!();
		expect(actions.removeSource).toHaveBeenCalledExactlyOnceWith("tephra");
	});

	it("the vault's own Inbox header has no Remove (the vault can't be removed)", async () => {
		rig = await makeSourcesRig();
		const actions = spyActions(rig);
		const menu = menuFrom(() => rightClick(header(rig!, null)));
		expect(titles(menu)).toEqual(["Show Dismissed"]);
		expect(actions.removeSource).not.toHaveBeenCalled();
	});

	it("Show Dismissed still works from a source header", async () => {
		rig = await makeSourcesRig();
		spyActions(rig);
		const menu = menuFrom(() => rightClick(header(rig!, "whoop")));
		menu!.items[0].clickHandler!();
		await rig.settle();
		expect(titles(menuFrom(() => rightClick(header(rig!, "whoop"))))).toEqual(["Hide Dismissed", "Remove"]);
	});
});
