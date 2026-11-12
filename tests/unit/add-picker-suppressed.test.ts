import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { AddFileSuggestModal, AtlasExplorerView } from "../../src/explorer-view";
import { buildFixture, file, folder } from "../auto-promotion-fixtures";
import type { Fixture } from "../auto-promotion-fixtures";

/** The "+" picker against the real UnitIndex and ViewsManager: a unit the inbox rule keeps out of the
 * inbox (`isSuppressedFromInbox`) must still be offered, so the user can bring a link-only item in. */

function openPlus(fx: Fixture): { modal: AddFileSuggestModal; candidates: string[] } {
	const plugin = { app: fx.app, settings: fx.settings, unitIndex: fx.index, viewsManager: fx.views, flushSave: vi.fn(async () => {}) };
	const fake = { plugin, render: vi.fn(async () => {}) };
	let captured: AddFileSuggestModal | undefined;
	const spy = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
		captured = this;
	});
	(AtlasExplorerView.prototype as unknown as { openAddFileModal: (this: unknown) => void }).openAddFileModal.call(fake);
	spy.mockRestore();
	if (!captured) throw new Error("modal did not open");
	const modal = captured;
	return { modal, candidates: modal.getItems().map((item) => modal.getItemText(item)).sort() };
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe('"+" picker offers units the inbox rule suppresses (R1)', () => {
	it("switch off: a link-only file and a link-only sub-folder are offered", () => {
		const fx = buildFixture({ autoPromotion: false });
		expect(fx.index.isSuppressedFromInbox(fx.index.getUnits().find((u) => u.path === "Alpha/linked.md")!)).toBe(true);
		const { candidates } = openPlus(fx);
		expect(candidates).toContain("Alpha/linked.md");
		expect(candidates).toContain("Alpha/dup.md");
		expect(candidates).toContain("Beta/Sub/");
	});

	it("picking one marks it added, lifts the suppression and puts it in the inbox", () => {
		const fx = buildFixture({ autoPromotion: false });
		const inboxPaths = () => fx.views.getInboxUnits(fx.index.getUnits(), fx.viewId, "view", fx.index).map((u) => u.path);
		expect(inboxPaths()).not.toContain("Alpha/linked.md");
		expect(inboxPaths()).not.toContain("Beta/Sub");

		const { modal } = openPlus(fx);
		modal.onChooseItem(fx.app.vault.getAbstractFileByPath("Alpha/linked.md") as TFile);
		modal.onChooseItem(fx.app.vault.getAbstractFileByPath("Beta/Sub") as TFolder);

		expect(fx.index.isAdded(file("Alpha/linked.md"))).toBe(true);
		expect(fx.index.isAdded(folder("Beta/Sub"))).toBe(true);
		expect(inboxPaths()).toContain("Alpha/linked.md");
		expect(inboxPaths()).toContain("Beta/Sub");
		// Added is terminal: neither is offered a second time.
		const { candidates } = openPlus(fx);
		expect(candidates).not.toContain("Alpha/linked.md");
		expect(candidates).not.toContain("Beta/Sub/");
	});

	it("a link-only unit the user hid in a module is offered while the switch is on", () => {
		const fx = buildFixture({ autoPromotion: true });
		expect(openPlus(fx).candidates).not.toContain("Alpha/linked.md");
		fx.index.setModuleItemHidden("Alpha", "Alpha/linked.md", true);
		expect(openPlus(fx).candidates).toContain("Alpha/linked.md");
	});

	it("a suppressed unit dismissed globally or in this view is not offered; a dismissal in another view does not matter", () => {
		const fx = buildFixture({ autoPromotion: false });
		const ref = file("Alpha/linked.md");
		fx.index.setDismissed(ref, "global", true);
		expect(openPlus(fx).candidates).not.toContain("Alpha/linked.md");
		// Un-dismissed again, it is offered, and choosing it reaches the inbox.
		fx.index.setDismissed(ref, "global", false);
		expect(openPlus(fx).candidates).toContain("Alpha/linked.md");

		fx.index.setDismissed(folder("Beta/Sub"), "view", true, fx.viewId);
		expect(openPlus(fx).candidates).not.toContain("Beta/Sub/");
		fx.index.setDismissed(folder("Beta/Sub"), "view", false, fx.viewId);
		fx.index.setDismissed(folder("Beta/Sub"), "view", true, "some-other-view");
		expect(openPlus(fx).candidates).toContain("Beta/Sub/");
	});

	it("global inbox mode reads only the global dismissal", () => {
		const fx = buildFixture({ autoPromotion: false });
		fx.views.setInboxMode(fx.viewId, "global");
		fx.index.setDismissed(file("Alpha/linked.md"), "view", true, fx.viewId);
		expect(openPlus(fx).candidates).toContain("Alpha/linked.md");
		fx.index.setDismissed(file("Alpha/linked.md"), "global", true);
		expect(openPlus(fx).candidates).not.toContain("Alpha/linked.md");
	});

	it("switch on: a visible link-only unit is still not offered (already in the inbox)", () => {
		const fx = buildFixture({ autoPromotion: true });
		const { candidates } = openPlus(fx);
		expect(candidates).not.toContain("Alpha/linked.md");
		expect(candidates).not.toContain("Beta/Sub/");
	});

	it("a placed link-only unit, a manual promotion and an added item stay out whatever the switch says", () => {
		for (const autoPromotion of [false, true]) {
			const { candidates } = openPlus(buildFixture({ autoPromotion }));
			expect(candidates, `autoPromotion=${autoPromotion}`).not.toContain("Alpha/placed.md");
			expect(candidates, `autoPromotion=${autoPromotion}`).not.toContain("Alpha/manual.md");
			expect(candidates, `autoPromotion=${autoPromotion}`).not.toContain("Beta/addedOnly.md");
		}
	});
});
