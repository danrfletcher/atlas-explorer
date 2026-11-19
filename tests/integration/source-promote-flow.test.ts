import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, Platform } from "obsidian";
import { unitRefKey } from "../../src/types";
import { getPromotedRoots } from "../../src/source-links";
import { askConfirm } from "../../src/modals";
import { makeSourcesRig, rowByKey, sectionEl, sectionRows, sectionTitles, type SourcesRig } from "../sources-explorer-fixture";

// PR-12 (G6, E10): Make its own source / Return to parent, through the real explorer, the real `TephraClient` and
// `TephraConnection`, and a fake daemon answering over HTTP. The daemon's `source.promote` / `source.unpromote`
// stand in for Tephra's (what a real one answers is its own repo's test); everything on Atlas's side is shipped code.

const VAULT = "/Users/dan/Vault";
const TEPHRA = "/home/user/Developer/Tephra";
const FOLDER_KEY = (path: string) => unitRefKey({ kind: "folder", path });
const KEY = (path: string) => unitRefKey({ kind: "file", path });

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
	Platform.isMobile = false;
});

function menuOf(row: HTMLElement): Menu {
	let built: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	vi.restoreAllMocks();
	return built!;
}
/** Makes `path` a source through the real action and waits for the source list that follows it. */
async function promote(path: string): Promise<void> {
	await rig!.promoter!.makeOwnSource(path);
	await vi.waitFor(() => expect(getPromotedRoots().length).toBeGreaterThan(0));
	await rig!.settle();
}
const titles = (menu: Menu) => menu.items.map((item) => item.title);

/** A fake daemon that really promotes: `docs` becomes a source rooted at `${TEPHRA}/docs`, and Tephra's own listing drops the row. */
async function promotingRig(overrides: { refuse?: string; answer?: () => Promise<boolean> } = {}): Promise<SourcesRig> {
	let r!: SourcesRig;
	rig = await makeSourcesRig({
		promote: { vaultPath: VAULT, answer: overrides.answer },
		methods: {
			"source.promote": (params) => {
				if (overrides.refuse) return { error: { code: -32000, message: overrides.refuse } };
				const { name, root } = params as { name: string; root: string };
				r.daemon.sources = [...r.daemon.sources, { name, path: root, status: "online" }];
				r.daemon.units = {
					...r.daemon.units,
					[name]: [{ name: "guide.md", kind: "markdown" }],
					tephra: (r.daemon.units.tephra as Array<{ name: string }>).filter((e) => e.name !== name),
				} as never;
				return { result: { status: "applied", deferred: 0 } };
			},
			"source.unpromote": (params) => {
				const { name } = params as { name: string };
				r.daemon.sources = r.daemon.sources.filter((s) => s.name !== name);
				const { [name]: _gone, ...rest } = r.daemon.units as Record<string, unknown>;
				r.daemon.units = { ...rest, tephra: [...(r.daemon.units.tephra as unknown[]), { name: "docs", kind: "folder" }] } as never;
				return { result: { status: "applied", deferred: 0 } };
			},
		},
	});
	r = rig;
	return rig;
}

