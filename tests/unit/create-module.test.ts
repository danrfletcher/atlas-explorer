import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Menu, Notice, TFile } from "obsidian";
import { CREATE_MODULE_TITLE, CreateModuleFlowDeps, canCreateModule, createModule, planCreateModule, startCreateModule, unitForRef } from "../../src/create-module";
import { collectRootEntries, isNameTakenAtRoot, clashMessage } from "../../src/name-rules";
import { UnitIndex } from "../../src/unit-index";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { AtlasExplorerView } from "../../src/explorer-view";
import { Unit, UnitRef, View, ViewNode } from "../../src/types";
import { button, flush, inputEl, key, modals, seedRoot, type } from "../helpers";

const ROOT_FILES = ["Zed.md", "Snail.md", "Taken.md", "Snail.pdf", "Foo.md", "Foo.pdf", "Foo.png", "Foo.canvas", "notes.txt", "LICENSE", "README.md"];
const FOLDERS = ["Yak", "Taken", "Alpha", "Alpha/Sub", "Beta", "_pool"];
const NESTED = ["Alpha/Alpha.md", "Alpha/index.md", "Alpha/Zed.md", "Alpha/Sub/Doc.md", "Beta/Deep.md", "_pool/20260925143012-k3xq.md"];

let app: App;

function freshApp(): App {
	const a = new App();
	seedRoot(a, [], FOLDERS);
	seedRoot(a, [...ROOT_FILES, ...NESTED]);
	return a;
}

const file = (path: string) => app.vault.getAbstractFileByPath(path) as TFile;
const notices = () => Notice.instances.map((n) => n.message);

/** The four write APIs Atlas must never call (it never edits the file's content). */
function spyWrites() {
	const vault = app.vault as unknown as Record<string, unknown>;
	const fileManager = app.fileManager as unknown as Record<string, unknown>;
	const spies = [
		vi.fn(),
		vi.fn(),
		vi.fn(),
		vi.fn(),
	];
	vault.process = spies[0];
	vault.append = spies[1];
	fileManager.processFrontMatter = spies[2];
	const modify = vi.spyOn(app.vault, "modify");
	return { untouched: () => spies.slice(0, 3).every((s) => s.mock.calls.length === 0) && modify.mock.calls.length === 0 };
}

beforeEach(() => {
	app = freshApp();
	Notice.reset();
});

afterEach(async () => {
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
});

describe("UT-1 canCreateModule", () => {
	const yes: Unit = { type: "root-file", path: "Foo.md" };
	it("is true for a root-file unit with a .md file at the vault root", () => {
		expect(canCreateModule(app.vault, yes)).toBe(true);
		expect(canCreateModule(app.vault, { type: "root-file", path: "README.md" })).toBe(true);
	});

	it.each<[string, Unit | undefined]>([
		["free-block", { type: "free-block", path: "_pool/20260925143012-k3xq.md" }],
		["promoted-file", { type: "promoted-file", path: "Beta/Deep.md", topLevelFolder: "Beta" }],
		["promoted-block", { type: "promoted-block", path: "Foo.md", subpath: "^abc123" }],
		["folder-unit", { type: "folder-unit", path: "Alpha" }],
		["promoted-folder", { type: "promoted-folder", path: "Alpha/Sub", topLevelFolder: "Alpha" }],
		["root Foo.pdf", { type: "root-file", path: "Foo.pdf" }],
		["root Foo.png", { type: "root-file", path: "Foo.png" }],
		["root Foo.canvas", { type: "root-file", path: "Foo.canvas" }],
		["root notes.txt", { type: "root-file", path: "notes.txt" }],
		["root LICENSE (no extension)", { type: "root-file", path: "LICENSE" }],
		["a missing file", { type: "root-file", path: "Gone.md" }],
		["interface note Alpha/Alpha.md", { type: "promoted-file", path: "Alpha/Alpha.md", topLevelFolder: "Alpha" }],
		["interface note Alpha/index.md (alt names on)", { type: "promoted-file", path: "Alpha/index.md", topLevelFolder: "Alpha" }],
		["a root-file unit whose path is nested (defensive)", { type: "root-file", path: "Alpha/Alpha.md" }],
		["no unit at all (missing ref)", undefined],
	])("is false for %s", (_label, unit) => {
		expect(canCreateModule(app.vault, unit)).toBe(false);
	});

	it("does not rely on kind:file alone: _pool/x.md has a file ref and is still false", () => {
		const unit: Unit = { type: "free-block", path: "_pool/20260925143012-k3xq.md" };
		const ref: UnitRef = { kind: "file", path: unit.path };
		expect(unitForRef([unit], ref)).toBe(unit);
		expect(canCreateModule(app.vault, unitForRef([unit], ref))).toBe(false);
	});

	it("agrees with the real index: only the plain root .md rows qualify", () => {
		const index = new UnitIndex(app as never, { ...DEFAULT_SETTINGS, excludedFolders: ["_pool"], interfaceNoteAcceptAltNames: true }, [
			{ kind: "file", path: "Alpha/Alpha.md" },
			{ kind: "file", path: "Alpha/index.md" },
			{ kind: "file", path: "Alpha/Sub/Doc.md" },
		]);
		index.rebuild();
		const offered = index
			.getUnits()
			.filter((u) => canCreateModule(app.vault, u))
			.map((u) => u.path)
			.sort();
		expect(offered).toEqual(["Foo.md", "README.md", "Snail.md", "Taken.md", "Zed.md"]);
	});
});

