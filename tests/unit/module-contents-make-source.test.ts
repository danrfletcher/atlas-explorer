import { afterEach, describe, expect, it, vi } from "vitest";
import { setPromotedRoots } from "../../src/source-links";
import { clickMenuItem, itemRow, makeModuleRig, rightClick } from "./module-contents-fixtures";

// PR-12 (G6): Module Contents. A folder row offers "Make its own source" (greyed out offline); a promoted
// source's folder is left out of its parent's modal, because it now shows in its own section.

afterEach(() => {
	document.body.innerHTML = "";
	setPromotedRoots([]);
});

const FILES = ["Sources/tephra/crates/Cargo.toml", "Sources/tephra/crates/tephrad/src/a.rs", "Sources/tephra/crates/docs/g.md"];
const FOLDERS = ["Sources", "Sources/tephra", "Sources/tephra/crates", "Sources/tephra/crates/tephrad", "Sources/tephra/crates/tephrad/src", "Sources/tephra/crates/docs"];
const SOURCES = [
	{ name: "tephra", path: "/dev/Tephra", status: "online" as const },
	{ name: "tephrad", path: "/dev/Tephra/crates/tephrad", status: "online" as const },
];

function rigWith(state: "online" | "offline") {
	const rig = makeModuleRig(FILES, FOLDERS);
	// `tephraConnection` is a getter on the prototype: shadow it on the instance.
	Object.defineProperty(rig.plugin, "tephraConnection", {
		value: {
			getSnapshot: () => ({ state, checked: true, sources: state === "online" ? SOURCES : [] }),
			getLastSources: () => SOURCES,
		},
	});
	Object.assign(rig.plugin, {
		settings: { ...rig.plugin.settings, tephraEnabled: true },
		getVaultBasePath: () => "/Users/dan/Vault",
		sourcePromoter: { makeOwnSource: vi.fn(async () => {}) },
	});
	setPromotedRoots([{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad" }]);
	return rig;
}
const open = (rig: ReturnType<typeof rigWith>) => rig.openModal("Sources/tephra/crates");

describe("Module Contents: Make its own source", () => {
	it("a folder row offers it; clicking asks the promoter for that folder and closes the modal", () => {
		const rig = rigWith("online");
		const modal = open(rig);
		const menu = rightClick(itemRow(modal, "docs"));
		expect(menu.titles()).toContain("Make its own source");
		clickMenuItem(menu, "Make its own source");
		expect((rig.plugin as unknown as { sourcePromoter: { makeOwnSource: ReturnType<typeof vi.fn> } }).sourcePromoter.makeOwnSource).toHaveBeenCalledWith("Sources/tephra/crates/docs");
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("a file row does not offer it", () => {
		const rig = rigWith("online");
		expect(rightClick(itemRow(open(rig), "Cargo.toml")).titles()).not.toContain("Make its own source");
	});

	it("Tephra offline: the item is there, greyed out, and does nothing", () => {
		const rig = rigWith("offline");
		const menu = rightClick(itemRow(open(rig), "docs"));
		const item = menu.items.find((i) => i.title === "Make its own source")!;
		expect(item.disabled).toBe(true);
	});

	it("the toggle off: no item", () => {
		const rig = rigWith("online");
		(rig.plugin.settings as { tephraEnabled: boolean }).tephraEnabled = false;
		expect(rightClick(itemRow(open(rig), "docs")).titles()).not.toContain("Make its own source");
	});

	it("a promoted source's own folder is left out of its parent's modal", () => {
		const rig = rigWith("online");
		const modal = open(rig);
		const names = [...modal.contentEl.querySelectorAll(".atlas-row-internal .atlas-row-text")].map((el) => el.textContent ?? "");
		expect(names).toContain("docs");
		expect(names).not.toContain("tephrad");
		setPromotedRoots([]);
		expect([...open(rig).contentEl.querySelectorAll(".atlas-row-internal .atlas-row-text")].map((el) => el.textContent)).toContain("tephrad");
	});
});
