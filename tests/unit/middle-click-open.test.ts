import { describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import {
	MIDDLE_CLICK_CONTROL_SELECTOR,
	openOnMiddleClick,
	refTargetExists,
	shouldOpenOnMiddleClick,
	suppressMiddleButtonAutoscroll,
	wireMiddleClickOpen,
	type MiddleClickRowState,
} from "../../src/middle-click-open";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { isRefPresent } from "../../src/ref-presence";
import type { UnitRef } from "../../src/types";

/** Table-driven test of the shared middle-click rules (G1–G12, E2–E4). Plain `HTMLElement` rows, a spy
 * `openRef`, and real dispatched `auxclick` events, so `event.target` / `closest` behave as in the browser. */

const file: UnitRef = { kind: "file", path: "Projects/Boat.md" };
const block: UnitRef = { kind: "block", path: "_pool/20260101000000-abcd.md", subpath: "^abcd" };
const folder: UnitRef = { kind: "folder", path: "Projects" };

/** A row shaped like the explorer's: chevron, icon, label, plus every control a row can carry. */
function makeRow(opts: { iconIsStatusDot?: boolean } = {}) {
	const row = document.createElement("div");
	row.className = "atlas-row atlas-row-unit";
	const chevron = row.createDiv({ cls: "atlas-chevron" });
	const icon = row.createDiv({ cls: opts.iconIsStatusDot ? "atlas-icon atlas-status-dot" : "atlas-icon" });
	const dotCircle = icon.createDiv({ cls: "atlas-status-dot-circle" });
	const label = row.createSpan({ cls: "atlas-row-text", text: "Boat" });
	const secondary = row.createSpan({ cls: "atlas-row-secondary", text: "2 items" });
	const badge = row.createSpan({ cls: "atlas-badge", text: "promoted" });
	const connectionDot = row.createSpan({ cls: "atlas-api-connection-dot atlas-api-dot-green" });
	const sortIndicator = row.createDiv({ cls: "atlas-sort-indicator" });
	const action = row.createDiv({ cls: "atlas-row-action" });
	const actionIcon = action.createEl("svg" as "div");
	document.body.appendChild(row);
	return { row, chevron, icon, dotCircle, label, secondary, badge, connectionDot, sortIndicator, action, actionIcon };
}

type Parts = ReturnType<typeof makeRow>;
type TargetName = keyof Parts;

const live = (ref: UnitRef, over: Partial<MiddleClickRowState> = {}): MiddleClickRowState => ({
	ref,
	missing: false,
	outsideManaged: false,
	targetExists: true,
	...over,
});

/** Dispatches a real `auxclick` at `target` and reports what `shouldOpenOnMiddleClick` said about it. */
function decide(parts: Parts, target: TargetName, state: MiddleClickRowState, init: MouseEventInit = {}): boolean {
	let result: boolean | null = null;
	const listener = (evt: Event) => {
		result = shouldOpenOnMiddleClick(evt as MouseEvent, parts.row, state);
	};
	parts.row.addEventListener("auxclick", listener);
	parts[target].dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true, ...init }));
	parts.row.removeEventListener("auxclick", listener);
	if (result === null) throw new Error("auxclick never reached the row");
	return result;
}

describe("which rows open (G1-G3, G7, G8, E2)", () => {
	const cases: { name: string; ref: UnitRef; over?: Partial<MiddleClickRowState>; expected: boolean }[] = [
		{ name: "G1 file unit", ref: file, expected: true },
		{ name: "G2 block unit", ref: block, expected: true },
		{ name: "G3 module with an interface note", ref: folder, expected: true },
		{ name: "G3/E2 module without an interface note (targetExists false)", ref: folder, over: { targetExists: false }, expected: false },
		{ name: "G7 missing file row", ref: file, over: { missing: true }, expected: false },
		{ name: "G7 missing block row", ref: block, over: { missing: true }, expected: false },
		{ name: "G7/E3 block whose file was deleted since render (missing flag stale, target gone)", ref: block, over: { targetExists: false }, expected: false },
		{ name: "G7 missing module row", ref: folder, over: { missing: true }, expected: false },
		{ name: "G8 Outside-Vault child (file)", ref: file, over: { outsideManaged: true }, expected: false },
		{ name: "G8 Outside-Vault child (module)", ref: folder, over: { outsideManaged: true }, expected: false },
	];
	for (const c of cases) {
		it(`${c.name}: ${c.expected ? "opens" : "does nothing"}`, () => {
			expect(decide(makeRow(), "label", live(c.ref, c.over))).toBe(c.expected);
		});
	}

	it("the row element itself and its secondary text count as the label area", () => {
		const parts = makeRow();
		expect(decide(parts, "row", live(file))).toBe(true);
		expect(decide(parts, "secondary", live(file))).toBe(true);
	});
});

