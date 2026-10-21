import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidianMock from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ATLAS_SORT_AZ_ICON_ID } from "../../src/sort";
import type { StatusGovernance } from "../../src/types";
import { makeSectionHarness } from "../explorer-header-fixtures";

// PR-2 (G13): the sort indicator — a small icon + tooltip on a Folder row (or the Bucket header)
// whose children are actually sorted by something other than Manual. `renderSortIndicator` is a
// thin, almost-pure method, so most of these call it directly rather than through a full render.
const proto = AtlasExplorerView.prototype as unknown as {
	renderSortIndicator: (container: HTMLElement, ownGovernance: Pick<StatusGovernance, "sortMode" | "sortReverse">, statusGovernor: StatusGovernance | null) => void;
};

function render(governance: Pick<StatusGovernance, "sortMode" | "sortReverse">, statusGovernor: StatusGovernance | null = null): { el: HTMLElement; setIconSpy: ReturnType<typeof vi.spyOn>; setTooltipSpy: ReturnType<typeof vi.spyOn> } {
	const setIconSpy = vi.spyOn(obsidianMock, "setIcon");
	const setTooltipSpy = vi.spyOn(obsidianMock, "setTooltip");
	const container = document.createElement("div");
	proto.renderSortIndicator.call({}, container, governance, statusGovernor);
	return { el: container, setIconSpy, setTooltipSpy };
}

describe("PR-2 G13 — the sort indicator's icon and tooltip, per mode and direction", () => {
	// vi.spyOn on a namespace import mutates the shared module object; restore after every test
	// in this file so other suites' default (no-op) setIcon/setTooltip aren't left spied on.
	afterEach(() => vi.restoreAllMocks());

	it("A-Z: resolves to Atlas's own registered sort-az icon id, 'Sorted: A-Z' tooltip", () => {
		const { el, setIconSpy, setTooltipSpy } = render({ sortMode: "alphabetical" });
		const icon = el.querySelector(".atlas-sort-indicator") as HTMLElement;
		expect(icon).toBeTruthy();
		// PR-2 (T1/T5/T9/T12): neither the hyphenated "arrow-down-a-z" (doesn't exist), the bare
		// "arrow-down-az", nor the lucide-prefixed "lucide-arrow-down-az" ever rendered anything
		// through setIcon()/MenuItem.setIcon() in the real Obsidian build — all three left the
		// indicator an empty 0x0 element across three fix rounds. Atlas now registers its own
		// icon id via addIcon() (see registerSortIcons() in sort.ts) and points here at that id.
		expect(setIconSpy).toHaveBeenCalledWith(icon, ATLAS_SORT_AZ_ICON_ID);
		expect(setTooltipSpy).toHaveBeenCalledWith(icon, "Sorted: A-Z");
	});

	it("A-Z reversed: Z-A tooltip, same icon", () => {
		const { el, setTooltipSpy } = render({ sortMode: "alphabetical", sortReverse: true });
		expect(setTooltipSpy).toHaveBeenCalledWith(el.querySelector(".atlas-sort-indicator"), "Sorted: Z-A");
	});

	it("Modified: clock icon, newest/oldest first tooltip per direction", () => {
		const newest = render({ sortMode: "modified" });
		expect(newest.setIconSpy).toHaveBeenCalledWith(newest.el.querySelector(".atlas-sort-indicator"), "clock");
		expect(newest.setTooltipSpy).toHaveBeenCalledWith(newest.el.querySelector(".atlas-sort-indicator"), "Sorted: Modified, newest first");

		const oldest = render({ sortMode: "modified", sortReverse: true });
		expect(oldest.setTooltipSpy).toHaveBeenCalledWith(oldest.el.querySelector(".atlas-sort-indicator"), "Sorted: Modified, oldest first");
	});

	it("Time added: calendar-plus icon, newest/oldest first tooltip per direction", () => {
		const newest = render({ sortMode: "time-added" });
		expect(newest.setIconSpy).toHaveBeenCalledWith(newest.el.querySelector(".atlas-sort-indicator"), "calendar-plus");
		expect(newest.setTooltipSpy).toHaveBeenCalledWith(newest.el.querySelector(".atlas-sort-indicator"), "Sorted: Time added, newest first");

		const oldest = render({ sortMode: "time-added", sortReverse: true });
		expect(oldest.setTooltipSpy).toHaveBeenCalledWith(oldest.el.querySelector(".atlas-sort-indicator"), "Sorted: Time added, oldest first");
	});

	it("Status (explicit, own): list-ordered icon, 'Status'/'Status, reversed' tooltip per direction", () => {
		const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" };
		const forward = render({ sortMode: "status" }, governor);
		expect(forward.setIconSpy).toHaveBeenCalledWith(forward.el.querySelector(".atlas-sort-indicator"), "list-ordered");
		expect(forward.setTooltipSpy).toHaveBeenCalledWith(forward.el.querySelector(".atlas-sort-indicator"), "Sorted: Status");

		const reversed = render({ sortMode: "status", sortReverse: true }, governor);
		expect(reversed.setTooltipSpy).toHaveBeenCalledWith(reversed.el.querySelector(".atlas-sort-indicator"), "Sorted: Status, reversed");
	});

	it("E5: Status (inherited) — no own setting, following a reaching status governor — shows the same list-ordered icon", () => {
		const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status", sortReverse: true };
		const { el, setIconSpy, setTooltipSpy } = render({}, governor);
		const icon = el.querySelector(".atlas-sort-indicator") as HTMLElement;
		expect(icon).toBeTruthy();
		expect(setIconSpy).toHaveBeenCalledWith(icon, "list-ordered");
		expect(setTooltipSpy).toHaveBeenCalledWith(icon, "Sorted: Status, reversed");
	});

	it("PR-2 R6: a stale own Status (statuses switched off, so no governor reaches the list) shows no indicator — the render pass leaves those rows in manual order", () => {
		const { el } = render({ sortMode: "status" }, null);
		expect(el.querySelector(".atlas-sort-indicator")).toBeNull();
	});

	it("Manual (explicit): no indicator at all", () => {
		const { el } = render({ sortMode: "manual" });
		expect(el.querySelector(".atlas-sort-indicator")).toBeNull();
	});

	it("absent own setting, no governor reachable: no indicator (effectively Manual)", () => {
		const { el } = render({}, null);
		expect(el.querySelector(".atlas-sort-indicator")).toBeNull();
	});

	it("explicit Manual beats an inherited status governor: no indicator, rows are in manual order (G19/E5)", () => {
		const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
		const { el } = render({ sortMode: "manual" }, governor);
		expect(el.querySelector(".atlas-sort-indicator")).toBeNull();
	});
});