describe("Make its own source", () => {
	it("a folder row of a source's Inbox section offers it; a file row does not", async () => {
		await promotingRig();
		expect(titles(menuOf(rowByKey(rig!.h, FOLDER_KEY("Sources/tephra/docs"))))).toContain("Make its own source");
		expect(titles(menuOf(rowByKey(rig!.h, KEY("Sources/tephra/README.md"))))).not.toContain("Make its own source");
	});

	it("confirm -> source.promote { name, root } -> the section appears, the folder leaves its parent, no `Sources/docs` link is made", async () => {
		await promotingRig();
		const menu = menuOf(rowByKey(rig!.h, FOLDER_KEY("Sources/tephra/docs")));
		menu.items.find((item) => item.title === "Make its own source")!.clickHandler!();
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([{ name: "docs", vaultPath: "Sources/tephra/docs", absRoot: `${TEPHRA}/docs` }]));
		await rig!.settle();

		expect(rig!.confirms).toEqual(["Make docs its own source? It will be hidden in tephra."]);
		const promote = rig!.daemon.requests.filter((r) => r.method === "source.promote");
		expect(promote).toEqual([{ jsonrpc: "2.0", id: expect.anything(), method: "source.promote", params: { name: "docs", root: `${TEPHRA}/docs` } }].map((r) => expect.objectContaining({ method: r.method, params: r.params })));
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[docs]", "[tephra]", "[whoop]"]);
		// The promoted folder's contents keep their vault path: the section shows them there.
		expect(sectionRows(sectionEl(rig!.h, "docs"))).toEqual(["guide"]);
		expect(rowByKey(rig!.h, KEY("Sources/tephra/docs/guide.md")).closest(".atlas-inbox-source")!.getAttribute("data-source")).toBe("docs");
		expect(sectionRows(sectionEl(rig!.h, "tephra"))).not.toContain("docs");
		expect(rig!.notices).toEqual([]);
	});

	it("Cancel sends nothing and changes nothing", async () => {
		await promotingRig({ answer: async () => false });
		menuOf(rowByKey(rig!.h, FOLDER_KEY("Sources/tephra/docs"))).items.find((item) => item.title === "Make its own source")!.clickHandler!();
		await vi.waitFor(() => expect(rig!.confirms).toHaveLength(1));
		await rig!.settle();
		expect(rig!.daemon.requests.filter((r) => r.method === "source.promote")).toEqual([]);
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
	});

	it("a refusal shows Tephra's sentence and changes nothing", async () => {
		await promotingRig({ refuse: "the name \"docs\" is taken by the source \"docs\"" });
		menuOf(rowByKey(rig!.h, FOLDER_KEY("Sources/tephra/docs"))).items.find((item) => item.title === "Make its own source")!.clickHandler!();
		await vi.waitFor(() => expect(rig!.notices).toHaveLength(1));
		expect(rig!.notices[0]).toBe("Atlas: couldn't make docs its own source: the name \"docs\" is taken by the source \"docs\".");
		expect(getPromotedRoots()).toEqual([]);
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
	});

	it("Tephra offline: the item is shown greyed out, a click sends nothing", async () => {
		await promotingRig();
		rig!.daemon.down = true;
		await rig!.check();
		const item = menuOf(rowByKey(rig!.h, FOLDER_KEY("Sources/tephra/docs"))).items.find((i) => i.title === "Make its own source")!;
		expect(item.disabled).toBe(true);
		rig!.daemon.requests.length = 0;
		await rig!.promoter!.makeOwnSource("Sources/tephra/docs");
		expect(rig!.daemon.requests.filter((r) => r.method === "source.promote")).toEqual([]);
		expect(rig!.notices).toEqual(["Atlas: Tephra isn't running."]);
	});

	it("the toggle off: no item at all", async () => {
		await promotingRig();
		(rig!.plugin.settings as { tephraEnabled: boolean }).tephraEnabled = false;
		await rig!.settle();
		const row = rig!.h.panel().querySelector<HTMLElement>(`[data-select-key="${FOLDER_KEY("Sources/tephra/docs")}"]`);
		if (row) expect(titles(menuOf(row))).not.toContain("Make its own source");
	});
});

