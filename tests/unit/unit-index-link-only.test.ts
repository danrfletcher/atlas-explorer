import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { unitRefKey, unitToRef } from "../../src/types";
import type { Unit } from "../../src/types";
import { seedRoot } from "../helpers";
import { BASE_KEYS, LINK_ONLY_KEYS, USER_CHOICE_KEYS, buildFixture, file } from "../auto-promotion-fixtures";

/** PR-1 (G1): the classification helper `UnitIndex.isLinkOnlyPromotion`, and the inbox rule
 * `isSuppressedFromInbox` built on it. */

function unitAt(fx: ReturnType<typeof buildFixture>, key: string): Unit {
	const unit = fx.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === key);
	if (!unit) throw new Error(`no unit ${key}`);
	return unit;
}

describe("UnitIndex.isLinkOnlyPromotion — which units a link alone put in the index", () => {
	it.each(LINK_ONLY_KEYS)("link-only: %s", (key) => {
		const fx = buildFixture({ autoPromotion: true });
		expect(fx.index.isLinkOnlyPromotion(unitAt(fx, key))).toBe(true);
	});

	it.each(USER_CHOICE_KEYS)("backed by a manual promotion or an added item: %s", (key) => {
		const fx = buildFixture({ autoPromotion: true });
		expect(fx.index.isLinkOnlyPromotion(unitAt(fx, key))).toBe(false);
	});

	it.each(BASE_KEYS)("a base unit is never link-only: %s", (key) => {
		const fx = buildFixture({ autoPromotion: true });
		expect(fx.index.isLinkOnlyPromotion(unitAt(fx, key))).toBe(false);
	});

	it("the answer does not depend on the autoPromotion setting", () => {
		const fx = buildFixture({ autoPromotion: false });
		for (const unit of fx.index.getUnits()) {
			const off = fx.index.isLinkOnlyPromotion(unit);
			fx.settings.autoPromotion = true;
			const on = fx.index.isLinkOnlyPromotion(unit);
			fx.settings.autoPromotion = false;
			expect(on, unitRefKey(unitToRef(unit))).toBe(off);
		}
	});

	it("adding a manual promotion for a link-only unit makes it no longer link-only", () => {
		const fx = buildFixture({ autoPromotion: false });
		const key = "file:Alpha/linked.md";
		expect(fx.index.isLinkOnlyPromotion(unitAt(fx, key))).toBe(true);
		fx.index.addManualPromotion(file("Alpha/linked.md"));
		expect(fx.index.isLinkOnlyPromotion(unitAt(fx, key))).toBe(false);
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, key))).toBe(false);
	});

	it("marking a link-only unit as added makes it an added-file, which is not link-only", () => {
		const fx = buildFixture({ autoPromotion: false });
		fx.index.markAdded(file("Alpha/linked.md"));
		const unit = unitAt(fx, "file:Alpha/linked.md");
		expect(unit.type).toBe("added-file");
		expect(fx.index.isLinkOnlyPromotion(unit)).toBe(false);
	});
});