describe("controls inside a row do nothing (G4, G9)", () => {
	const controls: TargetName[] = ["chevron", "badge", "connectionDot", "sortIndicator", "action", "actionIcon"];
	for (const kind of [file, block, folder]) {
		for (const target of controls) {
			it(`${kind.kind} row: a click on ${target} is ignored`, () => {
				expect(decide(makeRow(), target, live(kind))).toBe(false);
			});
		}
	}

	it("G9 the status dot (icon in dot form and the circle inside it) is ignored on a file row", () => {
		const parts = makeRow({ iconIsStatusDot: true });
		expect(decide(parts, "icon", live(file))).toBe(false);
		expect(decide(parts, "dotCircle", live(file))).toBe(false);
	});

	it("a plain (non-dot) file icon is not a control: it is part of the label area", () => {
		expect(decide(makeRow(), "icon", live(file))).toBe(true);
	});

	it("G4 a module's icon does nothing, plain form and status-dot form", () => {
		expect(decide(makeRow(), "icon", live(folder))).toBe(false);
		const dotted = makeRow({ iconIsStatusDot: true });
		expect(decide(dotted, "icon", live(folder))).toBe(false);
		expect(decide(dotted, "dotCircle", live(folder))).toBe(false);
	});

	it("G4 a module's row body (label) still opens", () => {
		expect(decide(makeRow(), "label", live(folder))).toBe(true);
	});

	it("G9 an 'N Done' truncation group row is itself a control", () => {
		const parts = makeRow();
		parts.row.className = "atlas-row atlas-truncation-row";
		expect(decide(parts, "label", live(file))).toBe(false);
		expect(decide(parts, "row", live(file))).toBe(false);
	});

	it("a control ancestor outside the row does not block a click inside it", () => {
		const outer = document.createElement("div");
		outer.className = "atlas-badge";
		const parts = makeRow();
		outer.appendChild(parts.row);
		expect(decide(parts, "label", live(file))).toBe(true);
	});

	it("every selector class in the spec's G9 list is covered", () => {
		for (const cls of [".atlas-chevron", ".atlas-status-dot", ".atlas-row-action", ".atlas-badge", ".atlas-api-connection-dot", ".atlas-sort-indicator", ".atlas-truncation-row"]) {
			expect(MIDDLE_CLICK_CONTROL_SELECTOR).toContain(cls);
		}
	});
});

describe("buttons and modifiers (G12, added)", () => {
	for (const mod of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) {
		it(`G12 middle-click with ${mod} held is ignored`, () => {
			expect(decide(makeRow(), "label", live(file), { [mod]: true })).toBe(false);
		});
	}
	it("G12 all four modifiers at once is ignored", () => {
		expect(decide(makeRow(), "label", live(file), { shiftKey: true, metaKey: true, ctrlKey: true, altKey: true })).toBe(false);
	});
	for (const button of [0, 2, 3, 4]) {
		it(`auxclick with button ${button} is ignored`, () => {
			expect(decide(makeRow(), "label", live(file), { button })).toBe(false);
		});
	}
});

describe("openOnMiddleClick calls openRef(ref, true) (G1-G2, G11, E4)", () => {
	function fire(parts: Parts, target: TargetName, state: MiddleClickRowState, openRef: (ref: UnitRef, newTab: boolean) => unknown, init: MouseEventInit = {}): boolean {
		let opened = false;
		const listener = (evt: Event) => {
			opened = openOnMiddleClick(evt as MouseEvent, parts.row, state, openRef);
		};
		parts.row.addEventListener("auxclick", listener);
		parts[target].dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, ...init }));
		parts.row.removeEventListener("auxclick", listener);
		return opened;
	}

	it("a file opens in a new tab", () => {
		const openRef = vi.fn();
		expect(fire(makeRow(), "label", live(file), openRef)).toBe(true);
		expect(openRef).toHaveBeenCalledExactlyOnceWith(file, true);
	});

	it("a block opens in a new tab with its subpath intact", () => {
		const openRef = vi.fn();
		fire(makeRow(), "label", live(block), openRef);
		expect(openRef).toHaveBeenCalledExactlyOnceWith(block, true);
	});

	it("G11 a note that is already open still gets a fresh tab on every click; E4 five rapid clicks make five calls", () => {
		const openRef = vi.fn();
		const parts = makeRow();
		for (let i = 0; i < 5; i++) fire(parts, "label", live(file), openRef);
		expect(openRef).toHaveBeenCalledTimes(5);
		for (const call of openRef.mock.calls) expect(call).toEqual([file, true]);
	});

	it("E2 refused rows never call openRef", () => {
		const openRef = vi.fn();
		fire(makeRow(), "label", live(file, { missing: true }), openRef);
		fire(makeRow(), "label", live(file, { outsideManaged: true }), openRef);
		fire(makeRow(), "label", live(folder, { targetExists: false }), openRef);
		fire(makeRow(), "chevron", live(file), openRef);
		fire(makeRow(), "label", live(file), openRef, { shiftKey: true });
		expect(openRef).not.toHaveBeenCalled();
	});
});

