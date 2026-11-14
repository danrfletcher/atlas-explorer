import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import { ATLAS_LINKS_VIEW_TYPE, openBacklinkRow, TEPHRA_SECTION_CLASS, TEPHRA_SECTION_TITLE, TephraBacklinksSection } from "../../src/backlinks-section";
import { seedRoot } from "../helpers";

// G10: the section in the core Backlinks panel, driven through the real controller with a fake `backlink` leaf in
// jsdom and a fake Tephra serving fixture `Edge` JSON. No Obsidian call is mocked beyond the workspace shape.

const edge = (from: string, to: string, line: number | null = 3) => ({ from, to: { resolved: to }, to_raw: to, kind: "wikilink", offline: false, line });
const FILES = ["Weekly Review.md", "Sources/demo/crates/core/src/registry.rs", "Sources/demo/scripts/build.sh", "Sources/demo/docs/a.pdf", "Sources/demo/docs/guide/Setup.md", "Notes/Idea.md"];
for (let i = 0; i < 20; i++) FILES.push(`Sources/demo/f${i}.rs`);

interface Deferred {
	resolve: (answer: unknown) => void;
	id: string;
}

function setup(options: { leafShape?: "panel" | "none" | "no-pane"; manual?: boolean; unindexedNotes?: string[] } = {}) {
	const app = new App();
	seedRoot(app, FILES, ["Sources", "Sources/demo", "Sources/demo/crates", "Sources/demo/crates/core", "Sources/demo/crates/core/src", "Sources/demo/scripts", "Sources/demo/docs", "Sources/demo/docs/guide", "Notes"]);
	app.viewRegistry.typeByExtension.sh = "vscode";
	let active: TFile | null = null;
	// Real Obsidian (1.14.4): a non-markdown file has a `{}` cache, not null; only a markdown file Obsidian
	// hasn't indexed (or excludes) has null.
	const noCache = new Set<string>(options.unindexedNotes ?? []);
	app.metadataCache.getFileCache = ((file: TFile) => (noCache.has(file.path) ? null : {})) as App["metadataCache"]["getFileCache"];

	// The fake Backlinks panel: Obsidian's own children come first; the section must land after them.
	const containerEl = document.createElement("div");
	const pane = document.createElement("div");
	pane.className = options.leafShape === "no-pane" ? "something-else" : "backlink-pane";
	pane.innerHTML = '<div class="tree-item">Linked mentions</div><div class="tree-item">Unlinked mentions</div>';
	containerEl.appendChild(pane);
	document.body.appendChild(containerEl);
	const linksContent = document.createElement("div");
	document.body.appendChild(linksContent);
	let linksPaneOpen = false;

	const opened: Array<{ file: string; state: unknown; newTab: boolean }> = [];
	const ws = app.workspace as unknown as Record<string, unknown>;
	ws.getActiveFile = () => active;
	ws.getLeavesOfType = (type: string) => {
		if (type === "backlink" && options.leafShape !== "none") return [{ view: { containerEl } }];
		if (type === ATLAS_LINKS_VIEW_TYPE && linksPaneOpen) return [{ view: { contentEl: linksContent } }];
		return [];
	};
	ws.getLeaf = (newTab: boolean) => ({ openFile: async (file: TFile, state: unknown) => void opened.push({ file: file.path, state, newTab }) });

	const calls: string[] = [];
	const pending: Deferred[] = [];
	let answers: Record<string, unknown> = {};
	let failing = false;
	const connection = {
		getSnapshot: () => ({ sources: [{ name: "demo" }, { name: "whoop" }] }),
		async call(method: string, params?: unknown) {
			const id = (params as { id: string }).id;
			calls.push(`${method} ${id}`);
			if (failing) return { ok: false as const, error: { kind: "network", message: "down" } };
			if (options.manual) return new Promise<{ ok: true; result: unknown }>((resolve) => pending.push({ id, resolve: (a) => resolve({ ok: true, result: a }) }));
			return { ok: true as const, result: answers[id] ?? [] };
		},
	};
	let enabled = true;
	const section = new TephraBacklinksSection({
		app,
		isEnabled: () => enabled,
		getConnection: () => (enabled ? connection : null),
		includeCrossSourceNotes: () => false,
		open: (path, line, newTab) => void openBacklinkRow(app, path, line, newTab),
	});
	const open = (path: string) => {
		active = app.vault.getAbstractFileByPath(path) as TFile;
	};
	return {
		app,
		section,
		pane,
		linksContent,
		calls,
		pending,
		opened,
		open,
		answer: (id: string, edges: unknown[]) => (answers[id] = edges),
		setFailing: (v: boolean) => (failing = v),
		setEnabled: (v: boolean) => (enabled = v),
		openLinksPane: () => (linksPaneOpen = true),
		sections: () => Array.from(document.querySelectorAll(`.${TEPHRA_SECTION_CLASS}`)),
		rows: (el: ParentNode = document) => Array.from(el.querySelectorAll(".atlas-tephra-backlink-row")).map((r) => r.textContent),
	};
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const REGISTRY = "@demo:crates/core/src/registry.rs";

beforeEach(() => {
	document.body.innerHTML = "";
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("the Tephra section in the Backlinks panel (G10)", () => {
	it("is appended once after Obsidian's own children and lists path:line rows, sorted", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY, 12), edge("@demo:scripts/build.sh", REGISTRY, 3), edge("@demo:docs/a.pdf", REGISTRY, null), edge("@notes:Weekly Review.md", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.sections()).toHaveLength(1);
		expect(t.pane.lastElementChild).toBe(t.sections()[0]);
		expect(t.sections()[0].textContent).toContain(TEPHRA_SECTION_TITLE);
		expect(t.rows()).toEqual(["Sources/demo/docs/a.pdf", "Sources/demo/scripts/build.sh:3", "Sources/demo/scripts/build.sh:12"]); // the note is Obsidian's own
		expect(t.pane.children).toHaveLength(3); // Obsidian's two, plus ours
	});

	it("stays one section across re-renders, and moves back to the bottom when Obsidian rebuilds the panel's children", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		for (let i = 0; i < 5; i++) {
			t.section.refresh(true);
			await settle();
		}
		expect(t.sections()).toHaveLength(1);
		const section = t.sections()[0];
		// Obsidian re-renders its own panel: it appends a fresh child after ours.
		const fresh = document.createElement("div");
		fresh.className = "tree-item";
		t.pane.appendChild(fresh);
		await settle();
		expect(t.sections()).toEqual([section]); // the same element, not a copy
		expect(t.pane.lastElementChild).toBe(section);
	});

	it("refreshes on file open (a refresh for another file replaces the rows)", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.answer("@notes:Notes/Idea.md", [edge("@demo:docs/a.pdf", "@notes:Notes/Idea.md", 9)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		t.open("Notes/Idea.md");
		t.section.refresh();
		await settle();
		expect(t.rows()).toEqual(["Sources/demo/docs/a.pdf:9"]);
		expect(t.calls).toEqual([`graph.get_backlinks ${REGISTRY}`, "graph.get_backlinks @notes:Notes/Idea.md"]);
	});

	it("does not ask Tephra again for the file already shown unless forced", async () => {
		const t = setup();
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		t.section.refresh();
		t.section.refresh();
		await settle();
		expect(t.calls).toHaveLength(1);
		t.section.refresh(true);
		await settle();
		expect(t.calls).toHaveLength(2);
	});

	it("discards a stale answer: a slow request for the file the user left never renders under the new one", async () => {
		const t = setup({ manual: true });
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		t.open("Notes/Idea.md");
		t.section.refresh();
		expect(t.pending.map((p) => p.id)).toEqual([REGISTRY, "@notes:Notes/Idea.md"]);
		t.pending[1].resolve([edge("@demo:docs/a.pdf", "@notes:Notes/Idea.md", 2)]);
		await settle();
		t.pending[0].resolve([edge("@demo:scripts/build.sh", REGISTRY, 3)]); // late
		await settle();
		expect(t.rows()).toEqual(["Sources/demo/docs/a.pdf:2"]);
	});

	it("rapid switching across 20 files, answered in reverse, ends on the last file's list", async () => {
		const t = setup({ manual: true });
		for (let i = 0; i < 20; i++) {
			t.open(`Sources/demo/f${i}.rs`);
			t.section.refresh();
		}
		expect(t.pending).toHaveLength(20);
		for (let i = 19; i >= 0; i--) {
			t.pending[i].resolve([edge("@demo:scripts/build.sh", `@demo:f${i}.rs`, i + 1)]);
			await settle(); // one answer at a time, so the arrival order really is 19, 18, ... 0
		}
		expect(t.rows()).toEqual(["Sources/demo/scripts/build.sh:20"]);
		expect(t.sections()).toHaveLength(1);
	});

	it("a failed call leaves the heading with nothing under it and the panel's own children untouched; nothing throws", async () => {
		const t = setup();
		const before = Array.from(t.pane.children).map((c) => c.outerHTML);
		t.setFailing(true);
		t.open("Sources/demo/crates/core/src/registry.rs");
		const errors: unknown[] = [];
		const onError = (e: ErrorEvent) => errors.push(e);
		window.addEventListener("error", onError);
		t.section.refresh();
		await settle();
		window.removeEventListener("error", onError);
		expect(errors).toEqual([]);
		expect(t.sections()[0].textContent).toBe(TEPHRA_SECTION_TITLE);
		expect(t.rows()).toEqual([]);
		expect(Array.from(t.pane.children).slice(0, 2).map((c) => c.outerHTML)).toEqual(before);
	});

	it("lists a code file whose Obsidian cache is {} (not null), as live Obsidian returns it", async () => {
		const t = setup();
		const code = t.app.vault.getAbstractFileByPath("Sources/demo/scripts/build.sh") as TFile;
		expect(t.app.metadataCache.getFileCache(code)).toEqual({});
		t.answer("@demo:docs/guide/Setup.md", [edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md", 4)]);
		t.open("Sources/demo/docs/guide/Setup.md");
		t.section.refresh();
		await settle();
		expect(t.rows()).toEqual(["Sources/demo/scripts/build.sh:4"]);
	});

	it("a markdown file with no cache (not indexed or excluded) is not a note Obsidian indexes, so its edge is listed; one with a cache is not", async () => {
		const t = setup({ unindexedNotes: ["Notes/Idea.md"] });
		t.answer(REGISTRY, [edge("@notes:Notes/Idea.md", REGISTRY, 2), edge("@notes:Weekly Review.md", REGISTRY, 5)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.rows()).toEqual(["Notes/Idea.md:2"]);
	});

	it("shows no section when there is nothing to list", async () => {
		const t = setup();
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.sections()).toHaveLength(0);
	});

	it("a failure after rows were shown replaces them: stale rows never stay under a failed refresh", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.rows()).toHaveLength(1);
		t.setFailing(true);
		t.section.refresh(true);
		await settle();
		expect(t.rows()).toEqual([]);
	});

	it("an edge from an unknown source or a path with no vault file adds no row", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@gone:x.rs", REGISTRY), edge("@demo:no/such.rs", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.sections()).toHaveLength(0);
	});

	it("500 backlinks render in under 200 ms", async () => {
		const t = setup();
		t.answer(REGISTRY, Array.from({ length: 500 }, (_, i) => edge("@demo:scripts/build.sh", REGISTRY, i + 1)));
		t.open("Sources/demo/crates/core/src/registry.rs");
		const start = performance.now();
		t.section.refresh();
		await settle();
		expect(t.rows()).toHaveLength(500);
		expect(performance.now() - start).toBeLessThan(200);
	});
});