describe("PR-2 G13 — the Bucket header carries the same indicator as a Folder row", () => {
	afterEach(() => vi.restoreAllMocks());

	it("shows the icon and tooltip when the view root itself is sorted", async () => {
		const h = makeSectionHarness();
		const plugin = (h.explorer as unknown as { plugin: { viewsManager: { getActiveView: () => unknown }; statusesManager: { findSortGovernor: () => StatusGovernance | null } } }).plugin;
		plugin.viewsManager.getActiveView = () => ({ id: "v1", name: "Actionable", inboxMode: "view", root: [], sortMode: "alphabetical" });
		plugin.statusesManager = { findSortGovernor: () => null };
		const setIconSpy = vi.spyOn(obsidianMock, "setIcon");
		await h.render();
		const icon = h.bucketHeader().querySelector(".atlas-sort-indicator") as HTMLElement;
		expect(icon).toBeTruthy();
		expect(setIconSpy).toHaveBeenCalledWith(icon, ATLAS_SORT_AZ_ICON_ID);
		h.teardown();
	});

	it("shows no icon when the view root is Manual (no own sortMode, no reaching status governor)", async () => {
		const h = makeSectionHarness();
		(h.explorer as unknown as { plugin: { statusesManager: { findSortGovernor: () => StatusGovernance | null } } }).plugin.statusesManager = {
			findSortGovernor: () => null,
		};
		await h.render();
		expect(h.bucketHeader().querySelector(".atlas-sort-indicator")).toBeNull();
		h.teardown();
	});

	it("switching the active view shows that view's own root indicator, not the previous view's", async () => {
		const h = makeSectionHarness();
		let activeView: { id: string; name: string; inboxMode: "view"; root: unknown[]; sortMode?: "manual" | "modified" } = { id: "v1", name: "Actionable", inboxMode: "view", root: [], sortMode: "modified" };
		const plugin = (h.explorer as unknown as { plugin: { viewsManager: { getActiveView: () => unknown }; statusesManager: { findSortGovernor: () => StatusGovernance | null } } }).plugin;
		plugin.viewsManager.getActiveView = () => activeView;
		plugin.statusesManager = { findSortGovernor: () => null };
		const setIconSpy = vi.spyOn(obsidianMock, "setIcon");

		await h.render();
		expect(setIconSpy).toHaveBeenCalledWith(h.bucketHeader().querySelector(".atlas-sort-indicator"), "clock");

		setIconSpy.mockClear();
		activeView = { id: "v2", name: "Other", inboxMode: "view" as const, root: [], sortMode: "manual" as const }; // the "other view" has no sort at all
		await h.render();
		expect(h.bucketHeader().querySelector(".atlas-sort-indicator")).toBeNull();

		h.teardown();
	});
});