describe("UT-2 clash rule for Create Module", () => {
	const root = () => [
		{ name: "Zed.md", kind: "file" as const },
		{ name: "Yak", kind: "folder" as const },
		{ name: "Snail.md", kind: "file" as const },
		{ name: "Taken", kind: "folder" as const },
		{ name: "Taken.md", kind: "file" as const },
		{ name: "Snail.pdf", kind: "file" as const },
	];
	it.each([
		["Zed", true],
		["zed", true],
		["ZED", true],
		["Yak", true],
		["yak", true],
		["Snail", false],
		["SNAIL", false],
		["Taken", true],
		["Snail 2", false],
	])("%s -> clash %s (converting Snail.md)", (name, clash) => {
		expect(isNameTakenAtRoot(name, root(), ["Snail.md"])).toBe(clash);
	});

	it("a note nested elsewhere (Alpha/Zed.md) does not clash", () => {
		expect(isNameTakenAtRoot("Zed", [{ name: "Alpha", kind: "folder" }], ["Snail.md"])).toBe(false);
		// through the real vault listing: only the root's direct children count
		const nestedOnly = new App();
		seedRoot(nestedOnly, ["Alpha/Zed.md"], ["Alpha"]);
		expect(isNameTakenAtRoot("Zed", collectRootEntries(nestedOnly.vault))).toBe(false);
	});

	it("the message quotes the typed text exactly", () => {
		expect(clashMessage("Zed")).toBe("A note or folder called 'Zed' already exists at the vault root");
		expect(clashMessage("zed")).toBe("A note or folder called 'zed' already exists at the vault root");
	});
});

describe("UT-3 plan function", () => {
	it("renames when the name differs", () => {
		expect(planCreateModule("Draft [v2].md", "Draft v2")).toEqual({ folder: "Draft v2", target: "Draft v2/Draft v2.md", needsRename: true });
	});
	it("keeps the file's own name", () => {
		expect(planCreateModule("Foo.md", "Foo")).toEqual({ folder: "Foo", target: "Foo/Foo.md", needsRename: false });
	});
	it("uses the name verbatim (no lowercasing, trimming or replacing)", () => {
		expect(planCreateModule("Foo.md", "foo")).toEqual({ folder: "foo", target: "foo/foo.md", needsRename: true });
		expect(planCreateModule("Foo.md", "Café ☕ notes")).toEqual({ folder: "Café ☕ notes", target: "Café ☕ notes/Café ☕ notes.md", needsRename: true });
		expect(planCreateModule("v1.2 notes.md", "v1.2 notes")).toEqual({ folder: "v1.2 notes", target: "v1.2 notes/v1.2 notes.md", needsRename: false });
	});
});

