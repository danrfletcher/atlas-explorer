import { describe, expect, it, vi } from "vitest";
import { CORE_EXTENSIONS, DEFAULT_APP_ONLY_EXTENSIONS, chooseOpener, openSourceFile, registeredExtensions } from "../../src/source-open";
import { App } from "obsidian";
import type { TFile } from "obsidian";

/** G7 / F8: the pure opener rule. No Obsidian: `chooseOpener` takes a file-like and a set of extensions. */

const CORE = new Set(CORE_EXTENSIONS);
/** What VS Code Workbench registers, stubbed. */
const WORKBENCH = new Set([...CORE_EXTENSIONS, "rs", "ts", "toml"]);
const open = (ext: string, registered: ReadonlySet<string> = WORKBENCH) => chooseOpener({ extension: ext }, registered);

describe("chooseOpener: core types open in Obsidian", () => {
	it.each(["md", "canvas", "pdf", "png", "jpg", "svg", "mp3", "mp4"])(".%s -> obsidian", (ext) => {
		expect(open(ext, CORE)).toBe("obsidian");
	});
});

describe("chooseOpener: extensions another plugin registered", () => {
	it.each(["rs", "ts", "toml"])(".%s -> obsidian with the Workbench set, default app without it", (ext) => {
		expect(open(ext, WORKBENCH)).toBe("obsidian");
		expect(open(ext, CORE)).toBe("default-app");
	});
});

describe("chooseOpener: types with no registered view go to the default app", () => {
	it.each(["zip", "gdoc", "docx", "dmg", "sketch", "xyz"])(".%s -> default-app", (ext) => {
		expect(open(ext, CORE)).toBe("default-app");
		expect(open(ext, WORKBENCH)).toBe("default-app");
	});
});

describe("F8: Word, PowerPoint, Excel and Google Docs/Sheets are never edited in Obsidian", () => {
	it.each(["doc", "docx", "ppt", "pptx", "xls", "xlsx", "gdoc", "gsheet"])(".%s -> default-app", (ext) => {
		expect(DEFAULT_APP_ONLY_EXTENSIONS.has(ext)).toBe(true);
		expect(open(ext, CORE)).toBe("default-app");
	});

	it.each(["doc", "docx", "ppt", "pptx", "xls", "xlsx", "gdoc", "gsheet"])(".%s still goes to the default app when a plugin registered a view for it", (ext) => {
		expect(open(ext, new Set([...WORKBENCH, ext]))).toBe("default-app");
		expect(open(ext.toUpperCase(), new Set([...WORKBENCH, ext]))).toBe("default-app");
	});

	it(".pdf is opened by Obsidian's own PDF view, never by the default app or an editor, while it is registered", () => {
		expect(open("pdf", CORE)).toBe("obsidian");
		expect(DEFAULT_APP_ONLY_EXTENSIONS.has("pdf")).toBe(false);
	});

	it(".pdf with no registered view (it never happens in real Obsidian) goes to the default app, not an editor", () => {
		expect(open("pdf", new Set(["md"]))).toBe("default-app");
	});
});

describe("chooseOpener: case and missing extensions", () => {
	it("is case-insensitive: .PDF = .pdf, .MD = .md, .RS = .rs", () => {
		expect(open("PDF", CORE)).toBe("obsidian");
		expect(open("Md", CORE)).toBe("obsidian");
		expect(open("RS", WORKBENCH)).toBe("obsidian");
		expect(open("RS", CORE)).toBe("default-app");
		expect(open("DOCX", CORE)).toBe("default-app");
	});

	it("a file with no extension (Makefile, LICENSE) uses a registered view for '' if there is one, else the default app", () => {
		expect(open("", CORE)).toBe("default-app");
		expect(open("", WORKBENCH)).toBe("default-app");
		expect(open("", new Set([...WORKBENCH, ""]))).toBe("obsidian");
	});
});

