import { describe, expect, it, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import type { CachedMetadata } from "obsidian";
import AtlasPlugin from "../../src/main";
import { AtlasSettingTab, DEFAULT_SETTINGS, rewriteNoAutoPromoteFolders } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
import { seedRoot } from "../helpers";
import { unitRefKey, unitToRef } from "../../src/types";
import type { AddedItem, Unit, UnitRef } from "../../src/types";

// Obsidian's `Setting` is replaced with a recorder so the settings tab can be read back as rows.
// Every other export of the obsidian mock is kept as it is.
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();

	interface TextState {
		placeholder?: string;
		value?: unknown;
		onChange?: (value: string) => unknown;
	}
	const makeComponent = (state: TextState): unknown => {
		const proxy: unknown = new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (prop === "setPlaceholder") return (p: string) => ((state.placeholder = p), proxy);
					if (prop === "setValue") return (v: unknown) => ((state.value = v), proxy);
					if (prop === "onChange") return (fn: (value: string) => unknown) => ((state.onChange = fn), proxy);
					return () => proxy;
				},
			}
		);
		return proxy;
	};

	class FakeSetting {
		static rows: { name: string; desc: string; textAreas: TextState[] }[] = [];

		constructor(public containerEl: HTMLElement) {
			const row = { name: "", desc: "", textAreas: [] as TextState[] };
			FakeSetting.rows.push(row);
			return new Proxy(this, {
				get(target, prop, receiver) {
					if (prop === "setName") return (name: string) => ((row.name = name), receiver);
					if (prop === "setDesc") return (desc: string) => ((row.desc = desc), receiver);
					if (prop === "addTextArea")
						return (cb: (c: unknown) => void) => {
							const state: TextState = {};
							cb(makeComponent(state));
							row.textAreas.push(state);
							return receiver;
						};
					if (prop in target) return Reflect.get(target, prop, receiver);
					return (cb?: (c: unknown) => void) => {
						cb?.(makeComponent({}));
						return receiver;
					};
				},
			});
		}
	}

	return { ...actual, Setting: FakeSetting };
});

// --- Fixture ------------------------------------------------------------------------------------

const FILES = [
	"Hartley Haulage.md",
	"Attachments/Readme.md",
	"Clients/Target.md",
	"Attachments/tacho-sheet.png",
	"Attachments/manual.pdf",
	"Attachments/added.png",
	"Attachments/placed.png",
	"Attachments/dismissed.png",
	"Attachments/Sub/deep.png",
	"Attachments2/lookalike.png",
	"Projects/Old/assets/a.png",
	"Projects/Other/x.png",
];
const FOLDERS = [
	"Attachments",
	"Attachments/Sub",
	"Attachments2",
	"Clients",
	"Projects",
	"Projects/Old",
	"Projects/Old/assets",
	"Projects/Other",
];
const EMBEDS = [
	"Attachments/tacho-sheet.png",
	"Attachments/manual.pdf",
	"Attachments/added.png",
	"Attachments/placed.png",
	"Attachments/dismissed.png",
	"Attachments/Sub/deep.png",
	"Attachments2/lookalike.png",
	"Projects/Old/assets/a.png",
	"Projects/Other/x.png",
];

const file = (path: string): UnitRef => ({ kind: "file", path });

/** A vault with one note embedding every attachment, and one note inside `Attachments` linking out. */
function buildFixture(
	settingsOverride: Partial<AtlasSettings> = {},
	manualPromotions: UnitRef[] = [],
	addedItems: AddedItem[] = [],
) {
	const app = new App();
	seedRoot(app, FILES, FOLDERS);
	const caches: Record<string, CachedMetadata> = {
		"Hartley Haulage.md": { embeds: EMBEDS.map((link) => ({ link, original: `![[${link}]]` })) } as never,
		"Attachments/Readme.md": { links: [{ link: "Clients/Target", original: "[[Clients/Target]]" }] } as never,
	};
	app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) =>
		(app.vault.getAbstractFileByPath(`${linkpath}.md`) ?? app.vault.getAbstractFileByPath(linkpath)) as TFile | null) as App["metadataCache"]["getFirstLinkpathDest"];
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, noAutoPromoteFolders: [], ...settingsOverride };
	const index = new UnitIndex(app, settings, manualPromotions, {}, [], addedItems);
	index.rebuild();
	const views = new ViewsManager(app, [], "", () => {});
	const viewId = views.getActiveViewId();
	views.placeUnit(viewId, file("Attachments/placed.png"), null);
	return { app, settings, index, views, viewId };
}