function deps(overrides: Partial<Parameters<typeof createModule>[0]> = {}) {
	return {
		app,
		convert: vi.fn(),
		save: vi.fn(async () => {}),
		afterMove: vi.fn(),
		...overrides,
	};
}

describe("UT-5 order of operations", () => {
	it("createFolder, one renameFile, conversion, then the links notice; nothing else", async () => {
		const order: string[] = [];
		const d = deps({
			convert: vi.fn(() => order.push("convert")),
			save: vi.fn(async () => void order.push("save")),
			afterMove: vi.fn(() => order.push("afterMove")),
		});
		const createFolder = vi.spyOn(app.vault, "createFolder").mockImplementation(async (p) => {
			order.push(`createFolder:${p}`);
			return Object.getPrototypeOf(app.vault).createFolder.call(app.vault, p);
		});
		const rename = vi.spyOn(app.fileManager, "renameFile").mockImplementation(async (f, p) => {
			order.push(`renameFile:${p}`);
			return Object.getPrototypeOf(app.fileManager).renameFile.call(app.fileManager, f, p);
		});
		const result = await createModule(d, file("Foo.md"), "Foo.md", "Foo");
		expect(result).toEqual({ ok: true, folder: "Foo", target: "Foo/Foo.md" });
		expect(order).toEqual(["createFolder:Foo", "renameFile:Foo/Foo.md", "convert", "save", "afterMove"]);
		expect(createFolder).toHaveBeenCalledTimes(1);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(d.convert).toHaveBeenCalledWith("Foo.md", "Foo");
		expect((app.vault as unknown as { calls: string[] }).calls).toEqual(["createFolder", "fileManager.renameFile", "rename"]);
		expect(app.vault.getAbstractFileByPath("Foo.md")).toBeNull();
		expect(app.vault.getAbstractFileByPath("Foo/Foo.md")).toBe(file("Foo/Foo.md"));
		expect(notices()).toEqual([]);
	});

	it("renames and moves in one renameFile call (never a root rename followed by a move)", async () => {
		app.vault.seedFile("Draft [v2].md");
		const rename = vi.spyOn(app.fileManager, "renameFile");
		await createModule(deps(), file("Draft [v2].md"), "Draft [v2].md", "Draft v2");
		expect(rename).toHaveBeenCalledTimes(1);
		expect(rename.mock.calls[0][1]).toBe("Draft v2/Draft v2.md");
		expect(app.vault.getAbstractFileByPath("Draft [v2].md")).toBeNull();
		expect(app.vault.getAbstractFileByPath("Draft v2/Draft v2.md")).not.toBeNull();
	});

	it("a case-only change renames the file to match", async () => {
		app.vault.seedFile("Snail2.md");
		await createModule(deps(), file("Snail2.md"), "Snail2.md", "SNAIL2");
		expect(app.vault.getAbstractFileByPath("SNAIL2/SNAIL2.md")).not.toBeNull();
	});
});

describe("EC-17 the save is flushed, not debounced", () => {
	it("awaits the save after the conversion, so data.json is written before createModule resolves", async () => {
		let written = false;
		const d = deps({
			convert: vi.fn(),
			save: vi.fn(async () => {
				await Promise.resolve();
				await Promise.resolve();
				written = true;
			}),
		});
		await createModule(d, file("Foo.md"), "Foo.md", "Foo");
		expect(d.save).toHaveBeenCalledTimes(1);
		expect(written).toBe(true);
	});

	it("a failing save gives one notice, still reports success and still shows the links notice", async () => {
		const d = deps({ save: vi.fn(async () => Promise.reject(new Error("disk full"))) });
		const result = await createModule(d, file("Foo.md"), "Foo.md", "Foo");
		expect(result).toEqual({ ok: true, folder: "Foo", target: "Foo/Foo.md" });
		expect(d.afterMove).toHaveBeenCalledTimes(1);
		expect(notices()).toEqual(['Atlas: the module "Foo" was created, but saving the views failed: disk full']);
	});
});

