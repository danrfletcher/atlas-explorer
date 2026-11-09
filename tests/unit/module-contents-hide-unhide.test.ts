import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex, sanitizeHiddenModuleItems } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
import { App } from "obsidian";
import { unitRefKey, unitToRef } from "../../src/types";
import { buildFixture } from "../auto-promotion-fixtures";
import { fileRef, itemRow, makeModuleRig } from "./module-contents-fixtures";

const FILES = ["Mod/a.md", "Mod/b.md", "Mod/sub/c.md"];
const FOLDERS = ["Mod", "Mod/sub"];

afterEach(() => {
	document.body.innerHTML = "";
	vi.useRealTimers();
});

const eye = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-module-item-hide")!;

describe("G2 hide/unhide: the eye button on a Module Contents row", () => {
	it("clicking it adds the item's path under the module key, dims the row and flips the label", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		const row = itemRow(modal, "a.md");
		expect(row.classList.contains("atlas-module-item-hidden")).toBe(false);
		expect(eye(row).getAttribute("aria-label")).toBe("Hide");

		eye(row).click();

		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
		expect(row.classList.contains("atlas-module-item-hidden")).toBe(true);
		expect(eye(row).getAttribute("aria-label")).toBe("Unhide");
		expect(rig.persistDebounced).toHaveBeenCalledTimes(1);
	});

	it("clicking again removes the path and the module's now-empty entry", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		const row = itemRow(modal, "a.md");
		eye(row).click();
		eye(row).click();
		expect(rig.index.getHiddenModuleItems()).toEqual({});
		expect(row.classList.contains("atlas-module-item-hidden")).toBe(false);
	});

	it("the state persists across closing and reopening the modal", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const first = rig.openModal();
		eye(itemRow(first, "b.md")).click();
		first.close();

		const second = rig.openModal();
		expect(itemRow(second, "b.md").classList.contains("atlas-module-item-hidden")).toBe(true);
		expect(eye(itemRow(second, "b.md")).getAttribute("aria-label")).toBe("Unhide");
		expect(itemRow(second, "a.md").classList.contains("atlas-module-item-hidden")).toBe(false);
	});

	it("the click does not also open the file", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		eye(itemRow(modal, "a.md")).click();
		expect(rig.explorer.openRef).not.toHaveBeenCalled();
	});

	it("hiding a folder dims the rows under it (its branch), without writing their own entries", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		eye(itemRow(modal, "sub")).click();
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/sub"] });
		expect(itemRow(modal, "c.md").closest(".atlas-module-hidden-branch")).not.toBeNull();
		expect(rig.index.isModuleItemHidden("Mod/sub/c.md")).toBe(true);
		expect(rig.index.isModuleItemHidden("Mod/subway.md")).toBe(false); // a prefix is not a parent
	});

	it("rapid successive clicks coalesce into ONE write through the real debounced persist", async () => {
		vi.useFakeTimers();
		const rig = makeModuleRig(FILES, FOLDERS);
		const persistNow = vi.fn(async () => {});
		const { debounce } = await import("obsidian");
		(rig.plugin as unknown as Record<string, unknown>).persistDebounced = debounce(() => void persistNow(), 500, true);
		const modal = rig.openModal();
		const row = itemRow(modal, "a.md");
		for (let i = 0; i < 7; i++) {
			eye(row).click();
			vi.advanceTimersByTime(50);
		}
		expect(persistNow).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(persistNow).toHaveBeenCalledTimes(1);
		// 7 toggles from "visible" end on "hidden".
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
	});

	it("toggling on an item that is manually promoted does not unplace or un-promote it (F2)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.addManualPromotion(fileRef("Mod/a.md"));
		const placed = rig.views.placeUnit("v1", fileRef("Mod/a.md"), null);
		void placed;
		const before = JSON.stringify(rig.views.getViews());
		const modal = rig.openModal();
		eye(itemRow(modal, "a.md")).click();
		eye(itemRow(modal, "a.md")).click();
		eye(itemRow(modal, "a.md")).click();
		expect(JSON.stringify(rig.views.getViews())).toBe(before);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/a.md")]);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
	});

	it("never touches the disk (F1): no vault write call", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const before = [...rig.app.vault.calls];
		const modal = rig.openModal();
		eye(itemRow(modal, "a.md")).click();
		eye(itemRow(modal, "sub")).click();
		expect(rig.app.vault.calls).toEqual(before);
	});
});

