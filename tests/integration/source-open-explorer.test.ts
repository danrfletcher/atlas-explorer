import { afterEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Menu, Notice, TFile } from "obsidian";
import { refTargetExists } from "../../src/middle-click-open";
import { unitRefKey, type UnitRef } from "../../src/types";
import { makeSourcesRig, rowByKey, sectionEl, type SourcesRig } from "../sources-explorer-fixture";
import { sourcesVaultPaths } from "../sources-vault";

// PR-6 (G7, F2, F3, F8, E1, E5, GP3): the real explorer over the PR-4 fixture vault (plus a few extra
// `Sources/` files) and a fake Tephra over HTTP. Real: the rows' click / auxclick / context-menu handlers,
// `openRef`, the opener rule, Module Contents. Stand-ins: Obsidian's workspace (a recording `getLeaf`), its
// default-app opener (`app.openWithDefaultApp`, recorded), and the view registry (a plain map the test fills).

const EXTRA = [
	"Sources/whoop/Plan.docx",
	"Sources/whoop/Report.PDF",
	"Sources/whoop/Café — plan.md",
	"Sources/whoop/Leg Day 🏋️.md",
	"Sources/whoop/README.md",
	"Sources/whoop/Notes.gdoc",
	"Sources/whoop/Archive.zip",
	"Sources/tephra/Makefile",
	"Workout Plan.md", // a same-named note at the vault root: the source's must win by full path
];
const PATHS = [...sourcesVaultPaths(), ...EXTRA];

interface FakeLeaf {
	opened: TFile | null;
	openFile: ReturnType<typeof vi.fn>;
}
interface Rig extends SourcesRig {
	leaves: FakeLeaf[];
	getLeaf: ReturnType<typeof vi.fn>;
	openLinkText: ReturnType<typeof vi.fn>;
	defaultApp: string[];
	registry: Record<string, string>;
	/** Every file handed to a leaf's `openFile`, in call order. */
	opened: () => string[];
}

let rig: Rig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	document.querySelectorAll(".modal-container").forEach((el) => el.remove());
	await rig?.teardown();
	rig = null;
});

async function makeRig(options: Parameters<typeof makeSourcesRig>[0] = {}): Promise<Rig> {
	const base = await makeSourcesRig({ vaultPaths: PATHS, ...options });
	const app = base.app;
	// jsdom has no layout and the Inbox draws only the rows in view: a tall viewport draws every row of every section.
	base.h.setViewportHeight(10000);
	base.h.fireResize();
	await base.settle();
	const leaves: FakeLeaf[] = [];
	const order: string[] = [];
	const newLeaf = (): FakeLeaf => {
		const leaf: FakeLeaf = { opened: null, openFile: vi.fn() };
		leaf.openFile = vi.fn(async (file: TFile) => {
			leaf.opened = file;
			order.push(file.path);
		});
		leaves.push(leaf);
		return leaf;
	};
	const current = newLeaf();
	const getLeaf = vi.fn((newTab?: boolean) => (newTab ? newLeaf() : current));
	const openLinkText = vi.fn(async (_link: string, _source: string, _newLeaf?: boolean) => {});
	Object.assign(app.workspace, { getLeaf, openLinkText });
	const internals = app as unknown as { viewRegistry: { typeByExtension: Record<string, string> }; defaultAppOpens: string[] };
	// What VS Code Workbench registers, stubbed.
	Object.assign(internals.viewRegistry.typeByExtension, { rs: "workbench", ts: "workbench", toml: "workbench" });
	app.vault.calls.length = 0;
	const out = Object.assign(base, {
		leaves,
		getLeaf,
		openLinkText,
		defaultApp: internals.defaultAppOpens,
		registry: internals.viewRegistry.typeByExtension,
		opened: () => [...order],
	});
	rig = out;
	return out;
}

const KEY = (path: string) => unitRefKey({ kind: "file", path });
const FOLDER_KEY = (path: string) => unitRefKey({ kind: "folder", path });
const labelOf = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-row-text")!;
const row = (r: Rig, path: string) => rowByKey(r.h, KEY(path));
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const aux = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true, ...init }));
const clickPath = async (r: Rig, path: string) => {
	labelOf(row(r, path)).click();
	await settle();
};
const openRefOf = (r: Rig, ref: UnitRef, newTab = false) => (r.h.explorer as unknown as { openRef: (ref: UnitRef, newTab: boolean) => Promise<void> }).openRef(ref, newTab);

