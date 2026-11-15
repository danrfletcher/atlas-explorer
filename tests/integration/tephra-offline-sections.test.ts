import { afterEach, describe, expect, it, vi } from "vitest";
import { tephraStatusLabel } from "../../src/tephra-status-bar";
import { makeSourcesRig, sectionEl, sectionRows, sectionTitles, type SourcesRig } from "../sources-explorer-fixture";

// PR-9 (G13, GP10, E1, F10): the Inbox's sections when Tephra stops, comes back, or has not answered yet. The real
// explorer, `UnitIndex`, `ViewsManager` and `TephraConnection` over the fixture vault; the daemon is the fake
// Tephra server, stopped with `rig.daemon.down` and held with `rig.daemon.gate` (see `tests/sources-explorer-fixture.ts`).

let rig: SourcesRig | null = null;
let release: (() => void) | null = null;
afterEach(async () => {
	release?.(); // never leave a held request behind
	release = null;
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
});

const OFFLINE = "(Tephra offline)";
const LINKS = { tephra: "/vault/Sources/tephra", whoop: "/vault/Sources/whoop" };
const sourceNames = ["tephra", "whoop"];
const unitLists = (r: SourcesRig) => r.daemon.requests.filter((request) => request.method === "unit.list");
const headerOf = (r: SourcesRig, name: string) => sectionEl(r.h, name).querySelector<HTMLElement>(":scope > .atlas-section-header")!;
const vaultHtml = (r: SourcesRig) => sectionEl(r.h, null).outerHTML;

/** Holds every Tephra request until `releaseGate()`: a first check that has not finished. */
function holdRequests(r: SourcesRig): () => void {
	r.daemon.gate = new Promise<void>((resolve) => {
		release = () => {
			r.daemon.gate = null;
			resolve();
		};
	});
	return release!;
}

describe("GP10: Tephra stops, then comes back", () => {
	it("offline adds '(Tephra offline)' to each non-vault header only, keeps their rows, and leaves the vault section's DOM identical", async () => {
		rig = await makeSourcesRig();
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(rig.h.panel().textContent).not.toContain(OFFLINE);
		const online = {
			vault: vaultHtml(rig),
			tephraRows: sectionRows(sectionEl(rig.h, "tephra")),
			whoopRows: sectionRows(sectionEl(rig.h, "whoop")),
		};
		expect(online.tephraRows.length).toBeGreaterThan(0);
		expect(online.whoopRows.length).toBeGreaterThan(0);

		rig.daemon.down = true;
		const unitListsBefore = unitLists(rig).length;
		await rig.check();

		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		for (const name of sourceNames) {
			expect(headerOf(rig, name).textContent).toContain(OFFLINE);
			expect(headerOf(rig, name).classList.contains("is-tephra-offline")).toBe(true);
			expect(headerOf(rig, name).textContent).not.toContain("(missing)");
		}
		// rows kept, not blanked
		expect(sectionRows(sectionEl(rig.h, "tephra"))).toEqual(online.tephraRows);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(online.whoopRows);
		// the vault section: no label and the very same DOM
		expect(sectionEl(rig.h, null).textContent).not.toContain(OFFLINE);
		expect(vaultHtml(rig)).toBe(online.vault);
		// no unit.list was asked of a Tephra that is down
		expect(unitLists(rig).length).toBe(unitListsBefore);
	});

	it("coming back online removes the labels, lists the units again and leaves the vault section's DOM identical", async () => {
		rig = await makeSourcesRig();
		const vaultOnline = vaultHtml(rig);
		const rowsOnline = sectionRows(sectionEl(rig.h, "whoop"));
		rig.daemon.down = true;
		await rig.check();
		expect(rig.h.panel().textContent).toContain(OFFLINE);

		rig.daemon.down = false;
		const unitListsBefore = unitLists(rig).length;
		await rig.check();

		expect(rig.h.panel().textContent).not.toContain(OFFLINE);
		expect(rig.h.panel().querySelectorAll(".is-tephra-offline")).toHaveLength(0);
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(sectionRows(sectionEl(rig.h, "whoop"))).toEqual(rowsOnline);
		expect(vaultHtml(rig)).toBe(vaultOnline);
		expect(unitLists(rig).length).toBeGreaterThan(unitListsBefore); // the lists are fetched again
	});

	it("both flips go on screen as one swap: the pane is never emptied or half-built between the old DOM and the new", async () => {
		rig = await makeSourcesRig();
		const panel = rig.h.panel();
		const swap = vi.spyOn(panel, "replaceChildren");
		const mutations: MutationRecord[] = [];
		const observer = new MutationObserver((records) => mutations.push(...records));
		observer.observe(panel, { childList: true });
		const swaps = (): MutationRecord[] => [...mutations, ...observer.takeRecords()];

		for (const down of [true, false]) {
			swap.mockClear();
			mutations.length = 0;
			observer.takeRecords();
			rig.daemon.down = down;
			await rig.check();
			// one `replaceChildren` of the complete staged pane (the committed render's swap) ...
			expect(swap).toHaveBeenCalledTimes(1);
			const incoming = (swap.mock.calls[0] as unknown as Node[]).filter((node): node is HTMLElement => node instanceof HTMLElement);
			expect(incoming.some((el) => el.classList.contains("atlas-explorer-scroll"))).toBe(true);
			// ... and no record that only removes: every removal comes with its replacement
			const records = swaps();
			expect(records.length).toBeGreaterThan(0);
			for (const record of records) {
				if (record.removedNodes.length > 0) expect(record.addedNodes.length).toBeGreaterThan(0);
			}
			expect(panel.querySelector(".atlas-explorer-scroll")).not.toBeNull();
			expect(panel.textContent?.includes(OFFLINE)).toBe(down);
		}
		observer.disconnect();
	});

	it("a render with nothing new (the same state again) leaves the live pane alone", async () => {
		rig = await makeSourcesRig();
		rig.daemon.down = true;
		await rig.check();
		const panel = rig.h.panel();
		const scroll = panel.querySelector(".atlas-explorer-scroll");
		const swap = vi.spyOn(panel, "replaceChildren");
		await rig.check(); // down again: no change event, no new render
		await rig.h.render(); // a render nothing changed for: staged, compared, thrown away
		expect(swap).not.toHaveBeenCalled();
		expect(panel.querySelector(".atlas-explorer-scroll")).toBe(scroll);
		expect(panel.textContent).toContain(OFFLINE);
	});

	it("F1: nothing is written to data.json for any of it", async () => {
		rig = await makeSourcesRig({ settings: { tephraLinks: LINKS } });
		const before = JSON.stringify(rig.settings);
		const flush = rig.plugin.flushSave as ReturnType<typeof vi.fn>;
		rig.daemon.down = true;
		await rig.check();
		rig.daemon.down = false;
		await rig.check();
		expect(JSON.stringify(rig.settings)).toBe(before);
		expect(flush).not.toHaveBeenCalled();
	});
});

