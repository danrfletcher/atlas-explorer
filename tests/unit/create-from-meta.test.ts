import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Menu, Notice } from "obsidian";
import {
	CREATE_ITEM_TITLE,
	CREATE_KINDS,
	CreateKind,
	addCreateItem,
	blockPath,
	buildBlockContent,
	createDialogTitle,
	filePath,
	freeBlockPath,
	modulePaths,
	startCreateFromMeta,
	usablePoolFolder,
} from "../../src/create-from-meta";
import { generateBlockId, getFreeBlockDisplayTextFromContent } from "../../src/display-text";
import { AtlasExplorerView } from "../../src/explorer-view";
import { View, ViewNode } from "../../src/types";
import { button, flush, inputEl, key, modals, type } from "../helpers";
import { file, meta, setup, tMany, unit } from "../integration/create-from-meta-fixtures";

const notices = () => Notice.instances.map((n) => n.message);
const messageText = () => document.querySelector(".atlas-name-message")!.textContent;
const isRed = () => inputEl().classList.contains("atlas-name-invalid");
const isGreen = () => inputEl().classList.contains("atlas-name-valid");

beforeEach(() => {
	Notice.reset();
	Menu.shownAtPosition = [];
});

afterEach(async () => {
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
});

describe("UT-8 builders", () => {
	it("block content is `# name` plus one newline, trimmed, inner text kept", () => {
		expect(buildBlockContent("Field tech")).toBe("# Field tech\n");
		expect(buildBlockContent("  Field  tech  ")).toBe("# Field  tech\n");
		expect(buildBlockContent("Q3: plans / ideas")).toBe("# Q3: plans / ideas\n");
	});

	it("paths: file at the root, module folder with a same-named note, block in the pool", () => {
		expect(filePath("Field tech")).toBe("Field tech.md");
		expect(filePath("  Field tech ")).toBe("Field tech.md");
		expect(modulePaths("Field tech")).toEqual({ folder: "Field tech", note: "Field tech/Field tech.md" });
		expect(blockPath("_pool", new Date(2026, 8, 25, 14, 30, 12), () => 0)).toBe("_pool/20260925143012-0000.md");
		expect(blockPath("_pool", new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^_pool\/20260102030405-[0-9a-z]{4}\.md$/);
	});

	it("usablePoolFolder trims slashes and refuses empty or the vault root", () => {
		expect(usablePoolFolder("_pool")).toBe("_pool");
		expect(usablePoolFolder("_pool/")).toBe("_pool");
		expect(usablePoolFolder("Deep/Pool//")).toBe("Deep/Pool");
		for (const bad of ["", " ", "/", ".", "  ./ "]) expect(usablePoolFolder(bad), bad).toBeNull();
	});
});

describe("UT-9 ID collision loop", () => {
	it("skips occupied IDs, never returns an existing path, gives up after 100 attempts", () => {
		const s = setup(tMany());
		const now = new Date(2026, 8, 25, 14, 30, 12);
		s.app.vault.seedFile("_pool/20260925143012-0000.md");
		s.app.vault.seedFile("_pool/20260925143012-1111.md");
		const values = [0, 0, 0, 0, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 2 / 36, 2 / 36, 2 / 36, 2 / 36];
		let i = 0;
		expect(freeBlockPath(s.app.vault, "_pool", now, () => values[i++])).toBe("_pool/20260925143012-2222.md");
		expect(freeBlockPath(s.app.vault, "_pool", now, () => 0)).toBeNull();
	});
});

describe("UT-10 display text of the new block", () => {
	it("the first line `# name` is what the inbox and the tree show", () => {
		expect(getFreeBlockDisplayTextFromContent(buildBlockContent("Field tech"), 80)).toBe("Field tech");
		expect(getFreeBlockDisplayTextFromContent(buildBlockContent("Q3: plans / ideas"), 80)).toBe("Q3: plans / ideas");
	});

	it("generateBlockId is unchanged by the injectable random", () => {
		expect(generateBlockId(new Date(2026, 8, 25, 14, 30, 12), () => 0.5)).toBe("20260925143012-iiii");
	});
});

describe("UT-11 the menu builders", () => {
	it("Create is one item titled `Create`, and its chooser lists Block, File, Module in that order", () => {
		const menu = new Menu();
		const chosen: CreateKind[] = [];
		addCreateItem(menu, { clientX: 12, clientY: 34 }, (k) => chosen.push(k));
		expect(menu.titles()).toEqual([CREATE_ITEM_TITLE]);
		expect(CREATE_ITEM_TITLE).toBe("Create");
		expect(Menu.shownAtPosition).toEqual([]);
		menu.items[0].clickHandler!();
		expect(Menu.shownAtPosition).toHaveLength(1);
		const chooser = Menu.shownAtPosition[0];
		expect(chooser.titles()).toEqual(["Block", "File", "Module"]);
		expect(chooser.titles()).toEqual(CREATE_KINDS.map((k) => k.label));
		chooser.items.forEach((item) => item.clickHandler!());
		expect(chosen).toEqual(["block", "file", "module"]);
	});

	it("the chooser opens at the click position", () => {
		const menu = new Menu();
		const spy = vi.spyOn(Menu.prototype, "showAtPosition");
		addCreateItem(menu, { clientX: 12, clientY: 34 }, () => {});
		menu.items[0].clickHandler!();
		expect(spy).toHaveBeenCalledWith({ x: 12, y: 34 });
		spy.mockRestore();
	});

	const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

	function metaMenu(node: ViewNode) {
		const fake = { plugin: {}, startCreateFromMeta: vi.fn(), openStatusesModal: vi.fn() };
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(fake, new MouseEvent("contextmenu"), node, view);
		show.mockRestore();
		return { menu: built!, fake };
	}

	it("a meta folder's menu gains Create between Rename and the rest, in the old order otherwise", () => {
		const empty = metaMenu(meta("m", "Empty"));
		expect(empty.menu.titles()).toEqual(["Duplicate (Meta)", "Rename folder", "Create", "Swap with…", "Data source…", "Delete folder"]);
		const full = metaMenu(meta("m", "Full", [unit("u", file("Existing.md"))]));
		expect(full.menu.titles()).toEqual(["Duplicate (Meta)", "Rename folder", "Create", "Swap with…", "Statuses", "Data source…", "Delete folder"]);
	});

	it("choosing Block, File or Module in the chooser starts that flow for this folder", () => {
		const node = meta("m", "Empty");
		const { menu, fake } = metaMenu(node);
		menu.items[2].clickHandler!();
		const chooser = Menu.shownAtPosition[0];
		chooser.items[1].clickHandler!();
		expect(fake.startCreateFromMeta).toHaveBeenCalledWith("file", view, node);
	});

	it("unit rows offer no Create at all", () => {
		const fake = {
			plugin: { app: new App(), unitIndex: { getUnits: () => [{ type: "root-file", path: "Existing.md" }] } },
			startCreateModule: vi.fn(),
			openRef: vi.fn(),
			revealInNativeExplorer: vi.fn(),
			openModuleContentsModal: vi.fn(),
			copyLink: vi.fn(),
			openStatusesModal: vi.fn(),
			placeInViewFlow: vi.fn(),
		};
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const ref = { kind: "file" as const, path: "Existing.md" };
		(AtlasExplorerView.prototype as unknown as { showUnitMenu: (...a: unknown[]) => void }).showUnitMenu.call(fake, new MouseEvent("contextmenu"), ref, view, unit("u", ref));
		show.mockRestore();
		expect(built!.titles()).not.toContain("Create");
	});
});

describe("the name dialog for Create", () => {
	const FLOW = (s: ReturnType<typeof setup>) => s.deps;

	it("titles are Create Block / Create File / Create Module, prefilled with the meta label", async () => {
		for (const [kind, title] of [["block", "Create Block"], ["file", "Create File"], ["module", "Create Module"]] as const) {
			const s = setup(tMany());
			expect(createDialogTitle(kind)).toBe(title);
			const done = startCreateFromMeta(FLOW(s), kind, "default", "ft");
			expect(document.querySelector(".modal-title")!.textContent).toBe(title);
			expect(inputEl().value).toBe("Field tech");
			expect(isGreen()).toBe(true);
			expect(button("Create").disabled).toBe(false);
			key("Escape");
			await done;
			document.body.innerHTML = "";
		}
	});

	it("File and Module go red on a root clash with the exact message; Block stays green for the same name", async () => {
		for (const kind of ["file", "module"] as const) {
			const s = setup(tMany());
			const done = startCreateFromMeta(FLOW(s), kind, "default", "ft");
			type("existing");
			expect(isRed()).toBe(true);
			expect(messageText()).toBe("A note or folder called 'existing' already exists at the vault root");
			expect(button("Create").disabled).toBe(true);
			key("Enter");
			expect(modals()).toHaveLength(1);
			key("Escape");
			await done;
			document.body.innerHTML = "";
		}
		const s = setup(tMany());
		const done = startCreateFromMeta(FLOW(s), "block", "default", "ft");
		type("existing");
		expect(isGreen()).toBe(true);
		type("A: b / c");
		expect(isGreen()).toBe(true);
		type("   ");
		expect(isRed()).toBe(true);
		expect(button("Create").disabled).toBe(true);
		key("Escape");
		await done;
	});

	it("File and Module also refuse file-illegal characters and reserved names; Block takes them", async () => {
		for (const bad of ["a/b", "a:b", "a#b", "a[b]", ".hidden", "trailing."]) {
			const s = setup(tMany());
			const done = startCreateFromMeta(FLOW(s), "file", "default", "ft");
			type(bad);
			expect(isRed(), bad).toBe(true);
			key("Escape");
			await done;
			document.body.innerHTML = "";
			const t = setup(tMany());
			const doneBlock = startCreateFromMeta(FLOW(t), "block", "default", "ft");
			type(bad);
			expect(isGreen(), bad).toBe(true);
			key("Escape");
			await doneBlock;
			document.body.innerHTML = "";
		}
	});

	it("Cancel and Escape change nothing: no disk write, no notice, meta node intact", async () => {
		const s = setup(tMany());
		const before = s.listing();
		const tree = JSON.stringify(s.views.getViews());
		for (const kind of ["block", "file", "module"] as const) {
			for (const dismiss of [() => button("Cancel").click(), () => key("Escape")]) {
				const done = startCreateFromMeta(FLOW(s), kind, "default", "ft");
				dismiss();
				await done;
				await flush();
			}
		}
		expect(s.listing()).toEqual(before);
		expect(JSON.stringify(s.views.getViews())).toBe(tree);
		expect(notices()).toEqual([]);
		expect(s.persist).not.toHaveBeenCalled();
		expect(s.saved).toEqual([]);
	});

	it("Enter and the Create button both submit; rapid double submit creates one item", async () => {
		const s = setup(tMany());
		const create = vi.spyOn(s.app.vault, "create");
		const done = startCreateFromMeta(FLOW(s), "file", "default", "ft");
		type("Field ops");
		const input = inputEl();
		const btn = button("Create");
		key("Enter", {}, input);
		key("Enter", {}, input);
		btn.click();
		btn.click();
		await done;
		await flush();
		expect(create).toHaveBeenCalledTimes(1);
		expect(s.contentOf("Field ops.md")).toBe("# Field ops\n");
		expect(s.views.getNode("default", "ft")!.type).toBe("unit");
		expect(notices()).toEqual([]);
	});

	it("a second Create while one is open is ignored, on the same folder or another", async () => {
		const s = setup([meta("ft", "Field tech"), meta("other", "Other")]);
		const first = startCreateFromMeta(FLOW(s), "file", "default", "ft");
		const again = startCreateFromMeta(FLOW(s), "module", "default", "ft");
		const other = startCreateFromMeta(FLOW(s), "file", "default", "other");
		await Promise.all([again, other]);
		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);
		key("Escape");
		await first;
	});

	it("a clash that appears while the dialog is open is caught by the dialog on submit: it stays open, red, and nothing is written", async () => {
		const s = setup(tMany());
		const create = vi.spyOn(s.app.vault, "create");
		const done = startCreateFromMeta(FLOW(s), "file", "default", "ft");
		type("Fresh");
		expect(isGreen()).toBe(true);
		s.app.vault.seedFile("fresh.md");
		key("Enter");
		expect(modals()).toHaveLength(1);
		expect(isRed()).toBe(true);
		expect(messageText()).toBe("A note or folder called 'Fresh' already exists at the vault root");
		expect(create).not.toHaveBeenCalled();
		key("Escape");
		await done;
		expect(s.views.getNode("default", "ft")!.type).toBe("meta");
		expect(notices()).toEqual([]);
	});

	it("the folder is renamed while the dialog is open: the dialog keeps what was typed and the create still works", async () => {
		const s = setup(tMany());
		const done = startCreateFromMeta(FLOW(s), "file", "default", "ft");
		s.views.renameMetaFolder("default", "ft", "Renamed");
		expect(inputEl().value).toBe("Field tech");
		key("Enter");
		await done;
		expect(s.views.getNode("default", "ft")!.ref).toEqual(file("Field tech.md"));
	});

	it("the folder is deleted while the dialog is open: nothing is written and one notice says why", async () => {
		const s = setup(tMany());
		const before = s.listing();
		const done = startCreateFromMeta(FLOW(s), "module", "default", "ft");
		s.views.deleteMetaFolder("default", "ft");
		key("Enter");
		await done;
		expect(s.listing()).toEqual(before);
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Field tech": the folder no longer exists']);
	});

	it("a folder that is already gone or a unit row opens no dialog", async () => {
		const s = setup(tMany());
		await startCreateFromMeta(FLOW(s), "file", "default", "nope");
		await startCreateFromMeta(FLOW(s), "file", "default", "c-existing");
		expect(modals()).toHaveLength(0);
	});

	it("the same folder can be run again once the first run has finished", async () => {
		const s = setup(tMany());
		const first = startCreateFromMeta(FLOW(s), "file", "default", "ft");
		key("Escape");
		await first;
		const second = startCreateFromMeta(FLOW(s), "file", "default", "ft");
		expect(modals()).toHaveLength(1);
		key("Escape");
		await second;
	});

	it("a Block with an empty pool setting opens the dialog but fails cleanly with one notice", async () => {
		const s = setup(tMany());
		s.deps.getPoolFolder = () => "";
		const before = s.listing();
		const done = startCreateFromMeta(FLOW(s), "block", "default", "ft");
		key("Enter");
		await done;
		expect(s.listing()).toEqual(before);
		expect(notices()).toHaveLength(1);
		expect(s.views.getNode("default", "ft")!.type).toBe("meta");
	});
});

describe("FR: fence on wording and writes", () => {
	it("nothing the flow says contains 'promot'; existing content is never modified", async () => {
		const s = setup(tMany());
		const modify = vi.spyOn(s.app.vault, "modify");
		const process = vi.fn();
		(s.app.vault as unknown as Record<string, unknown>).process = process;
		const done = startCreateFromMeta(FLOW_DEPS(s), "file", "default", "ft");
		type("existing");
		const shown = [messageText(), document.querySelector(".modal-title")!.textContent, CREATE_ITEM_TITLE, ...CREATE_KINDS.map((k) => k.label)];
		key("Escape");
		await done;
		for (const text of shown) expect(String(text).toLowerCase()).not.toContain("promot");
		expect(modify).not.toHaveBeenCalled();
		expect(process).not.toHaveBeenCalled();
	});
});

const FLOW_DEPS = (s: ReturnType<typeof setup>) => s.deps;
