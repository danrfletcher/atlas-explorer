import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App as MockApp } from "../mocks/obsidian";
import type { App } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { AtlasSettingTab, DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { openRepaintRig, RepaintRig } from "./repaint-rig";
import { BASE_KEYS, LINK_ONLY_KEYS, USER_CHOICE_KEYS, buildFixture, file } from "../auto-promotion-fixtures";

/** PR-1 (G1, F2): the real settings-tab toggle drives the real explorer pane. The toggle's handler
 * assigns the setting, saves and asks the explorer to repaint (as `AtlasPlugin.refreshExplorerViews`
 * does); the inbox rows drawn by `AtlasExplorerView.render` are then read back, with the real
 * `UnitIndex` and `ViewsManager` behind them. Needs fake timers: `queueRender` waits on a timeout. */

interface Row {
	name: string;
	toggles: { value?: boolean; onChange?: (v: boolean) => unknown }[];
}

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	function inert(): unknown {
		const proxy: unknown = new Proxy({}, { get: () => () => proxy });
		return proxy;
	}
	class FakeSetting {
		static rows: Row[] = [];
		private row: Row = { name: "", toggles: [] };
		constructor(public containerEl: HTMLElement) {
			FakeSetting.rows.push(this.row);
		}
		setName(name: string) {
			this.row.name = name;
			return this;
		}
		setDesc() {
			return this;
		}
		setHeading() {
			return this;
		}
		addToggle(cb: (c: unknown) => void) {
			const state: Row["toggles"][number] = {};
			const component = {
				setValue: (v: boolean) => ((state.value = v), component),
				onChange: (fn: (v: boolean) => unknown) => ((state.onChange = fn), component),
			};
			cb(component);
			this.row.toggles.push(state);
			return this;
		}
		addText(cb: (c: unknown) => void) {
			cb(inert());
			return this;
		}
		addTextArea(cb: (c: unknown) => void) {
			cb(inert());
			return this;
		}
		addDropdown(cb: (c: unknown) => void) {
			cb(inert());
			return this;
		}
	}
	return { ...actual, Setting: FakeSetting, Platform: { ...actual.Platform, isMobile: true } };
});

let rig: RepaintRig;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	rig?.close();
	vi.useRealTimers();
});

/** Renders the Basic tab against `settings` (the object the index reads) and returns the real toggle's
 * handler, wired to repaint `explorer` the way `refreshExplorerViews` does. */
async function autoPromotionToggle(settings: AtlasSettings, explorer: AtlasExplorerView, saves: string[]) {
	const { Setting, App: ObsidianApp } = await import("obsidian");
	const rows = (Setting as unknown as { rows: Row[] }).rows;
	rows.length = 0;
	const plugin = {
		settings,
		saveSettings: vi.fn(async () => {
			saves.push(JSON.stringify(settings.autoPromotion));
		}),
		refreshExplorerViews: () => explorer.refresh(),
		unitIndex: { rebuild: vi.fn() },
	};
	const tab = new AtlasSettingTab(new ObsidianApp() as never, plugin as never);
	(tab as unknown as { renderBasicTab(el: HTMLElement): void }).renderBasicTab(document.createElement("div"));
	const row = rows.find((r) => r.name === "Auto-promote linked items");
	if (!row) throw new Error("no Auto-promote linked items row");
	return { row, plugin };
}

async function open(settingsOverride: Partial<AtlasSettings> = {}) {
	const fx = buildFixture(settingsOverride);
	rig = await openRepaintRig({ unitIndex: fx.index, viewsManager: fx.views, realLabels: { app: fx.app as unknown as App, settings: fx.settings } });
	const explorer = rig.h.explorer as unknown as AtlasExplorerView;
	const saves: string[] = [];
	const toggle = await autoPromotionToggle(fx.settings, explorer, saves);
	return { fx, explorer, saves, ...toggle };
}

const inbox = () => rig.inboxRowKeys();

describe("auto-promotion toggle: the inbox follows the setting without a reload", () => {
	it("GP1: starts off, so the inbox holds only manual promotions, added items and base units", async () => {
		const { row } = await open();
		expect(row.toggles[0].value).toBe(false);
		for (const key of LINK_ONLY_KEYS) expect(inbox(), key).not.toContain(key);
		for (const key of [...USER_CHOICE_KEYS, ...BASE_KEYS]) expect(inbox(), key).toContain(key);
	});

	it("off to on: the link-promoted items appear, and nothing already there leaves", async () => {
		const { row } = await open();
		const before = [...inbox()];
		rig.resetPaints();
		await row.toggles[0].onChange!(true);
		await rig.settle();
		for (const key of LINK_ONLY_KEYS) expect(inbox(), key).toContain(key);
		for (const key of before) expect(inbox(), key).toContain(key);
		expect(inbox().length).toBe(before.length + LINK_ONLY_KEYS.length);
		expect(rig.paints()).toBe(1);
	});

	it("on to off: the link-promoted items are purged, manual promotions and added items stay", async () => {
		const { row } = await open({ autoPromotion: true });
		for (const key of LINK_ONLY_KEYS) expect(inbox(), key).toContain(key);
		await row.toggles[0].onChange!(false);
		await rig.settle();
		for (const key of LINK_ONLY_KEYS) expect(inbox(), key).not.toContain(key);
		for (const key of [...USER_CHOICE_KEYS, ...BASE_KEYS]) expect(inbox(), key).toContain(key);
	});

	it("the toggle saves the new value before the repaint, once per flip", async () => {
		const { row, saves } = await open();
		await row.toggles[0].onChange!(true);
		await row.toggles[0].onChange!(false);
		expect(saves).toEqual(["true", "false"]);
	});

	it("flipping repeatedly always lands on the state the setting names", async () => {
		const { row } = await open();
		const off = [...inbox()].sort();
		for (let i = 0; i < 3; i++) {
			await row.toggles[0].onChange!(true);
			await rig.settle();
			expect(inbox()).toContain(LINK_ONLY_KEYS[0]);
			await row.toggles[0].onChange!(false);
			await rig.settle();
			expect([...inbox()].sort()).toEqual(off);
		}
	});

	it("noAutoPromoteFolders: honored with the switch on, and the global switch wins when it is off", async () => {
		const { fx, row } = await open({ autoPromotion: true });
		fx.settings.noAutoPromoteFolders = ["Attachments"]; // the settings tab assigns a fresh array like this
		await row.toggles[0].onChange!(true);
		await rig.settle();
		expect(inbox()).not.toContain("file:Attachments/scan.png");
		expect(inbox()).toContain("file:Alpha/linked.md");

		await row.toggles[0].onChange!(false);
		await rig.settle();
		expect(inbox()).not.toContain("file:Attachments/scan.png");
		expect(inbox()).not.toContain("file:Alpha/linked.md");

		fx.settings.noAutoPromoteFolders = [];
		await row.toggles[0].onChange!(true);
		await rig.settle();
		expect(inbox()).toContain("file:Attachments/scan.png");
	});
});