function menuOf(el: HTMLElement): Menu {
	let built: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	return built!;
}
const choose = (menu: Menu, title: string) => menu.items.find((item) => item.title === title)!.clickHandler!();

/** Opens Module Contents for a source folder the way a long-press does, and returns the modal's row for `name`. */
function moduleRow(r: Rig, folderPath: string, name: string): HTMLElement {
	rowByKey(r.h, FOLDER_KEY(folderPath)).querySelector<HTMLElement>(".atlas-module-icon")!.click();
	const found = [...document.querySelectorAll<HTMLElement>(".modal .atlas-row-internal")].find((el) => el.querySelector(".atlas-row-text")?.textContent === name);
	expect(found, `${name} in Module Contents of ${folderPath}`).toBeTruthy();
	return found!;
}

describe("G7 plain click: a source row opens the vault file it is under Sources/", () => {
	it("GP3: clicking Workout Plan in [whoop] opens Sources/whoop/Workout Plan.md in the current tab, not the same-named note at the vault root", async () => {
		const r = await makeRig();
		await clickPath(r, "Sources/whoop/Workout Plan.md");
		expect(r.getLeaf).toHaveBeenCalledExactlyOnceWith(false);
		expect(r.opened()).toEqual(["Sources/whoop/Workout Plan.md"]);
		expect(r.leaves[0].opened!.basename).toBe("Workout Plan"); // the tab title
		expect(r.defaultApp).toEqual([]);
		expect(r.openLinkText).not.toHaveBeenCalled();
	});

	it("notes, PDFs (any case) and registered code open in Obsidian; the Workbench types open there too", async () => {
		const r = await makeRig();
		await clickPath(r, "Sources/whoop/Report.PDF");
		await clickPath(r, "Sources/tephra/Cargo.toml");
		expect(r.opened()).toEqual(["Sources/whoop/Report.PDF", "Sources/tephra/Cargo.toml"]);
		expect(r.defaultApp).toEqual([]);
	});

	it("a type with no registered view goes to the default app once per click, and Atlas opens no leaf for it", async () => {
		const r = await makeRig();
		for (const path of ["Sources/whoop/Archive.zip", "Sources/whoop/Notes.gdoc", "Sources/tephra/Makefile"]) {
			r.defaultApp.length = 0;
			await clickPath(r, path);
			expect(r.defaultApp, path).toEqual([path]);
		}
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.leaves.every((l) => l.openFile.mock.calls.length === 0)).toBe(true);
	});

	it("unregistering a code type sends it to the default app instead (the rule reads the live registry)", async () => {
		const r = await makeRig();
		delete r.registry.toml;
		await clickPath(r, "Sources/tephra/Cargo.toml");
		expect(r.defaultApp).toEqual(["Sources/tephra/Cargo.toml"]);
		expect(r.getLeaf).not.toHaveBeenCalled();
	});

	it("a file with no extension uses the default app unless a view is registered for it", async () => {
		const r = await makeRig();
		await clickPath(r, "Sources/tephra/Makefile");
		expect(r.defaultApp).toEqual(["Sources/tephra/Makefile"]);
		r.defaultApp.length = 0;
		r.registry[""] = "workbench";
		await clickPath(r, "Sources/tephra/Makefile");
		expect(r.defaultApp).toEqual([]);
		expect(r.opened()).toEqual(["Sources/tephra/Makefile"]);
	});

	it("names with spaces, unicode and emoji open the exact file", async () => {
		const r = await makeRig();
		for (const path of ["Sources/whoop/Leg Day.md", "Sources/whoop/Café — plan.md", "Sources/whoop/Leg Day 🏋️.md"]) await clickPath(r, path);
		// All three went through the one current leaf, in click order.
		expect(r.leaves[0].openFile.mock.calls.map((c) => (c[0] as TFile).path)).toEqual(["Sources/whoop/Leg Day.md", "Sources/whoop/Café — plan.md", "Sources/whoop/Leg Day 🏋️.md"]);
	});

	it("two sources with a README.md: each section's row opens its own source's file (the vault's too), by exact path", async () => {
		const r = await makeRig();
		await clickPath(r, "Sources/tephra/README.md");
		await clickPath(r, "Sources/whoop/README.md");
		await clickPath(r, "README.md");
		expect(r.leaves[0].openFile.mock.calls.map((c) => (c[0] as TFile).path)).toEqual(["Sources/tephra/README.md", "Sources/whoop/README.md", "README.md"]);
	});

	it("a rapid double-click opens one tab: both clicks take the current leaf", async () => {
		const r = await makeRig();
		labelOf(row(r, "Sources/whoop/Workout Plan.md")).click();
		labelOf(row(r, "Sources/whoop/Workout Plan.md")).click();
		await settle();
		expect(r.getLeaf.mock.calls).toEqual([[false], [false]]);
		expect(r.leaves).toHaveLength(1);
		expect(r.leaves[0].openFile).toHaveBeenCalledTimes(2);
	});
});