describe("Return to parent", () => {
	it("a promoted source's header offers it (and not Rename/Remove, which belong to a link); a top-level source's header does not", async () => {
		await promotingRig();
		await promote("Sources/tephra/docs");
		const docsHeader = sectionEl(rig!.h, "docs").querySelector<HTMLElement>(".atlas-section-header")!;
		const docsMenu = titles(menuOf(docsHeader));
		expect(docsMenu).toContain("Return to parent");
		expect(docsMenu).not.toContain("Rename source…");
		const tephraMenu = titles(menuOf(sectionEl(rig!.h, "tephra").querySelector<HTMLElement>(".atlas-section-header")!));
		expect(tephraMenu).not.toContain("Return to parent");
	});

	it("confirm -> source.unpromote { name } -> the section goes and the folder is back in its parent", async () => {
		await promotingRig();
		await promote("Sources/tephra/docs");
		await rig!.promoter!.returnToParent("docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		await rig!.settle();
		expect(rig!.daemon.requests.filter((r) => r.method === "source.unpromote").map((r) => r.params)).toEqual([{ name: "docs" }]);
		expect(getPromotedRoots()).toEqual([]);
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(sectionRows(sectionEl(rig!.h, "tephra"))).toContain("docs");
	});
});

describe("a promote made outside Atlas (`tephractl`) lands on the next source list", () => {
	it("a check sees the nested source and gives it its section", async () => {
		await promotingRig();
		rig!.daemon.sources = [...rig!.daemon.sources, { name: "docs", path: `${TEPHRA}/docs`, status: "online" }];
		rig!.daemon.units = { ...rig!.daemon.units, docs: [{ name: "guide.md", kind: "markdown" }] } as never;
		await rig!.check();
		expect(sectionTitles(rig!.h)).toContain("[docs]");
		expect(getPromotedRoots()).toEqual([{ name: "docs", vaultPath: "Sources/tephra/docs", absRoot: `${TEPHRA}/docs` }]);
	});
});

describe("the gap between Inbox sections takes a folder drag", () => {
	const gaps = () => [...rig!.h.panel().querySelectorAll<HTMLElement>(".atlas-inbox-gap")];
	const dragOver = (gap: HTMLElement) => {
		const evt = new Event("dragover", { bubbles: true, cancelable: true });
		gap.dispatchEvent(evt);
		return evt.defaultPrevented;
	};
	const startDrag = (key: string) => rowByKey(rig!.h, key).dispatchEvent(new Event("dragstart", { bubbles: true }));

	it("one gap between each pair of sections, none after the last", async () => {
		await promotingRig();
		expect(gaps()).toHaveLength(2); // Inbox | [tephra] | [whoop]
	});

	it("a folder row dropped on a gap makes a source of it (after the confirm)", async () => {
		await promotingRig();
		startDrag(FOLDER_KEY("Sources/tephra/docs"));
		const gap = gaps()[0];
		expect(dragOver(gap)).toBe(true);
		expect(gap.classList.contains("atlas-drop-target")).toBe(true);
		gap.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([{ name: "docs", vaultPath: "Sources/tephra/docs", absRoot: `${TEPHRA}/docs` }]));
		expect(rig!.confirms).toEqual(["Make docs its own source? It will be hidden in tephra."]);
	});

	it("a file row is refused: no highlight, nothing sent", async () => {
		await promotingRig();
		startDrag(KEY("Sources/tephra/README.md"));
		const gap = gaps()[0];
		expect(dragOver(gap)).toBe(false);
		expect(gap.classList.contains("atlas-drop-target")).toBe(false);
		gap.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
		await rig!.settle();
		expect(rig!.confirms).toEqual([]);
		expect(rig!.daemon.requests.filter((r) => r.method === "source.promote")).toEqual([]);
	});

	it("Tephra offline: a folder row is refused too", async () => {
		await promotingRig();
		rig!.daemon.down = true;
		await rig!.check();
		startDrag(FOLDER_KEY("Sources/tephra/docs"));
		expect(dragOver(gaps()[0])).toBe(false);
	});

	it("a drag with nothing in flight is refused", async () => {
		await promotingRig();
		expect(dragOver(gaps()[0])).toBe(false);
	});
});