/** R1: a vault with a root note linking a block inside a listed folder (`#^blk1`, no containing-file
 * promotion) and linking a nested folder's interface note inside that same listed folder (promotes
 * the folder, not `Attachments` itself — see `interfaceNoteFolderFor`). Covers the two unit kinds
 * G3's own test (file-only) never exercised. */
function buildBlockAndFolderFixture(noAutoPromoteFolders: string[]) {
	const app = new App();
	const files = ["Root.md", "Attachments/Notes.md", "Attachments/Sub/Sub.md"];
	const folders = ["Attachments", "Attachments/Sub"];
	seedRoot(app, files, folders);
	const caches: Record<string, CachedMetadata> = {
		"Root.md": {
			links: [
				{ link: "Attachments/Notes#^blk1", original: "[[Attachments/Notes#^blk1]]" },
				{ link: "Attachments/Sub/Sub", original: "[[Attachments/Sub/Sub]]" },
			],
		} as never,
	};
	app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) =>
		(app.vault.getAbstractFileByPath(`${linkpath}.md`) ?? app.vault.getAbstractFileByPath(linkpath)) as TFile | null) as App["metadataCache"]["getFirstLinkpathDest"];
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, noAutoPromoteFolders };
	const index = new UnitIndex(app, settings, [], {}, [], []);
	index.rebuild();
	const views = new ViewsManager(app, [], "", () => {});
	const viewId = views.getActiveViewId();
	return { app, settings, index, views, viewId };
}

/** The inbox as sorted unit keys, the same keys the explorer's rows are built from. */
function inboxKeys(units: Unit[]): string[] {
	return units.map((u) => unitRefKey(unitToRef(u))).sort();
}

function inbox(
	fx: ReturnType<typeof buildFixture>,
	mode: "view" | "global",
): string[] {
	return inboxKeys(fx.views.getInboxUnits(fx.index.getUnits(), fx.viewId, mode, fx.index));
}

function dismissedInbox(
	fx: ReturnType<typeof buildFixture>,
	mode: "view" | "global",
): string[] {
	return inboxKeys(fx.views.getDismissedInboxUnits(fx.index.getUnits(), fx.viewId, mode, fx.index));
}

const LISTED = ["Attachments", "Projects/Old/assets"];
/** Promoted only by links and inside a listed folder: these must leave the inbox. The default fixture
 * sets no manual promotion and no "added" item, so `manual.pdf` and `added.png` are link-only too. */
const LINK_ONLY_COVERED = [
	"file:Attachments/tacho-sheet.png",
	"file:Attachments/manual.pdf",
	"file:Attachments/added.png",
	"file:Attachments/Sub/deep.png",
	"file:Attachments/dismissed.png",
	"file:Projects/Old/assets/a.png",
];

// --- G3-G7, E1, E2, E5, E6: the inbox lists -------------------------------------------------------