describe("UnitIndex.isSuppressedFromInbox — the switch and noAutoPromoteFolders", () => {
	it("off: every link-only unit is suppressed, whatever folder it is in", () => {
		const fx = buildFixture({ autoPromotion: false });
		for (const key of LINK_ONLY_KEYS) expect(fx.index.isSuppressedFromInbox(unitAt(fx, key)), key).toBe(true);
		for (const key of [...USER_CHOICE_KEYS, ...BASE_KEYS]) expect(fx.index.isSuppressedFromInbox(unitAt(fx, key)), key).toBe(false);
	});

	it("on, no folder listed: nothing is suppressed", () => {
		const fx = buildFixture({ autoPromotion: true });
		for (const unit of fx.index.getUnits()) expect(fx.index.isSuppressedFromInbox(unit), unitRefKey(unitToRef(unit))).toBe(false);
	});

	it("on, a folder listed: only link-only units under it are suppressed (noAutoPromoteFolders still honored)", () => {
		const fx = buildFixture({ autoPromotion: true, noAutoPromoteFolders: ["Attachments"] });
		const suppressed = fx.index
			.getUnits()
			.filter((u) => fx.index.isSuppressedFromInbox(u))
			.map((u) => unitRefKey(unitToRef(u)));
		expect(suppressed).toEqual(["file:Attachments/scan.png"]);
	});

	it("on, a listed folder never suppresses a manual promotion or an added item", () => {
		const fx = buildFixture({ autoPromotion: true, noAutoPromoteFolders: ["Alpha", "Beta"] });
		for (const key of USER_CHOICE_KEYS) expect(fx.index.isSuppressedFromInbox(unitAt(fx, key)), key).toBe(false);
	});

	it("off: the global switch takes precedence, so a unit outside every listed folder is suppressed too", () => {
		const fx = buildFixture({ autoPromotion: false, noAutoPromoteFolders: ["Attachments"] });
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "file:Alpha/linked.md"))).toBe(true);
		expect(fx.index.isSuppressedFromInbox(unitAt(fx, "file:Attachments/scan.png"))).toBe(true);
	});

	it("flipping the setting changes the answer at once, with no index rebuild", () => {
		const fx = buildFixture({ autoPromotion: false });
		const unit = unitAt(fx, "file:Alpha/linked.md");
		expect(fx.index.isSuppressedFromInbox(unit)).toBe(true);
		fx.settings.autoPromotion = true;
		expect(fx.index.isSuppressedFromInbox(unit)).toBe(false);
		fx.settings.autoPromotion = false;
		expect(fx.index.isSuppressedFromInbox(unit)).toBe(true);
	});
});

describe("duplicate references across notes", () => {
	function twoNoteIndex(autoPromotion: boolean) {
		const app = new App();
		seedRoot(app, ["One.md", "Two.md", "Three.md", "Mod/Target.md"], ["Mod"]);
		const link = { link: "Mod/Target", original: "[[Mod/Target]]" };
		const caches: Record<string, CachedMetadata> = {
			"One.md": { links: [link] } as never,
			"Two.md": { links: [link], embeds: [link] } as never,
			"Three.md": { links: [link] } as never,
		};
		app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
		app.metadataCache.getFirstLinkpathDest = ((linkpath: string) =>
			app.vault.getAbstractFileByPath(`${linkpath}.md`) as TFile | null) as App["metadataCache"]["getFirstLinkpathDest"];
		const settings = { ...DEFAULT_SETTINGS, autoPromotion };
		const index = new UnitIndex(app, settings, []);
		index.rebuild();
		return { index, settings };
	}

	it("five references from three notes make one unit, and it is suppressed while the switch is off", () => {
		const { index } = twoNoteIndex(false);
		const promoted = index.getUnits().filter((u) => u.path === "Mod/Target.md");
		expect(promoted).toHaveLength(1);
		expect(promoted[0].type).toBe("promoted-file");
		expect(index.isLinkOnlyPromotion(promoted[0])).toBe(true);
		expect(index.isSuppressedFromInbox(promoted[0])).toBe(true);
	});

	it("the index is identical with the switch on or off: suppression leaves no extra or missing record", () => {
		const { index, settings } = twoNoteIndex(false);
		const before = JSON.stringify(index.getUnits());
		settings.autoPromotion = true;
		expect(JSON.stringify(index.getUnits())).toBe(before);
		index.onMetadataResolved();
		expect(JSON.stringify(index.getUnits())).toBe(before);
	});

	it("when one of the notes drops its link the unit stays suppressed, and when the last one goes the unit is gone", () => {
		const { index } = twoNoteIndex(false);
		const app = (index as unknown as { app: App }).app;
		const cache = app.metadataCache.getFileCache as (f: TFile) => CachedMetadata | null;
		const original = cache;
		app.metadataCache.getFileCache = ((f: TFile) => (f.path === "One.md" || f.path === "Three.md" ? null : original(f))) as App["metadataCache"]["getFileCache"];
		index.onMetadataResolved();
		const left = index.getUnits().filter((u) => u.path === "Mod/Target.md");
		expect(left).toHaveLength(1);
		expect(index.isSuppressedFromInbox(left[0])).toBe(true);
		app.metadataCache.getFileCache = (() => null) as App["metadataCache"]["getFileCache"];
		index.onMetadataResolved();
		expect(index.getUnits().filter((u) => u.path === "Mod/Target.md")).toHaveLength(0);
	});
});
