/** PR-1 (G1): one vault covering every inbox unit kind the auto-promotion switch has to tell apart,
 * built on the real `UnitIndex` and `ViewsManager` against the mock vault. Not a `*.test.ts` file, so
 * vitest's include glob skips it. */
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { AtlasSettings } from "../src/settings";
import { UnitIndex } from "../src/unit-index";
import { ViewsManager } from "../src/views";
import { unitRefKey, unitToRef } from "../src/types";
import type { AddedItem, Unit, UnitRef } from "../src/types";
import { seedRoot } from "./helpers";

export const FILES = [
	"Hub.md", // vault-root note that holds every link below
	"Second.md", // vault-root note linking the same target as Hub.md (duplicate references)
	"Alpha/Alpha.md",
	"Alpha/linked.md", // promoted-file, link only
	"Alpha/dup.md", // promoted-file, linked from two notes
	"Alpha/manual.md", // manual promotion, not linked
	"Alpha/both.md", // linked AND a manual promotion
	"Alpha/addedLinked.md", // linked AND an added item
	"Alpha/placed.md", // linked and already placed in the view
	"Beta/Beta.md",
	"Beta/page.md", // holds the promoted blocks
	"Beta/Sub/Sub.md", // interface note of Beta/Sub: a link promotes the folder Beta/Sub
	"Beta/addedOnly.md", // added item, not linked
	"Attachments/scan.png", // link only, inside a folder that noAutoPromoteFolders can list
];
export const FOLDERS = ["Alpha", "Beta", "Beta/Sub", "Beta/Sub2", "Attachments"];

const HUB_LINKS = [
	"Alpha/linked",
	"Alpha/dup",
	"Alpha/both",
	"Alpha/addedLinked",
	"Alpha/placed",
	"Beta/Sub/Sub",
	"Beta/page#^linked",
	"Beta/page#^manual",
	"Attachments/scan.png",
];

export const file = (path: string): UnitRef => ({ kind: "file", path });
export const folder = (path: string): UnitRef => ({ kind: "folder", path });
export const block = (path: string, subpath: string): UnitRef => ({ kind: "block", path, subpath });

/** Keys a link alone puts in the index (link-only), before any manual or added overlap. */
export const LINK_ONLY_KEYS = [
	"file:Alpha/linked.md",
	"file:Alpha/dup.md",
	"folder:Beta/Sub",
	"block:Beta/page.md#^linked",
	"file:Attachments/scan.png",
];
/** Keys a user choice backs: a manual promotion or an added item. They survive the switch either way. */
export const USER_CHOICE_KEYS = [
	"file:Alpha/manual.md", // promoted-file (manual)
	"file:Alpha/both.md", // promoted-file (linked and manual)
	"block:Beta/page.md#^manual", // promoted-block (linked and manual)
	"file:Alpha/addedLinked.md", // added-file (linked and added)
	"file:Beta/addedOnly.md", // added-file
	"folder:Beta/Sub2", // added-folder
];
/** Base units, never link-only. */
export const BASE_KEYS = ["folder:Alpha", "folder:Beta", "folder:Attachments", "file:Hub.md", "file:Second.md"];

export interface Fixture {
	app: App;
	settings: AtlasSettings;
	index: UnitIndex;
	views: ViewsManager;
	viewId: string;
}

export function buildFixture(settingsOverride: Partial<AtlasSettings> = {}): Fixture {
	const app = new App();
	seedRoot(app, FILES, FOLDERS);
	const caches: Record<string, CachedMetadata> = {
		"Hub.md": { links: HUB_LINKS.map((link) => ({ link, original: `[[${link}]]` })) } as never,
		"Second.md": { links: [{ link: "Alpha/dup", original: "[[Alpha/dup]]" }] } as never,
	};
	app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) =>
		(app.vault.getAbstractFileByPath(`${linkpath}.md`) ?? app.vault.getAbstractFileByPath(linkpath)) as TFile | null) as App["metadataCache"]["getFirstLinkpathDest"];

	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, noAutoPromoteFolders: [], ...settingsOverride };
	const manualPromotions = [file("Alpha/manual.md"), file("Alpha/both.md"), block("Beta/page.md", "^manual")];
	const addedItems: AddedItem[] = [
		{ ref: file("Alpha/addedLinked.md"), tag: "added" },
		{ ref: file("Beta/addedOnly.md"), tag: "added" },
		{ ref: folder("Beta/Sub2"), tag: "added" },
	];
	const index = new UnitIndex(app, settings, manualPromotions, {}, [], addedItems);
	index.rebuild();
	const views = new ViewsManager(app, [], "", () => {});
	const viewId = views.getActiveViewId();
	views.placeUnit(viewId, file("Alpha/placed.md"), null);
	return { app, settings, index, views, viewId };
}

/** Sorted ref keys of a unit list. */
export function keysOf(units: Unit[]): string[] {
	return units.map((u) => unitRefKey(unitToRef(u))).sort();
}

export function inboxKeys(fx: Fixture, mode: "view" | "global"): string[] {
	return keysOf(fx.views.getInboxUnits(fx.index.getUnits(), fx.viewId, mode, fx.index));
}