type RegistryApp = { viewRegistry?: { typeByExtension?: unknown } };

describe("registeredExtensions: the live registry when it can be read, the core list only when it can't", () => {
	it("is the registry's keys, lower-cased, including what a plugin registered", () => {
		const app = new App();
		const registry = (app as unknown as { viewRegistry: { typeByExtension: Record<string, string> } }).viewRegistry;
		registry.typeByExtension.RS = "workbench";
		registry.typeByExtension.toml = "workbench";
		const set = registeredExtensions(app);
		expect(set.has("rs")).toBe(true);
		expect(set.has("toml")).toBe(true);
		for (const ext of ["md", "canvas", "pdf", "png"]) expect(set.has(ext), ext).toBe(true);
		expect(set.has("zip")).toBe(false);
	});

	it("R1: a readable registry with no canvas or base entry (core plugin off) sends those files to the default app", () => {
		const app = new App() as unknown as RegistryApp;
		app.viewRegistry = { typeByExtension: { md: "markdown", pdf: "pdf", png: "image" } };
		const set = registeredExtensions(app as App);
		expect(set.has("canvas")).toBe(false);
		expect(set.has("base")).toBe(false);
		expect(chooseOpener({ extension: "canvas" }, set)).toBe("default-app");
		expect(chooseOpener({ extension: "base" }, set)).toBe("default-app");
		expect(chooseOpener({ extension: "md" }, set)).toBe("obsidian");
	});

	it("R1: with the registry readable, a core extension absent from it is not topped up from the core list (pdf too)", () => {
		const app = new App() as unknown as RegistryApp;
		app.viewRegistry = { typeByExtension: { md: "markdown" } };
		const set = registeredExtensions(app as App);
		expect([...set]).toEqual(["md"]);
		expect(chooseOpener({ extension: "pdf" }, set)).toBe("default-app");
	});

	it("an empty but readable registry is still readable: nothing opens in Obsidian", () => {
		const app = new App() as unknown as RegistryApp;
		app.viewRegistry = { typeByExtension: {} };
		expect(registeredExtensions(app as App).size).toBe(0);
	});

	it.each([
		["no viewRegistry", (app: RegistryApp) => { delete app.viewRegistry; }],
		["no typeByExtension", (app: RegistryApp) => { app.viewRegistry = {}; }],
		["typeByExtension not an object", (app: RegistryApp) => { app.viewRegistry = { typeByExtension: "nope" }; }],
		["typeByExtension null", (app: RegistryApp) => { app.viewRegistry = { typeByExtension: null }; }],
	])("an app whose registry can't be read (%s) falls back to the core list", (_label, break_) => {
		const app = new App() as unknown as RegistryApp;
		break_(app);
		const set = registeredExtensions(app as App);
		expect(chooseOpener({ extension: "md" }, set)).toBe("obsidian");
		expect(chooseOpener({ extension: "pdf" }, set)).toBe("obsidian");
		expect(chooseOpener({ extension: "rs" }, set)).toBe("default-app");
	});
});

describe("openSourceFile with core plugins off (R1): no empty or unsupported leaf", () => {
	it("a .canvas with Canvas off goes to the default app and getLeaf is never called", async () => {
		const app = new App();
		const internals = app as unknown as { viewRegistry: { typeByExtension: Record<string, string> }; defaultAppOpens: string[] };
		delete internals.viewRegistry.typeByExtension.canvas;
		const getLeaf = vi.fn();
		(app.workspace as unknown as { getLeaf: unknown }).getLeaf = getLeaf;
		const file = { path: "Sources/s/board.canvas", name: "board.canvas", extension: "canvas" } as unknown as TFile;
		expect(await openSourceFile(app, file, true)).toBe("default-app");
		expect(getLeaf).not.toHaveBeenCalled();
		expect(internals.defaultAppOpens).toEqual(["Sources/s/board.canvas"]);
	});
});