describe("view and status state across a promote and a return (G6)", () => {
	const flat = (nodes: Array<{ children?: unknown[] }>): Array<Record<string, unknown>> => nodes.flatMap((n) => [n as Record<string, unknown>, ...flat((n.children ?? []) as Array<{ children?: unknown[] }>)]);

	it("a placed unit of the promoted folder keeps its node id, ref, position and status through promote and return; data.json gets no source-name key", async () => {
		await promotingRig();
		const view = rig!.viewsManager.getActiveView();
		const governor = rig!.viewsManager.addMetaFolder(view.id, null, "Tasks")!;
		rig!.viewsManager.setNodeStatus(view.id, governor.id, true, "S");
		const placed = rig!.viewsManager.placeUnit(view.id, { kind: "file", path: "Sources/tephra/docs/guide.md" }, governor.id)!;
		const before = JSON.stringify(rig!.viewsManager.getViews());

		await promote("Sources/tephra/docs");
		expect(JSON.stringify(rig!.viewsManager.getViews())).toBe(before);
		await rig!.promoter!.returnToParent("docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		await rig!.settle();
		expect(JSON.stringify(rig!.viewsManager.getViews())).toBe(before);

		const node = flat(rig!.viewsManager.getActiveView().root as never).find((n) => n.id === placed.id)!;
		expect(node.ref).toEqual({ kind: "file", path: "Sources/tephra/docs/guide.md" });
		expect(before).not.toContain("source:docs");
		expect(Object.keys(JSON.parse(before)[0])).not.toContain("docs");
	});
});

describe("double confirm and double drop send one call", () => {
	it("two requests while the first is open send one source.promote", async () => {
		await promotingRig();
		const first = rig!.promoter!.makeOwnSource("Sources/tephra/docs");
		const second = rig!.promoter!.makeOwnSource("Sources/tephra/docs");
		await Promise.all([first, second]);
		await vi.waitFor(() => expect(getPromotedRoots()).toHaveLength(1));
		expect(rig!.daemon.requests.filter((r) => r.method === "source.promote")).toHaveLength(1);
		expect(rig!.confirms).toHaveLength(1);
	});

	it("pressing Confirm twice in the real dialog (the one main.ts uses) sends one source.promote", async () => {
		let rigRef!: SourcesRig;
		rig = await makeSourcesRig({
			promote: {
				vaultPath: VAULT,
				answer: async () => {
					const pending = askConfirm(rigRef.app, "Make docs its own source? It will be hidden in tephra.", "Make source");
					const button = [...document.querySelectorAll<HTMLElement>(".modal button")].find((b) => b.textContent === "Make source")!;
					button.click();
					button.click(); // the second press, before the dialog is gone
					return pending;
				},
			},
			methods: {
				"source.promote": (params) => {
					const { name, root } = params as { name: string; root: string };
					rigRef.daemon.sources = [...rigRef.daemon.sources, { name, path: root, status: "online" }];
					return { result: { status: "applied", deferred: 0 } };
				},
			},
		});
		rigRef = rig;
		await rig.promoter!.makeOwnSource("Sources/tephra/docs");
		expect(rig.daemon.requests.filter((r) => r.method === "source.promote")).toHaveLength(1);
		expect(document.querySelector(".modal")).toBeNull();
	});

	it("Cancel in the real dialog resolves false, and Escape-style close does too", async () => {
		await promotingRig();
		const pending = askConfirm(rig!.app, "m", "Make source");
		[...document.querySelectorAll<HTMLElement>(".modal button")].find((b) => b.textContent === "Cancel")!.click();
		expect(await pending).toBe(false);
	});
});

describe("a promote made outside Atlas, a missing folder, and the toggle", () => {
	it("graph:changed brings a promote made with tephractl into the Inbox without a manual check", async () => {
		await promotingRig();
		rig!.daemon.sources = [...rig!.daemon.sources, { name: "docs", path: `${TEPHRA}/docs`, status: "online" }];
		rig!.daemon.units = { ...rig!.daemon.units, docs: [{ name: "guide.md", kind: "markdown" }] } as never;
		await rig!.push();
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[docs]", "[tephra]", "[whoop]"]);
	});

	it("a promoted source whose folder is gone shows (missing) and no rows, and nothing is deleted", async () => {
		await promotingRig();
		await promote("Sources/tephra/docs");
		rig!.daemon.sources = rig!.daemon.sources.map((s) => (s.name === "docs" ? { ...s, status: "missing" as const } : s));
		await rig!.check();
		expect(sectionEl(rig!.h, "docs").textContent).toContain("missing");
		expect(sectionRows(sectionEl(rig!.h, "docs"))).toEqual([]);
		expect(getPromotedRoots()).toEqual([{ name: "docs", vaultPath: "Sources/tephra/docs", absRoot: `${TEPHRA}/docs` }]);
	});

	it("toggle off clears the promoted roots and the sections; the promotion stays registered in Tephra; toggle on shows it again", async () => {
		await promotingRig();
		await promote("Sources/tephra/docs");
		const { applyPromotedRoots } = await import("../../src/promoted-roots");
		const { setPromotedRoots } = await import("../../src/source-links");
		setPromotedRoots([]); // what `onTephraToggled(false)` does
		(rig!.plugin.settings as { tephraEnabled: boolean }).tephraEnabled = false;
		await (rig!.h.explorer as unknown as { render(): Promise<void> }).render();
		expect(sectionTitles(rig!.h)).not.toContain("[docs]");
		expect(rig!.daemon.sources.some((s) => s.name === "docs")).toBe(true); // Tephra still has it
		(rig!.plugin.settings as { tephraEnabled: boolean }).tephraEnabled = true;
		expect(applyPromotedRoots(rig!.daemon.sources as never, VAULT)).toBe(true);
		await (rig!.h.explorer as unknown as { render(): Promise<void> }).render();
		expect(sectionTitles(rig!.h)).toContain("[docs]");
	});
});

describe("dragging a Module Contents item to the gap", () => {
	it("a folder dragged out of the modal and dropped on the gap asks for a promote; a file does not", async () => {
		await promotingRig();
		const explorer = rig!.h.explorer as unknown as { openModuleContentsModal(path: string): void; dragPayload: unknown };
		explorer.openModuleContentsModal("Sources/tephra");
		const modal = document.querySelector(".modal")!;
		const rows = [...modal.querySelectorAll<HTMLElement>(".atlas-row-internal")];
		const docs = rows.find((r) => r.querySelector(".atlas-row-text")?.textContent === "docs")!;
		const readme = rows.find((r) => r.querySelector(".atlas-row-text")?.textContent === "README.md")!;
		const gap = rig!.h.panel().querySelector<HTMLElement>(".atlas-inbox-gap")!;

		const modalObj = (rig!.h.explorer as unknown as { openModuleModal: { modalEl: HTMLElement } }).openModuleModal;
		Object.defineProperty(modalObj.modalEl, "getBoundingClientRect", { value: () => ({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect });
		const at = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }); // outside the modal's frame

		readme.dispatchEvent(new Event("dragstart", { bubbles: true }));
		const noDrop = at("dragover");
		gap.dispatchEvent(noDrop);
		expect(noDrop.defaultPrevented).toBe(false);
		readme.dispatchEvent(new Event("dragend", { bubbles: true }));

		docs.dispatchEvent(new Event("dragstart", { bubbles: true }));
		const over = at("dragover");
		gap.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(true);
		gap.dispatchEvent(at("drop"));
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([{ name: "docs", vaultPath: "Sources/tephra/docs", absRoot: `${TEPHRA}/docs` }]));
		expect(rig!.confirms).toEqual(["Make docs its own source? It will be hidden in tephra."]);
	});
});

