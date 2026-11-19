import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, Platform } from "obsidian";
import { makeSourcesRig, sectionEl, sectionTitles, type SourcesRig } from "../sources-explorer-fixture";

// PR-11 (G4): Rename on the Inbox section header's right-click menu, built by the shipped
// `AtlasExplorerView` handler (`showInboxHeaderMenu`) over the mock `Menu` in tests/mocks/obsidian.ts.
// Rename is on every non-vault `[name]` header, never on the vault (`notes`) header, disabled with the
// Atlas-owned "Tephra offline" tooltip while Tephra is down, and with the G16 toggle off there are no source
// headers and so no Rename (nor Remove) from any header menu. What Rename then does is tested in
// tests/integration/source-rename.test.ts; the wider Add/Remove menu in tests/integration/explorer-source-actions.test.ts.

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
	Platform.isMobile = false;
});

function spyRenamer(r: SourcesRig) {
	const renamer = { rename: vi.fn(async () => {}) };
	r.plugin.sourceRenamer = renamer;
	r.plugin.sourceActions = { addSource: vi.fn(async () => {}), removeSource: vi.fn() };
	return renamer;
}

/** Runs `act` and returns the Menu the shipped handler showed (undefined when none was shown). */
function menuFrom(act: () => void): Menu | undefined {
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	act();
	show.mockRestore();
	return built;
}

const header = (r: SourcesRig, name: string | null) => sectionEl(r.h, name).querySelector<HTMLElement>(":scope > .atlas-section-header")!;
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const renameItem = (menu: Menu | undefined) => menu?.items.find((item) => item.title === "Rename");

describe("Rename on a source header's menu", () => {
	it("is present and enabled on every non-vault header, and names the header's own source", async () => {
		rig = await makeSourcesRig();
		const renamer = spyRenamer(rig);
		for (const name of ["whoop", "tephra"]) {
			const item = renameItem(menuFrom(() => rightClick(header(rig!, name))));
			expect(item, name).toBeDefined();
			expect(item!.disabled).toBe(false);
			expect(item!.icon).toBe("pencil");
			item!.clickHandler!();
		}
		expect(renamer.rename.mock.calls).toEqual([["whoop"], ["tephra"]]);
	});

	it("sits between Show Dismissed and Remove, after a separator", async () => {
		rig = await makeSourcesRig();
		spyRenamer(rig);
		const menu = menuFrom(() => rightClick(header(rig!, "whoop")));
		expect(menu!.titles()).toEqual(["Show Dismissed", "Rename", "Remove"]);
		expect(menu!.separators).toBe(1);
	});

	it("is absent on the vault (`notes`) header, which has neither Rename nor Remove", async () => {
		rig = await makeSourcesRig();
		const renamer = spyRenamer(rig);
		const menu = menuFrom(() => rightClick(header(rig!, null)));
		expect(menu).toBeDefined(); // the vault header keeps its Show Dismissed menu
		expect(menu!.titles()).toEqual(["Show Dismissed"]);
		expect(renameItem(menu)).toBeUndefined();
		expect(renamer.rename).not.toHaveBeenCalled();
	});

	it("is disabled with Tephra offline, with the Atlas-owned 'Tephra offline' tooltip and not aria-label", async () => {
		rig = await makeSourcesRig();
		spyRenamer(rig);
		rig.daemon.down = true;
		await rig.connection.check(); // Tephra goes down; the sections stay with their last list
		expect(rig.connection.getSnapshot().state).not.toBe("online");
		const menu = menuFrom(() => rightClick(header(rig!, "whoop")));
		const item = renameItem(menu)!;
		expect(item.disabled).toBe(true);
		expect(item.dom.getAttribute("aria-label")).toBeNull();
		expect(document.querySelector(".atlas-tephra-tooltip")).toBeNull();

		document.body.appendChild(item.dom);
		item.dom.dispatchEvent(new MouseEvent("mouseenter"));
		const tip = document.querySelector<HTMLElement>(".atlas-tephra-tooltip")!;
		expect(tip.textContent).toBe("Tephra offline");
		expect(tip.parentElement).toBe(document.body);
		menu!.hide();
		expect(document.querySelector(".atlas-tephra-tooltip")).toBeNull();
		item.dom.remove();
	});

	it("is enabled again, with no tooltip, once Tephra answers", async () => {
		rig = await makeSourcesRig();
		spyRenamer(rig);
		rig.daemon.down = true;
		await rig.connection.check();
		rig.daemon.down = false;
		await rig.connection.check();
		const item = renameItem(menuFrom(() => rightClick(header(rig!, "whoop"))))!;
		expect(item.disabled).toBe(false);
		item.dom.dispatchEvent(new MouseEvent("mouseenter"));
		expect(document.querySelector(".atlas-tephra-tooltip")).toBeNull();
	});
});

describe("with the Tephra toggle off (G16)", () => {
	it("there are no source headers and the vault header's menu is only Show Dismissed", async () => {
		rig = await makeSourcesRig({ settings: { tephraEnabled: false } });
		const renamer = spyRenamer(rig);
		expect(rig.h.panel().querySelectorAll(".atlas-inbox-source")).toHaveLength(0);
		expect(sectionTitles(rig.h)).not.toContain("whoop");
		const menu = menuFrom(() => rightClick(header(rig!, null)));
		expect(menu!.titles()).toEqual(["Show Dismissed"]);
		expect(renameItem(menu)).toBeUndefined();
		expect(renamer.rename).not.toHaveBeenCalled();
	});

	it("the header menu handler itself gives no Rename or Remove for a source name when the toggle is turned off", async () => {
		rig = await makeSourcesRig();
		spyRenamer(rig);
		const whoopHeader = header(rig, "whoop"); // drawn while the toggle was on, the toggle then goes off
		rig.settings.tephraEnabled = false;
		const menu = menuFrom(() => rightClick(whoopHeader));
		expect(menu!.titles()).toEqual(["Show Dismissed"]);
	});

	it("on mobile (Tephra can't run) the toggle counts as off: no source headers, no Rename", async () => {
		Platform.isMobile = true;
		rig = await makeSourcesRig();
		spyRenamer(rig);
		expect(rig.h.panel().querySelectorAll(".atlas-inbox-source")).toHaveLength(0);
		const menu = menuFrom(() => rightClick(header(rig!, null)));
		expect(renameItem(menu)).toBeUndefined();
	});
});