describe("G7 middle-click and the Open menu items", () => {
	it("middle-click on README.md in [tephra] opens a new tab; the current tab is untouched", async () => {
		const r = await makeRig();
		aux(labelOf(row(r, "Sources/tephra/README.md")));
		await settle();
		expect(r.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		expect(r.opened()).toEqual(["Sources/tephra/README.md"]);
		expect(r.leaves[0].openFile).not.toHaveBeenCalled();
	});

	it("middle-click follows the same rules as for vault rows: a modifier, or a control inside the row, does nothing", async () => {
		const r = await makeRig();
		const el = row(r, "Sources/tephra/README.md");
		aux(labelOf(el), { shiftKey: true });
		aux(labelOf(el), { ctrlKey: true });
		aux(labelOf(el), { metaKey: true });
		aux(labelOf(el), { altKey: true });
		const badge = el.appendChild(document.createElement("span"));
		badge.className = "atlas-badge";
		aux(badge);
		await settle();
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.defaultApp).toEqual([]);
	});

	it("middle-click on a type with no Obsidian view uses the default app, not a new tab", async () => {
		const r = await makeRig();
		aux(labelOf(row(r, "Sources/whoop/Plan.docx")));
		await settle();
		expect(r.defaultApp).toEqual(["Sources/whoop/Plan.docx"]);
		expect(r.getLeaf).not.toHaveBeenCalled();
	});

	it("the row's \"Open\" and \"Open in new tab\" items", async () => {
		const r = await makeRig();
		const menu = menuOf(row(r, "Sources/tephra/README.md"));
		expect(menu.titles()).toEqual(expect.arrayContaining(["Open", "Open in new tab"]));
		choose(menu, "Open");
		await settle();
		expect(r.getLeaf).toHaveBeenLastCalledWith(false);
		choose(menu, "Open in new tab");
		await settle();
		expect(r.getLeaf).toHaveBeenLastCalledWith(true);
		expect(r.leaves.flatMap((l) => l.openFile.mock.calls.map((c) => (c[0] as TFile).path))).toEqual(["Sources/tephra/README.md", "Sources/tephra/README.md"]);

		const docMenu = menuOf(row(r, "Sources/whoop/Plan.docx"));
		choose(docMenu, "Open in new tab");
		await settle();
		expect(r.defaultApp).toEqual(["Sources/whoop/Plan.docx"]);
		expect(r.getLeaf).toHaveBeenCalledTimes(2);
	});

	it("the same Open items on a placed (bucket) source row", async () => {
		const r = await makeRig();
		const dest = r.h.panel().querySelector<HTMLElement>(".atlas-bucket .atlas-meta-children-inner")!;
		const source = row(r, "Sources/whoop/Workout Plan.md");
		source.dispatchEvent(new Event("dragstart", { bubbles: true }));
		dest.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
		await r.settle();
		const placed = [...r.h.panel().querySelectorAll<HTMLElement>(".atlas-bucket .atlas-row")][0];
		labelOf(placed).click();
		await settle();
		expect(r.opened()).toEqual(["Sources/whoop/Workout Plan.md"]);
		aux(labelOf(placed));
		await settle();
		expect(r.getLeaf).toHaveBeenLastCalledWith(true);
	});
});