describe("UT-6 fault injection: the move fails", () => {
	it("deletes the folder Atlas made, leaves the file and the views alone, and shows one error notice", async () => {
		const d = deps();
		const foo = file("Foo.md");
		vi.spyOn(app.fileManager, "renameFile").mockRejectedValue(new Error("disk on fire"));
		const del = vi.spyOn(app.vault, "delete");
		const createFolder = vi.spyOn(app.vault, "createFolder");
		const result = await createModule(d, foo, "Foo.md", "Foo");
		expect(result.ok).toBe(false);
		expect(createFolder).toHaveBeenCalledWith("Foo");
		expect(del).toHaveBeenCalledTimes(1);
		expect(del.mock.calls[0][0].path).toBe("Foo");
		expect(del.mock.calls[0][1]).toBe(true); // a folder needs force, or Obsidian throws EISDIR
		expect(app.vault.getAbstractFileByPath("Foo")).toBeNull();
		expect(app.vault.getAbstractFileByPath("Foo.md")).toBe(foo);
		expect(foo.path).toBe("Foo.md");
		expect(d.convert).not.toHaveBeenCalled();
		expect(d.save).not.toHaveBeenCalled();
		expect(d.afterMove).not.toHaveBeenCalled();
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Foo": disk on fire']);
	});

	it("the rollback really removes the folder in a vault that refuses a non-forced folder delete, so a retry works", async () => {
		const foo = file("Foo.md");
		const rename = vi.spyOn(app.fileManager, "renameFile").mockRejectedValueOnce(new Error("disk on fire"));
		expect((await createModule(deps(), foo, "Foo.md", "Foo")).ok).toBe(false);
		expect(app.vault.getAbstractFileByPath("Foo")).toBeNull();
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Foo": disk on fire']); // no "couldn't remove the folder" tail
		rename.mockRestore();
		const retry = await createModule(deps(), foo, "Foo.md", "Foo");
		expect(retry).toEqual({ ok: true, folder: "Foo", target: "Foo/Foo.md" });
		expect(foo.path).toBe("Foo/Foo.md");
	});

	it("the promise resolves even when the rejection is not an Error", async () => {
		vi.spyOn(app.fileManager, "renameFile").mockRejectedValue("nope");
		await expect(createModule(deps(), file("Foo.md"), "Foo.md", "Foo")).resolves.toMatchObject({ ok: false, reason: "nope" });
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Foo": nope']);
	});

	it("views and manual promotions are byte-identical afterwards (conversion never ran)", async () => {
		const node: ViewNode = { id: "n1", type: "unit", ref: { kind: "file", path: "Foo.md" }, children: [], collapsed: true, explicitStatusId: "s1" };
		const views: View[] = [{ id: "v1", name: "Default", inboxMode: "view", root: [node] }];
		const before = JSON.stringify(views);
		const convert = vi.fn(() => {
			node.ref = { kind: "folder", path: "Foo" };
		});
		vi.spyOn(app.fileManager, "renameFile").mockRejectedValue(new Error("x"));
		await createModule(deps({ convert }), file("Foo.md"), "Foo.md", "Foo");
		expect(convert).not.toHaveBeenCalled();
		expect(JSON.stringify(views)).toBe(before);
	});
});

describe("UT-7 fault injection: folder creation fails", () => {
	it("no rename, no delete, same error notice", async () => {
		const d = deps();
		vi.spyOn(app.vault, "createFolder").mockRejectedValue(new Error("no space"));
		const rename = vi.spyOn(app.fileManager, "renameFile");
		const del = vi.spyOn(app.vault, "delete");
		const result = await createModule(d, file("Foo.md"), "Foo.md", "Foo");
		expect(result.ok).toBe(false);
		expect(rename).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
		expect(d.convert).not.toHaveBeenCalled();
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Foo": no space']);
		expect(app.vault.getAbstractFileByPath("Foo.md")).not.toBeNull();
	});

	it("an 'already exists' rejection never deletes the existing folder", async () => {
		app.vault.seedFolder("Late");
		app.vault.seedFile("Late/keep.md");
		app.vault.seedFile("Late2.md");
		// Simulate the folder appearing behind the dialog's back: the executor's own pre-check is bypassed
		vi.spyOn(app.vault, "getRoot").mockReturnValue({ children: [] } as never);
		vi.spyOn(app.vault, "createFolder").mockRejectedValue(new Error("Folder already exists."));
		const del = vi.spyOn(app.vault, "delete");
		const rename = vi.spyOn(app.fileManager, "renameFile");
		await createModule(deps(), file("Late2.md"), "Late2.md", "Late");
		expect(del).not.toHaveBeenCalled();
		expect(rename).not.toHaveBeenCalled();
		expect(app.vault.getAbstractFileByPath("Late")).not.toBeNull();
		expect(app.vault.getAbstractFileByPath("Late/keep.md")).not.toBeNull();
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Late": Folder already exists.']);
	});

	it("a clash created behind the dialog's back is caught before anything is created (EC-13)", async () => {
		app.vault.seedFolder("Late");
		const createFolder = vi.spyOn(app.vault, "createFolder");
		const result = await createModule(deps(), file("Foo.md"), "Foo.md", "Late");
		expect(result.ok).toBe(false);
		expect(createFolder).not.toHaveBeenCalled();
		expect(notices()).toEqual([`Atlas: couldn't create module "Late": a note or folder called 'Late' already exists at the vault root`]);
	});
});