// GP9 + GP8 on the fixture's real nesting: `tephrad` is a folder of `crates` in `[tephra]` (the fixture vault's
// `Sources/tephra` is a symlink to `tests/fixtures/tephra-tree`), and a vault note holds the GP8 block link.
describe("a nested folder: tephrad inside crates inside tephra (GP9, GP8)", () => {
	const REGISTRY = "Sources/tephra/crates/tephrad/src/registry.rs";
	const NOTE = "Weekly Review.md";
	const link = (text: string) => ({ link: text, original: `[[${text}]]`, displayText: text, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } });
	const asBlock = (u: { type: string; path: string; subpath?: string }) => u.type === "promoted-block" && u.path === REGISTRY && u.subpath === "^k3f9a2";

	async function nestedRig(): Promise<SourcesRig> {
		let r!: SourcesRig;
		rig = await makeSourcesRig({
			settings: { autoPromotion: true }, // a link-only pop-out shows in the Inbox only with auto-promotion on
			promote: { vaultPath: VAULT },
			methods: {
				"source.promote": (params) => {
					const { name, root } = params as { name: string; root: string };
					r.daemon.sources = [...r.daemon.sources, { name, path: root, status: "online" }];
					r.daemon.units = { ...r.daemon.units, [name]: [{ name: "src", kind: "folder" }] } as never;
					return { result: { status: "applied", deferred: 0 } };
				},
				"source.unpromote": (params) => {
					const { name } = params as { name: string };
					r.daemon.sources = r.daemon.sources.filter((source) => source.name !== name);
					const { [name]: _gone, ...rest } = r.daemon.units as Record<string, unknown>;
					r.daemon.units = rest as never;
					return { result: { status: "applied", deferred: 0 } };
				},
			},
		});
		r = rig;
		return r;
	}
	/** Obsidian's link cache for the vault note: what the note says now (Tephra rewrites it; Obsidian re-reads it). */
	function noteSays(text: string): void {
		const app = rig!.app as unknown as { metadataCache: { getFileCache: unknown } };
		app.metadataCache.getFileCache = (file: { path: string }) => (file.path === NOTE ? { links: [link(text)] } : null);
		rig!.unitIndex.onMetadataResolved();
	}
	const sourcesDir = () => rig!.app.vault.getAbstractFileByPath("Sources") as unknown as { children: Array<{ name: string }> };
	const resolve = (text: string, from = NOTE) => (rig!.plugin.sourceLinks as { resolveFile(t: string, f: string): { path: string } | null }).resolveFile(text, from)?.path ?? null;
	const popOutIn = (section: string) => [...(sectionEl(rig!.h, section)?.querySelectorAll<HTMLElement>("[data-select-key]") ?? [])].map((el) => el.getAttribute("data-select-key")).filter((key) => key?.includes("registry.rs") && key.includes("k3f9a2"));

	it("the fixture is what the spec describes: Sources/tephra is a symlink to a tree with crates/tephrad/src/{registry,scan}.rs, and the note holds the GP8 link", async () => {
		const { lstatSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = join(__dirname, "..", "fixtures", "sources-vault");
		expect(lstatSync(join(root, "Sources", "tephra")).isSymbolicLink()).toBe(true);
		for (const file of ["registry.rs", "scan.rs"]) expect(() => lstatSync(join(root, "Sources", "tephra", "crates", "tephrad", "src", file))).not.toThrow();
		expect(readFileSync(join(root, NOTE), "utf8")).toContain("[[@tephra:crates/tephrad/src/registry.rs#^k3f9a2]]");
	});

	it("GP8 start: the block link resolves into tephra and pops registry.rs out under [tephra], with no [tephrad] section", async () => {
		await nestedRig();
		noteSays("@tephra:crates/tephrad/src/registry.rs#^k3f9a2");
		expect(resolve("@tephra:crates/tephrad/src/registry.rs")).toBe(REGISTRY);
		expect(resolve("@tephrad:src/registry.rs")).toBeNull(); // no such source yet
		expect(rig!.unitIndex.getUnits().filter(asBlock)).toHaveLength(1);
		await rig!.settle();
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(popOutIn("tephra")).toHaveLength(1);
	});

	it("GP9 promote: tephrad leaves crates' Module Contents, gets [tephrad], no Sources/tephrad link is made, and the resolver takes @tephrad:", async () => {
		await nestedRig();
		const explorer = rig!.h.explorer as unknown as { openModuleContentsModal(path: string): void };
		const rowsOf = () => [...document.querySelectorAll<HTMLElement>(".modal .atlas-row-internal .atlas-row-text")].map((el) => el.textContent);
		explorer.openModuleContentsModal("Sources/tephra/crates");
		expect(rowsOf()).toContain("tephrad");
		(rig!.h.explorer as unknown as { openModuleModal: { close(): void } }).openModuleModal.close();
		const sourcesBefore = sourcesDir().children.map((c) => c.name).sort();

		await promote("Sources/tephra/crates/tephrad");
		expect(rig!.confirms).toEqual(["Make tephrad its own source? It will be hidden in tephra."]);
		expect(rig!.daemon.requests.filter((r) => r.method === "source.promote").map((r) => r.params)).toEqual([{ name: "tephrad", root: `${TEPHRA}/crates/tephrad` }]);
		expect(getPromotedRoots()).toEqual([{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad", absRoot: `${TEPHRA}/crates/tephrad` }]);

		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[tephrad]", "[whoop]"]);
		explorer.openModuleContentsModal("Sources/tephra/crates");
		expect(rowsOf()).not.toContain("tephrad");
		(rig!.h.explorer as unknown as { openModuleModal: { close(): void } }).openModuleModal.close();
		expect(sourcesDir().children.map((c) => c.name).sort()).toEqual(sourcesBefore); // F2: no Sources/tephrad

		// The resolver, through the real controller's `invalidateIndex()` hook the roots sync called.
		expect(resolve("@tephrad:src/registry.rs")).toBe(REGISTRY);
		expect(resolve("@tephra:crates/tephrad/src/registry.rs")).toBeNull(); // the file is `tephrad`'s now: `tephra` no longer has it
		expect(resolve("registry", "Sources/tephra/crates/tephrad/src/scan.rs")).toBeNull(); // a plain link stays inside `tephrad`...
		expect(resolve("scan", REGISTRY)).toBeNull(); // (a plain link isn't answered by the `@source:` resolver at all)
	});

	it("GP8 after the promote: Tephra rewrites the note; the block's pop-out moves from [tephra] to [tephrad]; Return to parent moves it back", async () => {
		await nestedRig();
		noteSays("@tephra:crates/tephrad/src/registry.rs#^k3f9a2");
		await rig!.settle();
		expect(popOutIn("tephra")).toHaveLength(1);

		await promote("Sources/tephra/crates/tephrad");
		noteSays("@tephrad:src/registry.rs#^k3f9a2"); // Tephra's rewrite, as Obsidian re-reads it
		await rig!.settle();
		expect(rig!.unitIndex.getUnits().filter(asBlock)).toHaveLength(1); // a link from another source counts
		expect(popOutIn("tephra")).toEqual([]);
		expect(popOutIn("tephrad")).toHaveLength(1);

		await rig!.promoter!.returnToParent("tephrad");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		noteSays("@tephra:crates/tephrad/src/registry.rs#^k3f9a2"); // and back
		await rig!.settle();
		expect(sectionTitles(rig!.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(popOutIn("tephra")).toHaveLength(1);
		expect(popOutIn("tephrad")).toEqual([]);
		expect(resolve("@tephra:crates/tephrad/src/registry.rs")).toBe(REGISTRY);
		expect(resolve("@tephrad:src/registry.rs")).toBeNull();
	});
});