describe.each(["view", "global"] as const)("inbox lists with noAutoPromoteFolders, %s mode", (mode) => {
	it("G3: drops link-only promoted units under a listed folder, and keeps everything else", () => {
		const without = buildFixture();
		const withList = buildFixture({ noAutoPromoteFolders: LISTED });
		const baseline = inbox(without, mode);
		// Sanity: without the setting every covered link-only unit really is in the inbox.
		for (const key of LINK_ONLY_COVERED) expect(baseline, key).toContain(key);
		expect(inbox(withList, mode)).toEqual(baseline.filter((key) => !LINK_ONLY_COVERED.includes(key)));
	});

	it("G3: drops a link-only promoted-block and a link-only promoted-folder under a listed folder", () => {
		const without = buildBlockAndFolderFixture([]);
		const baseline = inbox(without, mode);
		expect(baseline).toContain("block:Attachments/Notes.md#^blk1");
		expect(baseline).toContain("folder:Attachments/Sub");

		const withList = buildBlockAndFolderFixture(["Attachments"]);
		const covered = inbox(withList, mode);
		expect(covered).not.toContain("block:Attachments/Notes.md#^blk1");
		expect(covered).not.toContain("folder:Attachments/Sub");
		expect(covered).toEqual(baseline.filter((key) => key !== "block:Attachments/Notes.md#^blk1" && key !== "folder:Attachments/Sub"));
	});

	it("G3/E6: a listed nested folder covers only its own sub-tree", () => {
		const fx = buildFixture({ noAutoPromoteFolders: ["Projects/Old/assets"] });
		const keys = inbox(fx, mode);
		expect(keys).not.toContain("file:Projects/Old/assets/a.png");
		expect(keys).toContain("file:Projects/Other/x.png");
	});

	it("G3 (lookalike): Attachments2/x.png is not covered by an Attachments entry", () => {
		const keys = inbox(buildFixture({ noAutoPromoteFolders: ["Attachments"] }), mode);
		expect(keys).toContain("file:Attachments2/lookalike.png");
	});

	it("G4: a link from inside a covered folder still promotes its target", () => {
		const keys = inbox(buildFixture({ noAutoPromoteFolders: LISTED }), mode);
		expect(keys).toContain("file:Clients/Target.md");
	});

	it("G5: a manually promoted file in a covered folder stays in the inbox (E5 manual wins)", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED }, [file("Attachments/manual.pdf")]);
		expect(inbox(fx, mode)).toContain("file:Attachments/manual.pdf");
	});

	it("G5: an added item in a covered folder is never blocked and shows its own row", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED }, [], [{ ref: file("Attachments/added.png"), tag: "added" }]);
		expect(inbox(fx, mode)).toContain("file:Attachments/added.png");
	});

	it("G7: an already-placed item in a covered folder stays placed and resolves as a normal unit", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED });
		expect(fx.views.isPlaced(fx.viewId, file("Attachments/placed.png"))).toBe(true);
		expect(inbox(fx, mode)).not.toContain("file:Attachments/placed.png");
		const unit = fx.index.getUnits().find((u) => u.path === "Attachments/placed.png");
		expect(unit?.type).toBe("promoted-file");
	});

	it("G6: covered folders still appear as modules and their files are still units", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED });
		const units = fx.index.getUnits();
		expect(units.some((u) => u.type === "folder-unit" && u.path === "Attachments")).toBe(true);
		expect(units.some((u) => u.type === "promoted-file" && u.path === "Attachments/tacho-sheet.png")).toBe(true);
	});

	it("E1: a folder both excluded and listed behaves exactly as excluded alone", () => {
		const excludedOnly = buildFixture({ excludedFolders: ["Attachments"] });
		const both = buildFixture({ excludedFolders: ["Attachments"], noAutoPromoteFolders: ["Attachments"] });
		expect(inbox(both, mode)).toEqual(inbox(excludedOnly, mode));
	});

	it("E2: a listed folder that doesn't exist is ignored without error", () => {
		const without = buildFixture();
		const withMissing = buildFixture({ noAutoPromoteFolders: ["Nope/Missing"] });
		expect(inbox(withMissing, mode)).toEqual(inbox(without, mode));
	});

	it("E5/F2: a dismissed link-only unit in a covered folder is hidden from both lists", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED });
		fx.index.setDismissed(file("Attachments/dismissed.png"), "global", true);
		expect(inbox(fx, mode)).not.toContain("file:Attachments/dismissed.png");
		expect(dismissedInbox(fx, mode)).not.toContain("file:Attachments/dismissed.png");
	});

	it("F2: a dismissed unit outside any listed folder still appears in the dismissed list", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED });
		fx.index.setDismissed(file("Projects/Other/x.png"), "global", true);
		expect(inbox(fx, mode)).not.toContain("file:Projects/Other/x.png");
		expect(dismissedInbox(fx, mode)).toContain("file:Projects/Other/x.png");
	});

	it("F3: the inbox lists never touch the vault", () => {
		const fx = buildFixture({ noAutoPromoteFolders: LISTED });
		const before = fx.app.vault.calls.length;
		inbox(fx, mode);
		dismissedInbox(fx, mode);
		expect(fx.app.vault.calls.length).toBe(before);
	});
});

