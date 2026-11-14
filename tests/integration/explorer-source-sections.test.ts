import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import type { TephraSource } from "../../src/tephra-client";
import type { TephraCallResult } from "../../src/tephra-client";

// PR-4 (G1, E5, E12): the real `AtlasExplorerView.render()` with the Tephra toggle on and a stand-in connection.
// The harness stubs only the bucket rows, the toolbar and the unit lookups; the sections, their headers, the
// per-section windows and the sticky wiring are the shipped code.

const entry = (name: string, kind: "folder" | "markdown") => ({ id: name, name, rel_path: name, kind, size: 1, mtime: 1 });

interface Fake {
	sources: TephraSource[];
	listings: Record<string, unknown>;
	calls: Array<{ method: string; params: unknown }>;
	state: "online" | "offline";
}

function plug(h: SectionHarness, fake: Fake): void {
	const plugin = (h.explorer as unknown as { plugin: Record<string, unknown> }).plugin;
	plugin.settings = { tephraEnabled: true };
	plugin.tephraConnection = {
		getSnapshot: () => ({ state: fake.state, checked: true, sources: fake.state === "online" ? fake.sources : [] }),
		call: async (method: string, params: unknown): Promise<TephraCallResult> => {
			fake.calls.push({ method, params });
			const name = (params as { source: string }).source;
			if (!(name in fake.listings)) return { ok: false, error: { kind: "rpc", message: "no such source" } } as unknown as TephraCallResult;
			return { ok: true, result: fake.listings[name] } as unknown as TephraCallResult;
		},
	};
	// The harness's `getInboxUnits` ignores its input and returns the vault's units. A real one filters what it is
	// given, so for the listed units (a different array) it hands them straight back.
	const vm = (plugin.viewsManager as { getInboxUnits: (units: unknown[]) => unknown[] });
	const vaultUnits = h.state.units;
	vm.getInboxUnits = (units) => (units === vaultUnits ? vaultUnits : units);
}

const listing = (...entries: ReturnType<typeof entry>[]) => ({ source: "x", folder: "", recursive: false, offline: false, needs_rescan: false, entries });
const titles = (h: SectionHarness) => [...h.panel().querySelectorAll(".atlas-inbox > .atlas-section-header .atlas-section-title")].map((el) => el.textContent);
/** A click re-renders with an unawaited `void this.render()`; let it finish before reading the DOM. */
const settle = async (h: SectionHarness) => {
	await (h.explorer as unknown as { awaitRenderSettled: () => Promise<void> }).awaitRenderSettled();
};
const rowsOf = (section: Element) => [...section.querySelectorAll(".atlas-inbox-spacer .atlas-row")].map((el) => el.textContent ?? "");

let h: SectionHarness | null = null;
afterEach(() => {
	vi.restoreAllMocks();
	h?.teardown();
	h = null;
	Platform.isMobile = false;
});