describe("G7 Module Contents opens its files through the same rule", () => {
	it("a code file registered by Workbench opens in Obsidian; build.sh (no view) uses the default app; a note opens in Obsidian", async () => {
		const r = await makeRig();
		moduleRow(r, "Sources/tephra/crates", "registry.rs").click();
		expect(r.opened()).toEqual(["Sources/tephra/crates/tephrad/src/registry.rs"]);
		document.querySelectorAll(".modal-container").forEach((el) => el.remove());

		moduleRow(r, "Sources/tephra/scripts", "build.sh").click();
		await settle();
		expect(r.defaultApp).toEqual(["Sources/tephra/scripts/build.sh"]);

		document.querySelectorAll(".modal-container").forEach((el) => el.remove());
		moduleRow(r, "Sources/tephra/docs", "guide.md").click();
		await settle();
		expect(r.opened()).toEqual(["Sources/tephra/crates/tephrad/src/registry.rs", "Sources/tephra/docs/guide.md"]);
	});

	it("a deep path (crates/tephrad/src/registry.rs) opens by its exact vault path", async () => {
		const r = await makeRig();
		await openRefOf(r, { kind: "file", path: "Sources/tephra/crates/tephrad/src/registry.rs" });
		expect(r.opened()).toEqual(["Sources/tephra/crates/tephrad/src/registry.rs"]);
	});

	it("a folder row with no interface note opens nothing and creates no <Folder>/<Folder>.md", async () => {
		const r = await makeRig();
		labelOf(rowByKey(r.h, FOLDER_KEY("Sources/tephra/crates"))).click();
		aux(labelOf(rowByKey(r.h, FOLDER_KEY("Sources/tephra/crates"))));
		await openRefOf(r, { kind: "folder", path: "Sources/tephra/crates" });
		await settle();
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.defaultApp).toEqual([]);
		expect(r.app.vault.getAbstractFileByPath("Sources/tephra/crates/crates.md")).toBeNull();
		expect(r.app.vault.calls).toEqual([]);
	});

	it("a source folder that has an interface note opens that note", async () => {
		const r = await makeRig({ vaultPaths: [...PATHS, "Sources/tephra/docs/docs.md"] });
		await openRefOf(r, { kind: "folder", path: "Sources/tephra/docs" });
		expect(r.opened()).toEqual(["Sources/tephra/docs/docs.md"]);
	});
});

describe("G7 block refs", () => {
	const BLOCK: UnitRef = { kind: "block", path: "Sources/whoop/Workout Plan.md", subpath: "^k3f9a2" };

	it("a block inside a source note opens that exact TFile with the subpath as view state, never through openLinkText (Obsidian can't resolve a path through a Sources/ folder link and would create a note)", async () => {
		const r = await makeRig();
		await openRefOf(r, BLOCK);
		expect(r.openLinkText).not.toHaveBeenCalled();
		expect(r.getLeaf).toHaveBeenCalledExactlyOnceWith(false);
		expect(r.leaves[0].openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "Sources/whoop/Workout Plan.md" }), { eState: { subpath: "#^k3f9a2" } });
		await openRefOf(r, BLOCK, true);
		expect(r.getLeaf).toHaveBeenLastCalledWith(true);
		expect(r.leaves[1].openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "Sources/whoop/Workout Plan.md" }), { eState: { subpath: "#^k3f9a2" } });
		expect(r.openLinkText).not.toHaveBeenCalled();
		expect(r.app.vault.calls).toEqual([]); // nothing created, nothing written
	});

	it("a block in a source note that is not in the vault opens nothing and creates nothing", async () => {
		const r = await makeRig();
		await openRefOf(r, { kind: "block", path: "Sources/whoop/Gone.md", subpath: "^a" });
		expect(r.openLinkText).not.toHaveBeenCalled();
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.app.vault.calls).toEqual([]);
	});

	it("a failing open does not throw and creates nothing", async () => {
		const r = await makeRig();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		r.leaves[0].openFile.mockRejectedValueOnce(new Error("EACCES"));
		await expect(openRefOf(r, BLOCK)).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledTimes(1);
		expect(r.app.vault.calls).toEqual([]);
	});

	it("a block outside Sources/ still opens by openLinkText as before", async () => {
		const r = await makeRig();
		await openRefOf(r, { kind: "block", path: "README.md", subpath: "^z" }, true);
		expect(r.openLinkText).toHaveBeenCalledExactlyOnceWith("README.md#^z", "", true);
		expect(r.getLeaf).not.toHaveBeenCalled();
	});

	it("with the toggle off a block ref takes today's openLinkText path, Sources/ path included (G16)", async () => {
		const r = await makeRig({ settings: { tephraEnabled: false } });
		await openRefOf(r, BLOCK);
		expect(r.openLinkText).toHaveBeenCalledExactlyOnceWith("Sources/whoop/Workout Plan.md#^k3f9a2", "", false);
		expect(r.getLeaf).not.toHaveBeenCalled();
	});
});