describe("G2 hide/unhide: AtlasData serialisation", () => {
	function persistShape(hidden: Record<string, string[]>) {
		const app = new App();
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		const saved: Record<string, unknown>[] = [];
		Object.assign(plugin, {
			settings: DEFAULT_SETTINGS,
			unitIndex: new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], [], hidden),
			viewsManager: new ViewsManager(app, [], "default", () => {}),
			statusesManager: new StatusesManager([], [], () => {}),
			expandedModuleFolders: new Set<string>(),
			saveData: async (d: Record<string, unknown>) => void saved.push(d),
		});
		return { plugin, saved };
	}

	it("persistNow writes hiddenModuleItems keyed by module path, and loadFromData reads it back", async () => {
		const { plugin, saved } = persistShape({ Mod: ["Mod/a.md"] });
		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();
		expect(saved).toHaveLength(1);
		expect(saved[0].hiddenModuleItems).toEqual({ Mod: ["Mod/a.md"] });

		const fresh = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(fresh as unknown as { loadFromData(d: unknown): void }).loadFromData(JSON.parse(JSON.stringify(saved[0])));
		expect((fresh as unknown as { hiddenModuleItems: unknown }).hiddenModuleItems).toEqual({ Mod: ["Mod/a.md"] });
	});

	it("an older data.json with no hiddenModuleItems loads as nothing hidden", () => {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData({ settings: DEFAULT_SETTINGS, manualPromotions: [], views: [], activeViewId: "default", expandedModuleFolders: [], statusSets: [], colorPalette: [] });
		expect((plugin as unknown as { hiddenModuleItems: unknown }).hiddenModuleItems).toEqual({});
	});

	it("a hand-edited, malformed hiddenModuleItems is cleaned rather than thrown on", () => {
		expect(sanitizeHiddenModuleItems(null)).toEqual({});
		expect(sanitizeHiddenModuleItems("x")).toEqual({});
		expect(sanitizeHiddenModuleItems(["Mod/a.md"])).toEqual({});
		expect(sanitizeHiddenModuleItems({ Mod: "Mod/a.md", Good: ["G/x.md", "G/x.md", 3, "", null], Empty: [] })).toEqual({ Good: ["G/x.md"] });
		const app = new App();
		expect(() => new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], [], { Mod: 5 } as unknown as Record<string, string[]>)).not.toThrow();
	});

	it("getHiddenModuleItems returns copies: mutating the result leaves the index alone", () => {
		const rig = makeModuleRig(FILES, FOLDERS, { Mod: ["Mod/a.md"] });
		rig.index.getHiddenModuleItems().Mod.push("Mod/b.md");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
	});
});

describe("G2 hidden items are suppressed from link-promoted discovery (inbox); others behave normally", () => {
	const unitAt = (fx: ReturnType<typeof buildFixture>, key: string) => {
		const unit = fx.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === key);
		if (!unit) throw new Error(`no unit ${key}`);
		return unit;
	};

	it("a hidden link-only file leaves the inbox; an unhidden sibling stays; unhiding brings it back", () => {
		const fx = buildFixture({ autoPromotion: true });
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "file:Alpha/linked.md"))).toBe(false);

		fx.index.setModuleItemHidden("Alpha", "Alpha/linked.md", true);
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "file:Alpha/linked.md"))).toBe(true);
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "file:Alpha/dup.md"))).toBe(false);

		fx.index.setModuleItemHidden("Alpha", "Alpha/linked.md", false);
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "file:Alpha/linked.md"))).toBe(false);
	});

	it("a hidden FOLDER hides the link-promoted block inside a file under it", () => {
		const fx = buildFixture({ autoPromotion: true });
		fx.index.setModuleItemHidden("Beta", "Beta/page.md", true);
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "block:Beta/page.md#^linked"))).toBe(true);
	});

	it("a manual promotion or an added item stays in the inbox even when hidden (hiding never unpromotes)", () => {
		const fx = buildFixture({ autoPromotion: true });
		fx.index.setModuleItemHidden("Alpha", "Alpha/manual.md", true);
		fx.index.setModuleItemHidden("Alpha", "Alpha/both.md", true);
		fx.index.setModuleItemHidden("Beta", "Beta/addedOnly.md", true);
		for (const key of ["file:Alpha/manual.md", "file:Alpha/both.md", "file:Beta/addedOnly.md"]) {
			expect(fx.index.isSuppressedFromInbox(unitAt(fx, key)), key).toBe(false);
		}
	});

	it("a placed unit keeps resolving, and the hide changes no view (F2)", () => {
		const fx = buildFixture({ autoPromotion: true });
		fx.views.placeUnit(fx.viewId, fileRef("Alpha/placed.md"), null);
		const before = JSON.stringify(fx.views.getViews());
		fx.index.setModuleItemHidden("Alpha", "Alpha/placed.md", true);
		expect(JSON.stringify(fx.views.getViews())).toBe(before);
		expect(unitAt(fx, "file:Alpha/placed.md")).toBeDefined();
	});
});