describe("inbox lists: the list is read in both list functions the same way", () => {
	it("a hand-edited, unnormalised entry still covers its folder", () => {
		const fx = buildFixture({ noAutoPromoteFolders: ["/Attachments/"] });
		expect(inbox(fx, "view")).not.toContain("file:Attachments/tacho-sheet.png");
	});
});

// --- E4: renames and moves keep the entry pointing at the folder -------------------------------

/** The plugin with only the state the rename and move handlers touch. */
function renamePlugin(settings: Partial<AtlasSettings>) {
	const fx = buildFixture(settings);
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const order: string[] = [];
	const saveData = vi.fn(async () => {
		order.push("save");
	});
	Object.assign(plugin, {
		settings: fx.settings,
		unitIndex: fx.index,
		viewsManager: fx.views,
		graduation: { handleRename: vi.fn(), handleDelete: vi.fn() },
		statusesManager: new StatusesManager([], [], () => {}),
		expandedModuleFolders: new Set<string>(),
		persistDebounced: vi.fn(),
		saveData,
	});
	vi.spyOn(fx.index, "rebuild").mockImplementation(() => {
		order.push("rebuild");
	});
	const viewsRename = vi.spyOn(fx.views, "onVaultRename").mockImplementation(() => {
		order.push("views");
	});
	return { plugin, fx, order, saveData, viewsRename };
}

function folderAt(path: string): TFolder {
	const folder = new TFolder();
	folder.path = path;
	folder.name = path.split("/").pop() ?? path;
	return folder;
}

function fileAt(path: string): TFile {
	const f = new TFile();
	f.path = path;
	f.name = path.split("/").pop() ?? path;
	return f;
}

describe("E4: renames and moves rewrite noAutoPromoteFolders before the index rebuild", () => {
	it("folder rename rewrites the entry, saves, and only then rebuilds the index", () => {
		const { plugin, fx, order, saveData } = renamePlugin({ noAutoPromoteFolders: ["Attachments", "Projects/Old/assets"] });
		(plugin as unknown as { onVaultRenameEvent(f: TFolder, old: string): void }).onVaultRenameEvent(folderAt("Media"), "Attachments");
		expect(fx.settings.noAutoPromoteFolders).toEqual(["Media", "Projects/Old/assets"]);
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(saveData.mock.calls[0][0]).toMatchObject({ settings: { noAutoPromoteFolders: ["Media", "Projects/Old/assets"] } });
		expect(order.indexOf("save")).toBeLessThan(order.indexOf("rebuild"));
	});

	it("parent rename rewrites a nested entry by prefix", () => {
		const { plugin, fx, order } = renamePlugin({ noAutoPromoteFolders: ["Projects/Old/assets"] });
		(plugin as unknown as { onVaultRenameEvent(f: TFolder, old: string): void }).onVaultRenameEvent(folderAt("Projects/New"), "Projects/Old");
		expect(fx.settings.noAutoPromoteFolders).toEqual(["Projects/New/assets"]);
		expect(order.indexOf("save")).toBeLessThan(order.indexOf("rebuild"));
	});

	it("a move of a listed folder into another parent rewrites the entry", () => {
		const { plugin, fx } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		(plugin as unknown as { onVaultRenameEvent(f: TFolder, old: string): void }).onVaultRenameEvent(folderAt("Archive/Attachments"), "Attachments");
		expect(fx.settings.noAutoPromoteFolders).toEqual(["Archive/Attachments"]);
	});

	it("an unrelated rename changes no setting and saves nothing", () => {
		const { plugin, fx, saveData } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		const before = fx.settings.noAutoPromoteFolders;
		(plugin as unknown as { onVaultRenameEvent(f: TFile, old: string): void }).onVaultRenameEvent(fileAt("Notes/Hartley.md"), "Hartley Haulage.md");
		expect(fx.settings.noAutoPromoteFolders).toBe(before);
		expect(saveData).not.toHaveBeenCalled();
	});

	it("a prefix lookalike is not rewritten", () => {
		const { plugin, fx } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		(plugin as unknown as { onVaultRenameEvent(f: TFolder, old: string): void }).onVaultRenameEvent(folderAt("Media"), "Attachments2");
		expect(fx.settings.noAutoPromoteFolders).toEqual(["Attachments"]);
	});

	it("deleting a listed folder leaves the entry in place", () => {
		const { fx, saveData } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		fx.index.onVaultDelete("Attachments");
		expect(fx.settings.noAutoPromoteFolders).toEqual(["Attachments"]);
		expect(saveData).not.toHaveBeenCalled();
	});

	it("onHiddenMove (handleHiddenMove) rewrites and saves before the next placement hook", () => {
		const { plugin, fx, order } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		(plugin as unknown as { handleHiddenMove(o: string, n: string): void }).handleHiddenMove("Attachments", "Media");
		expect(fx.settings.noAutoPromoteFolders).toEqual(["Media"]);
		expect(order).toEqual(["save", "views"]);
	});

	// R3: onVaultRenameEvent and handleHiddenMove rewrite the setting and persist plugin data (saveData,
	// mocked above) but must never touch the vault itself — rename handling is a pure data-model update.
	it("R3: onVaultRenameEvent makes no vault write or rename call", () => {
		const { plugin, fx } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		const before = fx.app.vault.calls.length;
		(plugin as unknown as { onVaultRenameEvent(f: TFolder, old: string): void }).onVaultRenameEvent(folderAt("Media"), "Attachments");
		expect(fx.app.vault.calls.length).toBe(before);
	});

	it("R3: handleHiddenMove makes no vault write or rename call", () => {
		const { plugin, fx } = renamePlugin({ noAutoPromoteFolders: ["Attachments"] });
		const before = fx.app.vault.calls.length;
		(plugin as unknown as { handleHiddenMove(o: string, n: string): void }).handleHiddenMove("Attachments", "Media");
		expect(fx.app.vault.calls.length).toBe(before);
	});
});