describe("F8: Office, Google and PDF files", () => {
	const OFFICE = ["docx", "pptx", "xlsx", "gdoc", "gsheet"];

	it.each(OFFICE)(".%s goes to the default app and no tab holds it, even when a plugin registered a view for it", async (ext) => {
		const path = `Sources/whoop/Brief.${ext}`;
		const r = await makeRig({ vaultPaths: [...PATHS, path] });
		r.registry[ext] = "some-markdown-editor";
		r.registry[ext.toUpperCase()] = "some-markdown-editor";
		await clickPath(r, path);
		aux(labelOf(row(r, path)));
		await settle();
		expect(r.defaultApp).toEqual([path, path]);
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.opened()).toEqual([]);
	});

	it(".pdf opens in Obsidian's own view (a leaf), never the default app", async () => {
		const r = await makeRig();
		await clickPath(r, "Sources/whoop/Report.PDF");
		expect(r.opened()).toEqual(["Sources/whoop/Report.PDF"]);
		expect(r.defaultApp).toEqual([]);
	});
});

describe("G16: toggle off", () => {
	it("no source rows exist, and openRef takes today's path (getLeaf(newTab).openFile) for every TFile, a docx under Sources/ included", async () => {
		const r = await makeRig({ settings: { tephraEnabled: false } });
		expect(r.h.panel().querySelector(".atlas-inbox-source")).toBeNull();
		await openRefOf(r, { kind: "file", path: "Sources/whoop/Plan.docx" });
		await openRefOf(r, { kind: "file", path: "Sources/tephra/Cargo.toml" }, true);
		await openRefOf(r, { kind: "file", path: "Sources/whoop/Workout Plan.md" });
		expect(r.getLeaf.mock.calls).toEqual([[false], [true], [false]]);
		expect(r.opened()).toEqual(["Sources/whoop/Plan.docx", "Sources/tephra/Cargo.toml", "Sources/whoop/Workout Plan.md"]);
		expect(r.defaultApp).toEqual([]);
	});

	it("a vault row still opens as before", async () => {
		const r = await makeRig({ settings: { tephraEnabled: false } });
		const el = r.h.panel().querySelector<HTMLElement>(`[data-select-key="${KEY("README.md")}"]`)!;
		labelOf(el).click();
		await settle();
		expect(r.opened()).toEqual(["README.md"]);
		expect(r.defaultApp).toEqual([]);
	});

	it("with the toggle on, a vault file outside Sources/ is unchanged: it still goes to getLeaf(newTab).openFile", async () => {
		const r = await makeRig();
		await openRefOf(r, { kind: "file", path: "README.md" }, true);
		expect(r.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
		expect(r.opened()).toEqual(["README.md"]);
	});
});

describe("E5: a missing source", () => {
	it("the section shows (missing); with its files gone from the vault, refTargetExists is false and click, middle-click and openRef do nothing and create nothing", async () => {
		const paths = PATHS.filter((p) => !p.startsWith("Sources/whoop/"));
		const r = await makeRig({
			vaultPaths: paths,
			sources: [
				{ name: "tephra", path: "/home/user/Developer/Tephra", status: "online" },
				{ name: "whoop", path: "/home/user/Documents/Whoop", status: "missing" },
			],
		});
		const header = sectionEl(r.h, "whoop").querySelector<HTMLElement>(".atlas-section-header")!;
		expect(header.textContent).toContain("(missing)");
		const ref: UnitRef = { kind: "file", path: "Sources/whoop/Workout Plan.md" };
		expect(refTargetExists(r.app, r.settings, ref)).toBe(false);
		header.click();
		aux(header);
		await openRefOf(r, ref);
		await openRefOf(r, ref, true);
		await openRefOf(r, { kind: "block", path: ref.path, subpath: "^x" }).catch(() => {});
		await settle();
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.defaultApp).toEqual([]);
		expect(r.app.vault.calls).toEqual([]);
		expect(r.app.vault.getAbstractFileByPath(ref.path)).toBeNull();
	});
});