describe("opening a row", () => {
	it("a click opens the file at that line (0-based eState.line); a middle-click opens it in a new tab", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY, 3)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		const row = document.querySelector<HTMLElement>(".atlas-tephra-backlink-row")!;
		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		row.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
		await settle();
		expect(t.opened).toEqual([
			{ file: "Sources/demo/scripts/build.sh", state: { eState: { line: 2 } }, newTab: false },
			{ file: "Sources/demo/scripts/build.sh", state: { eState: { line: 2 } }, newTab: true },
		]);
	});

	it("a row without a line opens the file at the top, and a file with no Obsidian view goes to the default app", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY, null), edge("@demo:docs/a.pdf", REGISTRY, null)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		delete t.app.viewRegistry.typeByExtension.pdf;
		const [build, pdf] = Array.from(document.querySelectorAll<HTMLElement>(".atlas-tephra-backlink-row")).reverse();
		build.click();
		pdf.click();
		await settle();
		expect(t.opened).toEqual([{ file: "Sources/demo/scripts/build.sh", state: undefined, newTab: false }]);
		expect(t.app.defaultAppOpens).toEqual(["Sources/demo/docs/a.pdf"]);
	});

	it("a code file reaches its line only while some view is registered for its extension; the registry is read at click time", async () => {
		// Stock Obsidian has no view for `.sh`/`.rs`: the row goes to the default app and the line is lost (an app
		// handed a path can't be told a line). A plugin such as VS Code Workbench registers the extension, and the
		// very same row then opens in Obsidian at the line, with no reload and no Atlas setting involved.
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY, 3)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		const row = document.querySelector<HTMLElement>(".atlas-tephra-backlink-row")!;
		expect(row.textContent).toBe("Sources/demo/scripts/build.sh:3");

		delete t.app.viewRegistry.typeByExtension.sh;
		row.click();
		await settle();
		expect(t.opened).toEqual([]);
		expect(t.app.defaultAppOpens).toEqual(["Sources/demo/scripts/build.sh"]);

		t.app.viewRegistry.typeByExtension.sh = "markdown";
		row.click();
		await settle();
		expect(t.app.defaultAppOpens).toHaveLength(1);
		expect(t.opened).toEqual([{ file: "Sources/demo/scripts/build.sh", state: { eState: { line: 2 } }, newTab: false }]);
	});

	it("opening a path that is no longer a vault file does nothing and creates nothing", async () => {
		const t = setup();
		expect(await openBacklinkRow(t.app, "Sources/demo/gone.rs", 1, false)).toBe(false);
		expect(t.opened).toEqual([]);
	});

	it("writes nothing to the vault", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		const writes = t.app.vault.calls.length;
		t.section.refresh();
		await settle();
		document.querySelector<HTMLElement>(".atlas-tephra-backlink-row")!.click();
		await settle();
		expect(t.app.vault.calls).toHaveLength(writes);
	});
});