describe("UT-8 rollback guards", () => {
	it("a folder that is no longer empty is left in place and the notice says so", async () => {
		vi.spyOn(app.fileManager, "renameFile").mockImplementation(async () => {
			app.vault.seedFile("Foo/stray.md"); // something appeared inside the folder Atlas made
			throw new Error("boom");
		});
		const del = vi.spyOn(app.vault, "delete");
		await createModule(deps(), file("Foo.md"), "Foo.md", "Foo");
		expect(del).not.toHaveBeenCalled();
		expect(app.vault.getAbstractFileByPath("Foo/stray.md")).not.toBeNull();
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toBe('Atlas: couldn\'t create module "Foo": boom. The folder "Foo" isn\'t empty, so Atlas left it in place');
	});

	it("a delete that throws gives an error notice and no exception; the file is untouched", async () => {
		const foo = file("Foo.md");
		vi.spyOn(app.fileManager, "renameFile").mockRejectedValue(new Error("boom"));
		vi.spyOn(app.vault, "delete").mockRejectedValue(new Error("locked"));
		await expect(createModule(deps(), foo, "Foo.md", "Foo")).resolves.toMatchObject({ ok: false });
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Foo": boom. Atlas couldn\'t remove the empty folder "Foo" either (locked)']);
		expect(foo.path).toBe("Foo.md");
	});
});

describe("stale target (EC-25)", () => {
	it.each([
		["renamed", (f: TFile) => app.vault.rename(f, "Renamed.md")],
		["deleted", (f: TFile) => app.vault.delete(f)],
	])("a file that was %s after the dialog opened: error notice, no folder, no conversion", async (_what, change) => {
		const d = deps();
		const foo = file("Foo.md");
		await change(foo);
		const createFolder = vi.spyOn(app.vault, "createFolder");
		const result = await createModule(d, foo, "Foo.md", "Foo");
		expect(result.ok).toBe(false);
		expect(createFolder).not.toHaveBeenCalled();
		expect(d.convert).not.toHaveBeenCalled();
		expect(notices()).toEqual(['Atlas: couldn\'t create module "Foo": the note was moved, renamed or deleted after the dialog opened']);
	});
});

describe("UT-9 content is never touched", () => {
	it.each([
		["happy path", async () => {}],
		["move fails", async () => void vi.spyOn(app.fileManager, "renameFile").mockRejectedValue(new Error("x"))],
		["folder creation fails", async () => void vi.spyOn(app.vault, "createFolder").mockRejectedValue(new Error("x"))],
	])("%s: no modify, process, append or processFrontMatter", async (_label, setup) => {
		const writes = spyWrites();
		await setup();
		await createModule(deps(), file("Foo.md"), "Foo.md", "Foo");
		expect(writes.untouched()).toBe(true);
	});
});

function flow(): CreateModuleFlowDeps & { convert: ReturnType<typeof vi.fn>; afterMove: ReturnType<typeof vi.fn> } {
	return { app, convert: vi.fn(), save: vi.fn(async () => {}), afterMove: vi.fn(), getPoolFolder: () => "_pool", getExcludedFolders: () => ["_pool"] };
}