describe("a row whose file was deleted after render", () => {
	it("a click and a middle-click on the stale row do nothing and throw nothing", async () => {
		const r = await makeRig();
		const el = row(r, "Sources/whoop/Workout Plan.md");
		await r.app.vault.delete(r.app.vault.getAbstractFileByPath("Sources/whoop/Workout Plan.md")!);
		r.app.vault.calls.length = 0;
		expect(() => {
			labelOf(el).click();
			aux(labelOf(el));
		}).not.toThrow();
		await settle();
		expect(r.getLeaf).not.toHaveBeenCalled();
		expect(r.defaultApp).toEqual([]);
		expect(r.app.vault.calls).toEqual([]);
		expect(Notice.instances).toEqual([]);
	});
});

describe("a failed open (an unreadable symlink target)", () => {
	it("is logged by Atlas, shows nothing of ours, and nothing is thrown out of the click handler", async () => {
		const r = await makeRig();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		r.leaves[0].openFile.mockRejectedValue(new Error("EACCES: permission denied"));
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			expect(() => labelOf(row(r, "Sources/whoop/Workout Plan.md")).click()).not.toThrow();
			await settle();
			await settle();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
		expect(unhandled).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0][0])).toContain("Sources/whoop/Workout Plan.md");
	});

	it("the same for the default app opener", async () => {
		const r = await makeRig();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		(r.app as unknown as { openWithDefaultApp: unknown }).openWithDefaultApp = vi.fn(async () => {
			throw new Error("EACCES");
		});
		expect(() => labelOf(row(r, "Sources/whoop/Plan.docx")).click()).not.toThrow();
		await settle();
		await settle();
		expect(error).toHaveBeenCalledTimes(1);
	});
});

describe("E1 / G13: Tephra offline or not asked", () => {
	it("openRef makes no Tephra call, for every kind of open", async () => {
		const r = await makeRig();
		const before = r.daemon.requests.length;
		await openRefOf(r, { kind: "file", path: "Sources/whoop/Workout Plan.md" });
		await openRefOf(r, { kind: "file", path: "Sources/whoop/Plan.docx" });
		await openRefOf(r, { kind: "file", path: "Sources/tephra/Cargo.toml" }, true);
		await openRefOf(r, { kind: "folder", path: "Sources/tephra/crates" });
		await openRefOf(r, { kind: "block", path: "Sources/whoop/Workout Plan.md", subpath: "^a" });
		await settle();
		expect(r.daemon.requests.length).toBe(before);
	});

	it("a click, a middle-click and the menu items add no Tephra call beyond the Inbox's own read-only listing", async () => {
		const r = await makeRig();
		const before = r.daemon.requests.length;
		await clickPath(r, "Sources/whoop/Workout Plan.md");
		await clickPath(r, "Sources/whoop/Plan.docx");
		aux(labelOf(row(r, "Sources/tephra/README.md")));
		choose(menuOf(row(r, "Sources/tephra/README.md")), "Open in new tab");
		await settle();
		expect(r.opened()).toEqual(["Sources/whoop/Workout Plan.md", "Sources/tephra/README.md", "Sources/tephra/README.md"]);
		expect([...new Set(r.daemon.requests.slice(before).map((q) => q.method))].filter((m) => m !== "unit.list")).toEqual([]);
	});

	it("with the daemon reporting every source offline (listing from cache), a local Sources/ file still opens", async () => {
		const r = await makeRig();
		r.daemon.units = { tephra: { entries: [], offline: true }, whoop: { entries: [], offline: true } };
		await r.check();
		const before = r.daemon.requests.length;
		await openRefOf(r, { kind: "file", path: "Sources/whoop/Workout Plan.md" });
		expect(r.opened()).toEqual(["Sources/whoop/Workout Plan.md"]);
		expect(r.daemon.requests.length).toBe(before);
	});
});