describe("E1: Tephra offline at startup", () => {
	it("the vault section draws, the sources show their headers '(Tephra offline)' with no rows, and nothing throws", async () => {
		rig = await makeSourcesRig({ down: true, settings: { tephraLinks: LINKS } });
		expect(rig.connection.getSnapshot()).toMatchObject({ state: "offline", checked: true });
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["Leg Day", "README", "Weekly Review"]);
		for (const name of sourceNames) {
			expect(headerOf(rig, name).textContent).toContain(OFFLINE);
			expect(sectionRows(sectionEl(rig.h, name))).toEqual([]);
		}
		expect(sectionEl(rig.h, null).textContent).not.toContain(OFFLINE);
		expect(unitLists(rig)).toEqual([]);
	});
});

describe("R3: before the first answer the Inbox does not guess offline (the status bar says 'checking…')", () => {
	it("unchecked with Tephra running: only the vault section, no label; the answer then adds the sections, unlabelled", async () => {
		rig = await makeSourcesRig({ settings: { tephraLinks: LINKS } });
		const answerLater = holdRequests(rig);
		rig.connection.stop();
		rig.connection.start(); // unchecked again, its first `source.list` held
		await rig.settle();

		expect(rig.connection.getSnapshot()).toMatchObject({ state: "offline", checked: false });
		expect(tephraStatusLabel(rig.connection.getSnapshot(), false)?.kind).toBe("checking");
		expect(sectionTitles(rig.h)).toEqual(["Inbox"]);
		expect(rig.h.panel().textContent).not.toContain(OFFLINE);
		expect(rig.h.panel().querySelectorAll(".atlas-inbox-source")).toHaveLength(0);
		// the vault section is drawn as it is with the toggle off
		expect(sectionRows(sectionEl(rig.h, null))).toEqual(["Leg Day", "README", "Weekly Review"]);

		answerLater();
		await rig.connection.check(); // joins the held check
		await rig.settle();
		expect(rig.connection.getSnapshot()).toMatchObject({ state: "online", checked: true });
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		expect(rig.h.panel().textContent).not.toContain(OFFLINE);
		expect(sectionRows(sectionEl(rig.h, "whoop")).length).toBeGreaterThan(0);
	});

	it("unchecked, then the first answer is a failure: the sections appear, now labelled '(Tephra offline)'", async () => {
		rig = await makeSourcesRig({ settings: { tephraLinks: LINKS } });
		const answerLater = holdRequests(rig);
		rig.connection.stop();
		rig.connection.start();
		await rig.settle();
		expect(sectionTitles(rig.h)).toEqual(["Inbox"]);

		rig.daemon.down = true;
		answerLater();
		await rig.connection.check();
		await rig.settle();
		expect(rig.connection.getSnapshot()).toMatchObject({ state: "offline", checked: true });
		expect(tephraStatusLabel(rig.connection.getSnapshot(), false)?.kind).toBe("offline");
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
		for (const name of sourceNames) expect(headerOf(rig, name).textContent).toContain(OFFLINE);
	});

	it("unchecked: nothing is asked of Tephra for a section list and the vault section is the one it always was", async () => {
		rig = await makeSourcesRig({ settings: { tephraLinks: LINKS } });
		const vaultOnline = vaultHtml(rig);
		holdRequests(rig);
		rig.connection.stop();
		rig.daemon.requests.length = 0;
		rig.connection.start();
		await rig.settle();
		expect(unitLists(rig)).toEqual([]);
		// The only difference is the sticky-stack offset (`--atlas-section-bottom`) a section carries while others
		// stack under it; alone, the vault section has none. Its header and rows are the same.
		const withoutStickyOffset = (html: string) => html.replace(/ style="--atlas-section-bottom: [^"]*"/, "");
		expect(withoutStickyOffset(vaultHtml(rig))).toBe(withoutStickyOffset(vaultOnline));
	});
});