describe("UT-10 dialog wiring", () => {
	it("opens prefilled with the file basename, valid, and confirms once for two rapid submits", async () => {
		const d = flow();
		const rename = vi.spyOn(app.fileManager, "renameFile");
		const done = startCreateModule(d, file("Foo.md"));
		expect(inputEl().value).toBe("Foo");
		expect(document.querySelector(".modal-title")!.textContent).toBe(CREATE_MODULE_TITLE);
		expect(button("Create").disabled).toBe(false);
		const input = inputEl();
		const create = button("Create");
		key("Enter", {}, input);
		key("Enter", {}, input);
		create.click();
		create.click();
		await done;
		await flush();
		expect(rename).toHaveBeenCalledTimes(1);
		expect(d.convert).toHaveBeenCalledTimes(1);
		expect(app.vault.getAbstractFileByPath("Foo/Foo.md")).not.toBeNull();
		expect(notices()).toEqual([]);
	});

	it("a second open while one is open is ignored, from the same or another file", async () => {
		const d = flow();
		const first = startCreateModule(d, file("Foo.md"));
		const again = startCreateModule(d, file("Foo.md"));
		const other = startCreateModule(d, file("Snail.md"));
		await Promise.all([again, other]);
		expect(document.querySelectorAll(".modal-container").length).toBe(1);
		key("Escape");
		await first;
	});

	it("prefills an invalid name red with Create disabled, and the chosen name renames the file (EC-14, AC-3)", async () => {
		app.vault.seedFile("Draft [v2].md");
		const d = flow();
		const done = startCreateModule(d, file("Draft [v2].md"));
		expect(inputEl().value).toBe("Draft [v2]");
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		expect(button("Create").disabled).toBe(true);
		key("Enter");
		expect(modals().length).toBe(1);
		type("Draft v2");
		expect(button("Create").disabled).toBe(false);
		key("Enter");
		await done;
		expect(app.vault.getAbstractFileByPath("Draft v2/Draft v2.md")).not.toBeNull();
		expect(app.vault.getAbstractFileByPath("Draft [v2].md")).toBeNull();
	});

	it("own name is not a clash, a name at the root is; a case-only change is green (AC-9, EC-11)", async () => {
		const done = startCreateModule(flow(), file("Snail.md"));
		expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
		type("Zed");
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		expect(document.querySelector(".atlas-name-message")!.textContent).toBe("A note or folder called 'Zed' already exists at the vault root");
		expect(button("Create").disabled).toBe(true);
		type("Zed 2");
		expect(button("Create").disabled).toBe(false);
		type("SNAIL");
		expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
		key("Escape");
		await done;
	});

	it("a prefill that trips the clash rule (folder Taken exists) is red on open (EC-10)", async () => {
		const done = startCreateModule(flow(), file("Taken.md"));
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		expect(button("Create").disabled).toBe(true);
		type("Taken 2");
		expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
		key("Escape");
		await done;
	});

	it("Cancel and Escape do nothing at all (AC-8)", async () => {
		const d = flow();
		const writes = spyWrites();
		const rename = vi.spyOn(app.fileManager, "renameFile");
		const createFolder = vi.spyOn(app.vault, "createFolder");
		for (const dismiss of [() => button("Cancel").click(), () => key("Escape")]) {
			const done = startCreateModule(d, file("Foo.md"));
			dismiss();
			await done;
			await flush();
		}
		expect(rename).not.toHaveBeenCalled();
		expect(createFolder).not.toHaveBeenCalled();
		expect(d.convert).not.toHaveBeenCalled();
		expect(notices()).toEqual([]);
		expect(modals().length).toBe(0);
		expect(writes.untouched()).toBe(true);
		expect(app.vault.getAbstractFileByPath("Foo.md")).not.toBeNull();
	});

	it("the same file can be run again once the first run has finished", async () => {
		const d = flow();
		const first = startCreateModule(d, file("Foo.md"));
		key("Escape");
		await first;
		const second = startCreateModule(d, file("Foo.md"));
		expect(modals().length).toBe(1);
		key("Escape");
		await second;
	});
});