describe("auto-promotion toggle: F2, placed units stay placed", () => {
	it("a placed view item keeps its placement, its row and its place in the saved views across every flip", async () => {
		const { fx, row } = await open();
		const placed = file("Alpha/placed.md");
		const savedBefore = JSON.stringify(fx.views.getViews());
		expect(fx.views.isPlaced(fx.viewId, placed)).toBe(true);
		expect(rig.bucketRowTexts()).toContain("Alpha/placed.md");

		for (const value of [true, false, true, false]) {
			await row.toggles[0].onChange!(value);
			await rig.settle();
			expect(fx.views.isPlaced(fx.viewId, placed), `after ${value}`).toBe(true);
			expect(rig.bucketRowTexts(), `after ${value}`).toContain("Alpha/placed.md");
			expect(inbox(), `after ${value}`).not.toContain("file:Alpha/placed.md");
			expect(JSON.stringify(fx.views.getViews()), `after ${value}`).toBe(savedBefore);
		}
	});

	it("an item placed while it was link-promoted stays placed and resolves after the switch goes off", async () => {
		const { fx, row } = await open({ autoPromotion: true });
		fx.views.placeUnit(fx.viewId, file("Alpha/linked.md"), null);
		await rig.settle();
		expect(inbox()).not.toContain("file:Alpha/linked.md");

		await row.toggles[0].onChange!(false);
		await rig.settle();
		expect(fx.views.isPlaced(fx.viewId, file("Alpha/linked.md"))).toBe(true);
		expect(rig.bucketRowTexts()).toContain("Alpha/linked.md");
		expect(fx.index.getUnits().some((u) => u.path === "Alpha/linked.md" && u.type === "promoted-file")).toBe(true);
	});
});

describe("auto-promotion toggle: E1, an empty inbox", () => {
	it("an empty vault with the switch off renders an empty inbox, and flipping the switch both ways does not throw", async () => {
		const app = new MockApp();
		const settings: AtlasSettings = { ...DEFAULT_SETTINGS, autoPromotion: false };
		const index = new UnitIndex(app as unknown as App, settings, []);
		index.rebuild();
		const views = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [] }], "v1", () => {});
		rig = await openRepaintRig({ unitIndex: index, viewsManager: views, realLabels: { app: app as unknown as App, settings } });
		expect(inbox()).toEqual([]);

		const explorer = rig.h.explorer as unknown as AtlasExplorerView;
		const { row } = await autoPromotionToggle(settings, explorer, []);
		await expect(row.toggles[0].onChange!(true)).resolves.not.toThrow();
		await rig.settle();
		expect(inbox()).toEqual([]);
		await expect(row.toggles[0].onChange!(false)).resolves.not.toThrow();
		await rig.settle();
		expect(inbox()).toEqual([]);
	});

	it("a vault whose every item is link-promoted shows an empty inbox with the switch off", async () => {
		const app = new MockApp();
		app.vault.seedFolder("Mod");
		app.vault.seedFile("Mod/Target.md");
		app.vault.seedFile("Hub.md");
		const caches = new Map<string, unknown>([["Hub.md", { links: [{ link: "Mod/Target", original: "[[Mod/Target]]" }] }]]);
		const metadata = app.metadataCache as unknown as {
			getFileCache: (f: { path: string }) => unknown;
			getFirstLinkpathDest: (link: string) => unknown;
		};
		metadata.getFileCache = (f) => caches.get(f.path) ?? null;
		metadata.getFirstLinkpathDest = (link) => app.vault.getAbstractFileByPath(`${link}.md`);
		const settings: AtlasSettings = { ...DEFAULT_SETTINGS, autoPromotion: false };
		const index = new UnitIndex(app as unknown as App, settings, []);
		index.rebuild();
		const views = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [] }], "v1", () => {});
		rig = await openRepaintRig({ unitIndex: index, viewsManager: views, realLabels: { app: app as unknown as App, settings } });
		// Hub.md and the Mod folder are base units; the linked file is the only link-promoted one.
		expect(inbox()).not.toContain("file:Mod/Target.md");
		expect(inbox()).toContain("file:Hub.md");

		const { row } = await autoPromotionToggle(settings, rig.h.explorer as unknown as AtlasExplorerView, []);
		await row.toggles[0].onChange!(true);
		await rig.settle();
		expect(inbox()).toContain("file:Mod/Target.md");
	});
});