describe("refTargetExists (live target check; never creates anything)", () => {
	function app() {
		const a = new App();
		a.vault.seedFolder("Projects");
		a.vault.seedFile("Projects/Boat.md");
		a.vault.seedFolder("Modules");
		a.vault.seedFolder("Modules/WithNote");
		a.vault.seedFile("Modules/WithNote/WithNote.md");
		a.vault.seedFolder("Modules/NoNote");
		a.vault.seedFolder("_pool");
		a.vault.seedFile("_pool/20260101000000-abcd.md");
		return a;
	}

	it("a file and a block resolve while their file exists, and stop once it is gone", async () => {
		const a = app();
		expect(refTargetExists(a, DEFAULT_SETTINGS, file)).toBe(true);
		expect(refTargetExists(a, DEFAULT_SETTINGS, block)).toBe(true);
		await a.vault.delete(a.vault.getAbstractFileByPath(block.path)!);
		expect(refTargetExists(a, DEFAULT_SETTINGS, block)).toBe(false);
	});

	it("a module resolves only with an interface note", () => {
		const a = app();
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "folder", path: "Modules/WithNote" })).toBe(true);
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "folder", path: "Modules/NoNote" })).toBe(false);
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "folder", path: "Modules/Gone" })).toBe(false);
	});

	it("a file ref pointing at a folder, or a folder ref pointing at a file, does not resolve", () => {
		const a = app();
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "file", path: "Modules/NoNote" })).toBe(false);
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "folder", path: "Projects/Boat.md" })).toBe(false);
	});

	it("Atlas #13 PR-1: agrees with the shared presence rule for files and folders (a folder also needs an interface note)", () => {
		const a = app();
		a.vault.seedFile("Projects/scan.pdf");
		const refs: UnitRef[] = [
			file,
			{ kind: "file", path: "Projects/scan.pdf" },
			{ kind: "file", path: "Projects/Gone.md" },
			{ kind: "file", path: "Modules/NoNote" },
			{ kind: "folder", path: "Modules/WithNote" },
			{ kind: "folder", path: "Modules/NoNote" },
			{ kind: "folder", path: "Projects/Boat.md" },
			{ kind: "folder", path: "Modules/Gone" },
		];
		for (const ref of refs) {
			const present = isRefPresent(a.vault, ref);
			const expected = ref.kind === "folder" ? present && ref.path === "Modules/WithNote" : present;
			expect(refTargetExists(a, DEFAULT_SETTINGS, ref), `${ref.kind}:${ref.path}`).toBe(expected);
		}
	});

	it("Atlas #13 PR-1: a present file that is not an Atlas unit resolves; a block is judged by its file, as before", () => {
		const a = app();
		a.vault.seedFolder("FDE Play");
		a.vault.seedFile("FDE Play/Responsibilities.md");
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "file", path: "FDE Play/Responsibilities.md" })).toBe(true);
		expect(refTargetExists(a, DEFAULT_SETTINGS, { kind: "block", path: "FDE Play/Responsibilities.md", subpath: "^x" })).toBe(true);
	});

	it("never mutates the vault", () => {
		const a = app();
		a.vault.calls.length = 0;
		refTargetExists(a, DEFAULT_SETTINGS, block);
		refTargetExists(a, DEFAULT_SETTINGS, { kind: "folder", path: "Modules/NoNote" });
		expect(a.vault.calls).toEqual([]);
		expect(a.vault.getAbstractFileByPath("Modules/NoNote/NoNote.md")).toBeNull();
		expect(a.vault.getFiles().every((f) => f instanceof TFile)).toBe(true);
	});
});

describe("E1 mousedown autoscroll guard", () => {
	function down(button: number): MouseEvent {
		const row = document.createElement("div");
		row.addEventListener("mousedown", suppressMiddleButtonAutoscroll);
		const evt = new MouseEvent("mousedown", { button, bubbles: true, cancelable: true });
		row.dispatchEvent(evt);
		return evt;
	}
	it("prevents button 1", () => expect(down(1).defaultPrevented).toBe(true));
	it("leaves buttons 0 and 2 alone", () => {
		expect(down(0).defaultPrevented).toBe(false);
		expect(down(2).defaultPrevented).toBe(false);
	});
});

describe("wireMiddleClickOpen checks the target at click time, not render time", () => {
	it("a target that disappears after the row was wired is not opened", () => {
		const parts = makeRow();
		let exists = true;
		const openRef = vi.fn();
		wireMiddleClickOpen(parts.row, { ref: block, missing: false, outsideManaged: false }, () => exists, openRef);
		parts.label.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
		expect(openRef).toHaveBeenCalledTimes(1);
		exists = false;
		parts.label.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
		expect(openRef).toHaveBeenCalledTimes(1);
	});

	it("does not look the target up for a click that is already refused", () => {
		const parts = makeRow();
		const targetExists = vi.fn(() => true);
		wireMiddleClickOpen(parts.row, { ref: file, missing: false, outsideManaged: false }, targetExists, vi.fn());
		parts.chevron.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
		expect(targetExists).not.toHaveBeenCalled();
	});
});