describe("UT-11 menu builder (the real showUnitMenu)", () => {
	const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };
	const node = (ref: UnitRef, children: ViewNode[] = []): ViewNode => ({ id: "n1", type: "unit", ref, children });

	function menuFor(ref: UnitRef, units: Unit[], n: ViewNode = node(ref)) {
		const startCreate = vi.fn();
		const fake = {
			plugin: { app, unitIndex: { getUnits: () => units } },
			startCreateModule: startCreate,
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
		(AtlasExplorerView.prototype as unknown as { showUnitMenu: (...a: unknown[]) => void }).showUnitMenu.call(fake, new MouseEvent("contextmenu"), ref, view, n);
		show.mockRestore();
		return { menu: built!, startCreate };
	}

	const BASE = ["Open", "Open in new tab", "Reveal in native explorer", "Copy link", "Data source…", "Duplicate (Meta)", "Remove from view", "Place in view…"];

	it("offers exactly one Create Module after every existing item, in their old order", () => {
		const ref: UnitRef = { kind: "file", path: "Foo.md" };
		const { menu, startCreate } = menuFor(ref, [{ type: "root-file", path: "Foo.md" }]);
		expect(menu.titles()).toEqual([...BASE, "Create Module"]);
		menu.items[menu.items.length - 1].clickHandler!();
		expect(startCreate).toHaveBeenCalledWith(file("Foo.md"));
	});

	it("keeps Statuses (rows with children) in its old place and still offers the item", () => {
		const ref: UnitRef = { kind: "file", path: "Foo.md" };
		const child: ViewNode = { id: "c", type: "unit", ref: { kind: "file", path: "Zed.md" }, children: [] };
		const { menu } = menuFor(ref, [{ type: "root-file", path: "Foo.md" }], node(ref, [child]));
		expect(menu.titles()).toEqual(["Open", "Open in new tab", "Reveal in native explorer", "Copy link", "Statuses", "Data source…", "Duplicate (Meta)", "Remove from view", "Place in view…", "Create Module"]);
	});

	it.each<[string, UnitRef, Unit | undefined, string[]]>([
		["free block", { kind: "file", path: "_pool/20260925143012-k3xq.md" }, { type: "free-block", path: "_pool/20260925143012-k3xq.md" }, BASE],
		["promoted nested file", { kind: "file", path: "Beta/Deep.md" }, { type: "promoted-file", path: "Beta/Deep.md", topLevelFolder: "Beta" }, BASE],
		["manual promotion of an interface note", { kind: "file", path: "Alpha/Alpha.md" }, { type: "promoted-file", path: "Alpha/Alpha.md", topLevelFolder: "Alpha" }, BASE],
		["root pdf", { kind: "file", path: "Foo.pdf" }, { type: "root-file", path: "Foo.pdf" }, BASE],
		["missing file", { kind: "file", path: "Gone.md" }, undefined, BASE],
		["promoted block", { kind: "block", path: "Foo.md", subpath: "^abc123" }, { type: "promoted-block", path: "Foo.md", subpath: "^abc123" }, ["Open", "Open in new tab", "Copy link", "Data source…", "Duplicate (Meta)", "Remove from view", "Place in view…"]],
		["module row", { kind: "folder", path: "Alpha" }, { type: "folder-unit", path: "Alpha" }, ["Open", "Open in new tab", "Reveal in native explorer", "View module contents", "Copy link", "Data source…", "Duplicate (Meta)", "Remove from view", "Place in view…"]],
	])("%s: exactly the existing items, no Create Module", (_label, ref, unit, expected) => {
		const { menu } = menuFor(ref, unit ? [unit] : []);
		expect(menu.titles()).toEqual(expected);
	});
});

describe("FR: the wording never says promote", () => {
	it("the item title, dialog title and every notice this PR adds avoid the word", async () => {
		expect(CREATE_MODULE_TITLE).toBe("Create Module");
		vi.spyOn(app.fileManager, "renameFile").mockRejectedValue(new Error("boom"));
		await createModule(deps(), file("Foo.md"), "Foo.md", "Foo");
		for (const message of [CREATE_MODULE_TITLE, ...notices()]) expect(message.toLowerCase()).not.toContain("promot");
	});
});