describe("rewriteNoAutoPromoteFolders", () => {
	it("returns null when nothing matches, so callers can skip the save", () => {
		expect(rewriteNoAutoPromoteFolders(["Attachments"], "Other", "Elsewhere")).toBeNull();
	});
});

// --- Settings tab -------------------------------------------------------------------------------

describe("settings tab: the new textarea", () => {
	type Row = { name: string; desc: string; textAreas: { placeholder?: string; value?: unknown; onChange?: (v: string) => unknown }[] };

	async function renderBasicTab() {
		const { Setting } = await import("obsidian");
		const rows = (Setting as unknown as { rows: Row[] }).rows;
		rows.length = 0;
		const plugin = {
			settings: { ...DEFAULT_SETTINGS, poolFolder: "_pool", noAutoPromoteFolders: [] as string[] },
			saveSettings: vi.fn(async () => {}),
			unitIndex: { rebuild: vi.fn() },
		};
		const tab = new AtlasSettingTab(new App() as never, plugin as never);
		(tab as unknown as { renderBasicTab(el: HTMLElement): void }).renderBasicTab(document.createElement("div"));
		return { rows, plugin };
	}

	it("sits directly under Excluded folders, with the stated label, description and placeholder, empty by default", async () => {
		const { rows } = await renderBasicTab();
		const i = rows.findIndex((r) => r.name === "Excluded folders");
		expect(rows[i + 1].name).toBe("Never auto-promote from these folders");
		expect(rows[i + 1].desc).toBe(
			"One per line. Files here still show in the explorer and can be added with +, but links and embeds never promote them into the inbox. The pool folder can't be listed."
		);
		expect(rows[i + 1].textAreas[0].placeholder).toBe("Attachments");
		expect(rows[i + 1].textAreas[0].value).toBe("");
	});

	it("a change saves the normalised array, refreshes the inbox, and never mutates the shared default", async () => {
		const { rows, plugin } = await renderBasicTab();
		const row = rows.find((r) => r.name === "Never auto-promote from these folders")!;
		const sharedDefault = DEFAULT_SETTINGS.noAutoPromoteFolders;
		await row.textAreas[0].onChange?.("  /Attachments/ \n\n_pool/\nProjects/Old/assets\n");
		expect(plugin.settings.noAutoPromoteFolders).toEqual(["Attachments", "Projects/Old/assets"]);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.unitIndex.rebuild).toHaveBeenCalledTimes(1);
		expect(DEFAULT_SETTINGS.noAutoPromoteFolders).toBe(sharedDefault);
		expect(DEFAULT_SETTINGS.noAutoPromoteFolders).toEqual([]);
	});
});