describe("the Atlas Links pane fallback (G10)", () => {
	it("with no backlink leaf, the same list goes in the Links pane, and the choice is logged once at debug level", async () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		const t = setup({ leafShape: "none" });
		t.openLinksPane();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY, 3)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		expect(t.section.getMode()).toBe("pane");
		t.section.refresh();
		await settle();
		t.section.refresh(true);
		await settle();
		expect(t.rows(t.linksContent)).toEqual(["Sources/demo/scripts/build.sh:3"]);
		expect(t.linksContent.querySelectorAll(`.${TEPHRA_SECTION_CLASS}`)).toHaveLength(1);
		expect(debug.mock.calls.filter((c) => String(c[0]).includes("Atlas Links pane"))).toHaveLength(1);
	});

	it("when the panel's expected container is missing, it falls back too, and leaves the panel alone", async () => {
		vi.spyOn(console, "debug").mockImplementation(() => {});
		const t = setup({ leafShape: "no-pane" });
		t.openLinksPane();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		expect(t.section.getMode()).toBe("pane");
		t.section.refresh();
		await settle();
		expect(t.rows(t.linksContent)).toHaveLength(1);
		expect(t.pane.querySelector(`.${TEPHRA_SECTION_CLASS}`)).toBeNull();
	});

	it("an empty Links pane says so instead of showing a bare heading", async () => {
		vi.spyOn(console, "debug").mockImplementation(() => {});
		const t = setup({ leafShape: "none" });
		t.openLinksPane();
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.linksContent.textContent).toContain("No links from code, PDF or Office files.");
	});
});