describe("Inbox sections per Tephra source (G1)", () => {
	it("toggle on: the vault's Inbox first, then one `[name]` section per source in A-Z order, rows from unit.list", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 4 });
		const fake: Fake = {
			state: "online",
			calls: [],
			sources: [
				{ name: "tephra", path: "/t", status: "online" },
				{ name: "notes", path: "/vault", status: "online" },
				{ name: "alpha", path: "/a", status: "online" },
			],
			listings: { tephra: listing(entry("README.md", "markdown"), entry("crates", "folder")), alpha: listing() },
		};
		plug(h, fake);
		await h.render();

		expect(titles(h)).toEqual(["Inbox", "[alpha]", "[tephra]"]);
		const sections = [...h.panel().querySelectorAll<HTMLElement>(".atlas-inbox")];
		expect(sections[0].classList.contains("atlas-inbox-source")).toBe(false);
		expect(rowsOf(sections[0])).toHaveLength(4);
		expect(rowsOf(sections[1])).toEqual([]);
		expect(rowsOf(sections[2]).join("|")).toContain("README.md");
		expect(rowsOf(sections[2]).join("|")).toContain("crates");
		// one `unit.list` per listed source, none for the vault ("notes")
		expect(fake.calls.map((c) => (c.params as { source: string }).source).sort()).toEqual(["alpha", "tephra"]);
		expect(fake.calls.every((c) => c.method === "unit.list")).toBe(true);
	});

	it("the source header has the count, no This view/Global toggle, and its own '+'", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 2 });
		plug(h, { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown"), entry("b.md", "markdown")) } });
		await h.render();
		const [vault, source] = [...h.panel().querySelectorAll<HTMLElement>(".atlas-inbox")];
		expect(vault.querySelector(".atlas-inbox-mode-btn")).not.toBeNull();
		expect(source.querySelector(".atlas-inbox-mode-btn")).toBeNull();
		expect(source.querySelector(".atlas-count-badge")?.textContent).toBe("2");
		expect(source.dataset.source).toBe("tephra");
	});

	it("collapsing one section leaves the others open, and the state is not persisted anywhere", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 2 });
		plug(h, { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown")) } });
		await h.render();
		const sourceChevron = h.panel().querySelector<HTMLElement>(".atlas-inbox-source > .atlas-section-header > .atlas-chevron")!;
		sourceChevron.click();
		const [vault, source] = [...h.panel().querySelectorAll<HTMLElement>(".atlas-inbox")];
		expect(source.classList.contains("is-collapsed")).toBe(true);
		expect(vault.classList.contains("is-collapsed")).toBe(false);
		// a re-render (a change anywhere) keeps the collapse
		await h.render();
		expect(h.panel().querySelector(".atlas-inbox-source")!.classList.contains("is-collapsed")).toBe(true);
	});

	it("E5: a source Tephra lists as missing keeps its header, says so, and has no rows and no unit.list call", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "gone", path: "/gone", status: "missing" }], listings: { gone: listing(entry("old.md", "markdown")) } };
		plug(h, fake);
		await h.render();
		const source = h.panel().querySelector<HTMLElement>(".atlas-inbox-source")!;
		expect(source.querySelector(".atlas-section-title")?.textContent).toBe("[gone]");
		expect(source.textContent).toContain("(missing)");
		expect(source.querySelector(".atlas-section-header")!.classList.contains("is-missing")).toBe(true);
		expect(rowsOf(source)).toEqual([]);
		expect(fake.calls).toEqual([]);
	});

	it("E5: a unit.list answer that says offline (folder gone since the last scan) is shown the same way", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		plug(h, { state: "online", calls: [], sources: [{ name: "x", path: "/x", status: "online" }], listings: { x: { entries: [], offline: true } } });
		await h.render();
		const source = h.panel().querySelector<HTMLElement>(".atlas-inbox-source")!;
		expect(source.textContent).toContain("(missing)");
		expect(rowsOf(source)).toEqual([]);
	});

	it("Tephra not running: just the vault's Inbox, nothing marked missing (offline is PR-9's)", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 2 });
		plug(h, { state: "offline", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: {} });
		await h.render();
		expect(titles(h)).toEqual(["Inbox"]);
		expect(h.panel().textContent).not.toContain("(missing)");
	});

	it("a unit.list that fails gives the source an empty section, not an error or a missing mark", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		plug(h, { state: "online", calls: [], sources: [{ name: "broken", path: "/b", status: "online" }], listings: {} });
		await h.render();
		const source = h.panel().querySelector<HTMLElement>(".atlas-inbox-source")!;
		expect(rowsOf(source)).toEqual([]);
		expect(source.textContent).not.toContain("(missing)");
	});

	it("the vault source name `notes` never gets a section, and a source called `..` is ignored", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		plug(h, { state: "online", calls: [], sources: [{ name: "notes", path: "/v", status: "online" }, { name: "..", path: "/x", status: "online" }], listings: {} });
		await h.render();
		expect(titles(h)).toEqual(["Inbox"]);
	});

	it("mobile: Tephra is never asked, the Inbox is the plain one", async () => {
		Platform.isMobile = true;
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown")) } };
		plug(h, fake);
		await h.render();
		expect(titles(h)).toEqual(["Inbox"]);
		expect(fake.calls).toEqual([]);
	});

	it("E12: every section draws only its own window; a long source does not render all its rows", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		const many = Array.from({ length: 500 }, (_, i) => entry(`f${String(i).padStart(3, "0")}.md`, "markdown"));
		plug(h, { state: "online", calls: [], sources: [{ name: "big", path: "/b", status: "online" }], listings: { big: listing(...many) } });
		await h.render();
		const source = h.panel().querySelector<HTMLElement>(".atlas-inbox-source")!;
		const drawn = rowsOf(source).length;
		expect(drawn).toBeGreaterThan(0);
		expect(drawn).toBeLessThan(100);
		expect(source.querySelector(".atlas-count-badge")?.textContent).toBe("500");
	});

	it("a render keeps nothing between calls: a changed listing shows at the next render", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown")) } };
		plug(h, fake);
		await h.render();
		expect(h.panel().querySelector(".atlas-inbox-source .atlas-count-badge")?.textContent).toBe("1");
		fake.listings.tephra = listing(entry("a.md", "markdown"), entry("b.md", "markdown"));
		await h.render();
		expect(h.panel().querySelector(".atlas-inbox-source .atlas-count-badge")?.textContent).toBe("2");
		expect(fake.calls).toHaveLength(2);
	});

	it("with the toggle on but no sources the Inbox is byte-identical to the toggle-off one", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 5 });
		await h.render();
		const off = h.panel().innerHTML;
		plug(h, { state: "online", calls: [], sources: [], listings: {} });
		await h.render();
		expect(h.panel().innerHTML).toBe(off);
	});

	it("F1/G16: with the toggle off Tephra is never called, even with a connection present", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 2 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown")) } };
		plug(h, fake);
		const plugin = (h.explorer as unknown as { plugin: { settings: { tephraEnabled: boolean }; tephraConnection: { getSnapshot: () => unknown } } }).plugin;
		plugin.settings.tephraEnabled = false;
		const snapshotSpy = vi.spyOn(plugin.tephraConnection, "getSnapshot");
		await h.render();
		expect(titles(h)).toEqual(["Inbox"]);
		expect(fake.calls).toEqual([]);
		expect(snapshotSpy).not.toHaveBeenCalled();
	});

	it("a source's title click lands on its stuck position (scrolls), like the Inbox's", async () => {
		h = makeSectionHarness({ bucketRows: 60, inboxRows: 25 }); // long enough that the target is not the top
		plug(h, { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown")) } });
		await h.render();
		h.panel().querySelector<HTMLElement>(".atlas-inbox-source .atlas-section-title")!.click();
		expect(h.scrollCalls).toHaveLength(1);
		expect(h.scrollCalls[0].top).toBeGreaterThan(0);
	});

	it("two sections with a README.md each: both rows show, with separate selection keys by full vault path", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 0 });
		plug(h, {
			state: "online",
			calls: [],
			sources: [{ name: "tephra", path: "/t", status: "online" }, { name: "docs", path: "/d", status: "online" }],
			listings: { tephra: listing(entry("README.md", "markdown")), docs: listing(entry("README.md", "markdown")) },
		});
		await h.render();
		const keys = [...h.panel().querySelectorAll<HTMLElement>(".atlas-inbox-source .atlas-row")].map((el) => el.dataset.selectKey);
		expect(keys.sort()).toEqual(["file:Sources/docs/README.md", "file:Sources/tephra/README.md"]);
	});

	it("shift-click selects a range inside one section and never crosses into another", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 0 });
		plug(h, {
			state: "online",
			calls: [],
			sources: [{ name: "a", path: "/a", status: "online" }, { name: "b", path: "/b", status: "online" }],
			listings: {
				a: listing(entry("a1.md", "markdown"), entry("a2.md", "markdown"), entry("a3.md", "markdown")),
				b: listing(entry("b1.md", "markdown"), entry("b2.md", "markdown")),
			},
		});
		await h.render();
		const row = (path: string) => h.panel().querySelector<HTMLElement>(`[data-select-key="file:${path}"]`)!;
		const click = (el: HTMLElement, shiftKey = false) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey, ctrlKey: !shiftKey }));
		click(row("Sources/a/a1.md")); // ctrl-click sets the anchor
		await settle(h);
		click(row("Sources/a/a3.md"), true);
		await settle(h);
		const selected = () => [...h.panel().querySelectorAll<HTMLElement>(".atlas-row.is-selected")].map((el) => el.dataset.selectKey).sort();
		expect(selected()).toEqual(["file:Sources/a/a1.md", "file:Sources/a/a2.md", "file:Sources/a/a3.md"]);
		// a shift-click in the other section, anchor still in `a`: the range stays in `a` (anchor to the edge facing `b`)
		click(row("Sources/b/b2.md"), true);
		await settle(h);
		expect(selected()).toEqual(["file:Sources/a/a1.md", "file:Sources/a/a2.md", "file:Sources/a/a3.md"]);
		expect(selected().some((key) => key.startsWith("file:Sources/b/"))).toBe(false);
	});

	it("shift-click from a source section back toward the vault section selects only the source's rows above the anchor", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 3 });
		plug(h, {
			state: "online",
			calls: [],
			sources: [{ name: "a", path: "/a", status: "online" }],
			listings: { a: listing(entry("a1.md", "markdown"), entry("a2.md", "markdown"), entry("a3.md", "markdown")) },
		});
		await h.render();
		const row = (path: string) => h.panel().querySelector<HTMLElement>(`[data-select-key="file:${path}"]`)!;
		const click = (el: HTMLElement, shiftKey = false) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey, ctrlKey: !shiftKey }));
		click(row("Sources/a/a2.md"));
		await settle(h);
		click(row("inbox/00001.md"), true);
		await settle(h);
		const selected = [...h.panel().querySelectorAll<HTMLElement>(".atlas-row.is-selected")].map((el) => el.dataset.selectKey).sort();
		expect(selected).toEqual(["file:Sources/a/a1.md", "file:Sources/a/a2.md"]);
	});

	it("overlapping renders: a superseded render draws no section and the later one wins", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 1 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "slow", path: "/s", status: "online" }], listings: { slow: listing(entry("old.md", "markdown")) } };
		plug(h, fake);
		const plugin = (h.explorer as unknown as { plugin: { tephraConnection: { call: (m: string, p: unknown) => Promise<unknown> } } }).plugin;
		const realCall = plugin.tephraConnection.call;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let reachTephra: () => void = () => {};
		const firstCallMade = new Promise<void>((resolve) => (reachTephra = resolve));
		let first = true;
		plugin.tephraConnection.call = async (method, params) => {
			if (first) {
				first = false;
				const answer = await realCall(method, params); // the old listing
				reachTephra();
				await gate; // this render's unit.list is still in flight
				return answer;
			}
			return realCall(method, params);
		};
		const drawn = vi.spyOn(h.explorer as unknown as { renderInboxSection: () => Promise<void> }, "renderInboxSection");
		const firstRender = h.render();
		await firstCallMade;
		fake.listings.slow = listing(entry("new.md", "markdown"));
		await h.render(); // supersedes the first one, which is still waiting on Tephra
		release();
		await firstRender;
		// only the second render drew sections (the vault's and `slow`); the superseded one drew none
		expect(drawn).toHaveBeenCalledTimes(2);
		const sections = h.panel().querySelectorAll(".atlas-inbox-source");
		expect(sections).toHaveLength(1);
		expect(sections[0].textContent).toContain("new.md");
		expect(sections[0].textContent).not.toContain("old.md");
	});

	it("a source appearing in Tephra's list shows on the next render without a reload, keeping the scroll position", async () => {
		h = makeSectionHarness({ bucketRows: 60, inboxRows: 25 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "tephra", path: "/t", status: "online" }], listings: { tephra: listing(entry("a.md", "markdown")), later: listing() } };
		plug(h, fake);
		await h.render();
		h.scrollTo(400);
		fake.sources.push({ name: "later", path: "/l", status: "online" });
		await h.render();
		expect(titles(h)).toEqual(["Inbox", "[later]", "[tephra]"]);
		expect(h.body().scrollTop).toBe(400);
	});

	it("a source's folder coming back (status missing to online) turns its rows on again by itself", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 0 });
		const fake: Fake = { state: "online", calls: [], sources: [{ name: "x", path: "/x", status: "missing" }], listings: { x: listing(entry("a.md", "markdown")) } };
		plug(h, fake);
		await h.render();
		expect(h.panel().textContent).toContain("(missing)");
		fake.sources[0].status = "online";
		await h.render();
		expect(h.panel().textContent).not.toContain("(missing)");
		expect(rowsOf(h.panel().querySelector(".atlas-inbox-source")!)).toHaveLength(1);
	});

	// E12. The spec's "a scroll frame stays under 16 ms" is checked as the work a frame does, not as wall-clock
	// time: a timer assertion under a loaded full-suite run measured 49 ms for the same code that takes well under
	// 1 ms alone, so it failed for reasons that had nothing to do with the code. A frame's cost here is the rows it
	// builds (each `renderInboxRow` call is one row of DOM), and that is what is bounded.
	const WINDOW_ROWS = Math.ceil(300 / 28) + 1 + 2 * 8; // the harness's 300 px body, 28 px rows, 8 rows of overscan each side

	/** Scrolls an N-item source end to end in 97 px frames; the rows each frame built, and the most rows ever drawn. */
	async function scrollSource(total: number) {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 0 });
		const many = Array.from({ length: total }, (_, i) => entry(`item-${String(i).padStart(4, "0")}.md`, "markdown"));
		plug(h, { state: "online", calls: [], sources: [{ name: "big", path: "/b", status: "online" }], listings: { big: listing(...many) } });
		const built = vi.spyOn(AtlasExplorerView.prototype as unknown as { renderInboxRow: (...args: unknown[]) => HTMLElement }, "renderInboxRow");
		await h.render();
		const source = h.panel().querySelector<HTMLElement>(".atlas-inbox-source")!;
		// The harness clamps a scroll to its first list's length, so write the position the way a browser would.
		const scrollBody = h.body() as HTMLElement & { _scrollTop?: number };
		const scrollTo = (top: number) => {
			scrollBody._scrollTop = top;
			scrollBody.dispatchEvent(new Event("scroll"));
		};
		const maxScroll = total * 28 - 300; // the harness measures only the first list, so the end is computed here
		const perFrame: number[] = [];
		let mostDrawn = 0;
		for (let top = 0; top <= maxScroll; top += 97) {
			const before = built.mock.calls.length;
			scrollTo(top);
			perFrame.push(built.mock.calls.length - before);
			mostDrawn = Math.max(mostDrawn, rowsOf(source).length);
		}
		scrollTo(maxScroll);
		return { source, perFrame, mostDrawn, scrollTo, maxScroll };
	}

	it("E12: scrolling an 800-item source builds at most one window of rows per frame and never draws more than a window", async () => {
		const { source, perFrame, mostDrawn } = await scrollSource(800);
		expect(perFrame.length).toBeGreaterThan(50);
		expect(Math.max(...perFrame)).toBeLessThanOrEqual(WINDOW_ROWS);
		expect(mostDrawn).toBeLessThanOrEqual(WINDOW_ROWS);
		// the last rows are reached with no gap at the end
		expect(rowsOf(source).join("|")).toContain("item-0799.md");
	});

	it("E12: a frame's work does not grow with the source - 800 items cost each frame what 80 do", async () => {
		const small = await scrollSource(80);
		h.teardown();
		const large = await scrollSource(800);
		expect(Math.max(...large.perFrame)).toBeLessThanOrEqual(Math.max(...small.perFrame));
		expect(large.mostDrawn).toBeLessThanOrEqual(small.mostDrawn);
	});

	it("E12: a scroll that stays inside the drawn window builds no rows", async () => {
		const { perFrame, scrollTo } = await scrollSource(800);
		const built = vi.spyOn(AtlasExplorerView.prototype as unknown as { renderInboxRow: (...args: unknown[]) => HTMLElement }, "renderInboxRow");
		built.mockClear();
		scrollTo(2000);
		const afterJump = built.mock.calls.length;
		scrollTo(2001); // one pixel: the same rows are wanted
		expect(built.mock.calls.length).toBe(afterJump);
		expect(perFrame.some((n) => n === 0)).toBe(true);
	});
});