describe("F2 / F3: opening is read-only and stays in the vault", () => {
	it("no write API is called by any open, and no TFile is made by Atlas", async () => {
		const r = await makeRig();
		const spies = {
			modify: vi.spyOn(r.app.vault, "modify"),
			process: vi.fn(),
			processFrontMatter: vi.fn(),
			create: vi.spyOn(r.app.vault, "create"),
			rename: vi.spyOn(r.app.vault, "rename"),
			del: vi.spyOn(r.app.vault, "delete"),
		};
		(r.app.vault as unknown as { process: unknown }).process = spies.process;
		(r.app.fileManager as unknown as { processFrontMatter: unknown }).processFrontMatter = spies.processFrontMatter;
		const filesBefore = r.app.vault.getAllLoadedFiles();

		await clickPath(r, "Sources/whoop/Workout Plan.md");
		await clickPath(r, "Sources/whoop/Plan.docx");
		aux(labelOf(row(r, "Sources/tephra/README.md")));
		await openRefOf(r, { kind: "file", path: "Sources/tephra/crates/tephrad/src/registry.rs" });
		await openRefOf(r, { kind: "file", path: "Sources/nosuch/ghost.md" });
		moduleRow(r, "Sources/tephra/docs", "guide.md").click();
		await settle();

		for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
		expect(r.app.vault.calls).toEqual([]);
		// Every file handed to Obsidian is an entry the vault already had.
		for (const leaf of r.leaves) for (const call of leaf.openFile.mock.calls) expect(filesBefore).toContain(call[0]);
	});
});

describe("GP3 on a real disk: edits go through the Sources/ symlink and nothing else changes", () => {
	it("opening a file under a real symlinked Sources/whoop leaves the link a symlink, the file's mtime and content untouched, and no copy anywhere", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atlas-source-open-"));
		try {
			const target = join(dir, "Documents", "Whoop");
			const vaultDir = join(dir, "vault");
			mkdirSync(target, { recursive: true });
			mkdirSync(join(vaultDir, "Sources"), { recursive: true });
			writeFileSync(join(target, "Workout Plan.md"), "# Workout Plan\n");
			writeFileSync(join(target, "Plan.docx"), "docx");
			const stamp = new Date("2026-01-02T03:04:05Z");
			utimesSync(join(target, "Workout Plan.md"), stamp, stamp);
			symlinkSync(target, join(vaultDir, "Sources", "whoop"), "dir");
			const mtimeBefore = statSync(join(target, "Workout Plan.md")).mtimeMs;

			// The vault index Obsidian would build by walking the linked folder.
			const walked = readdirSync(join(vaultDir, "Sources", "whoop")).map((name) => `Sources/whoop/${name}`);
			expect(walked.sort()).toEqual(["Sources/whoop/Plan.docx", "Sources/whoop/Workout Plan.md"]);
			const r = await makeRig({ vaultPaths: walked, sources: [{ name: "whoop", path: target, status: "online" }] });

			await clickPath(r, "Sources/whoop/Workout Plan.md");
			await clickPath(r, "Sources/whoop/Plan.docx");
			expect(r.opened()).toEqual(["Sources/whoop/Workout Plan.md"]);
			expect(r.defaultApp).toEqual(["Sources/whoop/Plan.docx"]);

			expect(lstatSync(join(vaultDir, "Sources", "whoop")).isSymbolicLink()).toBe(true);
			expect(statSync(join(target, "Workout Plan.md")).mtimeMs).toBe(mtimeBefore);
			expect(readFileSync(join(target, "Workout Plan.md"), "utf8")).toBe("# Workout Plan\n");
			expect(readdirSync(vaultDir)).toEqual(["Sources"]);
			expect(readdirSync(join(vaultDir, "Sources"))).toEqual(["whoop"]);
			expect(readdirSync(target).sort()).toEqual(["Plan.docx", "Workout Plan.md"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