describe("the toggle (G16)", () => {
	it("off: no section, no Tephra call, and what was added is removed; on: it comes back without a reload", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		expect(t.sections()).toHaveLength(1);

		t.setEnabled(false);
		t.section.refresh(true);
		expect(t.sections()).toHaveLength(0);
		expect(t.pane.children).toHaveLength(2);
		const calls = t.calls.length;
		t.open("Notes/Idea.md");
		t.section.refresh();
		t.section.refresh(true);
		await settle();
		expect(t.calls).toHaveLength(calls);

		t.setEnabled(true);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh(true);
		await settle();
		expect(t.sections()).toHaveLength(1);
	});

	it("turning it off while a request is in flight drops that request's answer", async () => {
		const t = setup({ manual: true });
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		t.setEnabled(false);
		t.section.refresh(true);
		t.pending[0].resolve([edge("@demo:scripts/build.sh", REGISTRY)]);
		await settle();
		expect(t.sections()).toHaveLength(0);
	});

	it("detach (plugin unload) removes the section and stops watching the panel", async () => {
		const t = setup();
		t.answer(REGISTRY, [edge("@demo:scripts/build.sh", REGISTRY)]);
		t.open("Sources/demo/crates/core/src/registry.rs");
		t.section.refresh();
		await settle();
		t.section.detach();
		expect(t.sections()).toHaveLength(0);
		t.pane.appendChild(document.createElement("div"));
		await settle();
		expect(t.sections()).toHaveLength(0);
	});
});
