import { describe, expect, it, vi } from "vitest";

/** PR-1 polish (PR-2 R8): the Statuses modal's "Sort children by status" toggle — the modal half of
 * G12/G19. Turning it on sets Status from every prior mode; turning it off sets Manual (it can only
 * be turned off from Status, since it shows on only then); both reset Reverse, like picking a mode in
 * the "Sort children…" menu. Drives the real `StatusesModal.render()` against a minimal `Setting`
 * fake that records each toggle by name, then flips them through their registered `onChange`. */
vi.mock("obsidian", () => {
	const makeEl = (): any => {
		const el: any = {
			scrollTop: 0,
			empty() {},
			createEl: () => makeEl(),
			createDiv: () => makeEl(),
			createSpan: () => makeEl(),
		};
		return el;
	};

	class FakeToggle {
		value = false;
		disabled = false;
		handler: ((v: boolean) => void) | null = null;
		setValue(v: boolean) {
			this.value = v; // like Obsidian's: setting the value programmatically does not fire onChange
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			return this;
		}
		onChange(cb: (v: boolean) => void) {
			this.handler = cb;
			return this;
		}
		/** What a user click does: flip the value, then run the registered handler. */
		click() {
			this.value = !this.value;
			this.handler?.(this.value);
		}
	}

	// Every Setting built by the most recent render, by name. A re-render replaces the toggles, so
	// tests always look them up fresh.
	const settings: { name: string; toggle?: FakeToggle }[] = [];
	class FakeSetting {
		record: { name: string; toggle?: FakeToggle } = { name: "" };
		constructor(_containerEl: unknown) {
			settings.push(this.record);
		}
		setName(n: string) {
			this.record.name = n;
			return this;
		}
		setDesc() {
			return this;
		}
		setHeading() {
			return this;
		}
		addToggle(cb: (t: FakeToggle) => void) {
			const t = new FakeToggle();
			cb(t);
			this.record.toggle = t;
			return this;
		}
		addDropdown(cb: (d: any) => void) {
			cb({ addOption() {}, setValue() {}, setDisabled() {}, onChange() {} });
			return this;
		}
		addText(cb: (t: any) => void) {
			const t: any = { setPlaceholder: () => t, setValue: () => t, setDisabled: () => t, onChange: () => t };
			cb(t);
			return this;
		}
		addButton(cb: (b: any) => void) {
			const b: any = { setButtonText: () => b, setCta: () => b, onClick: () => b, setDisabled: () => b };
			cb(b);
			return this;
		}
	}

	class FakeModal {
		modalEl = makeEl();
		contentEl = makeEl();
		constructor(public app: unknown) {}
		open() {
			(this as any).onOpen?.();
		}
		close() {}
	}

	return { App: class {}, Modal: FakeModal, Setting: FakeSetting, TextComponent: class {}, ToggleComponent: class {}, __settings: settings };
});

import * as obsidian from "obsidian";
import { StatusesModal } from "../../src/modals";
import type { StatusSet } from "../../src/statuses";
import type { StatusGovernance } from "../../src/types";

const sets: StatusSet[] = [{ id: "S", name: "Set", statuses: [{ id: "a", label: "A", color: "#fff" }] }];
const recorded = (obsidian as unknown as { __settings: { name: string; toggle?: { value: boolean; disabled: boolean; click(): void } }[] }).__settings;

/** The toggles of the most recent render (a render builds a fresh set of Settings, appended after the old). */
function toggle(name: string) {
	for (let i = recorded.length - 1; i >= 0; i--) if (recorded[i].name === name && recorded[i].toggle) return recorded[i].toggle!;
	throw new Error(`no toggle named ${name}`);
}

function open(initial: StatusGovernance) {
	recorded.length = 0;
	const onChange = vi.fn();
	const modal = new StatusesModal({} as never, sets, { statusEnabled: true, statusSetId: "S", ...initial }, onChange);
	modal.open();
	onChange.mockClear(); // drop the constructor's own default-set persist, if any
	return { modal, onChange };
}

describe("PR-2 R8 — the Statuses modal's 'Sort children by status' toggle (G12/G19)", () => {
	it.each([
		["Manual (no setting)", {}],
		["Manual (explicit)", { sortMode: "manual" as const }],
		["A-Z", { sortMode: "alphabetical" as const }],
		["Modified", { sortMode: "modified" as const }],
		["Time added", { sortMode: "time-added" as const }],
	])("turning it on from %s sets Status", (_label, initial) => {
		const { onChange } = open(initial);
		expect(toggle("Sort children by status").value).toBe(false);
		toggle("Sort children by status").click();
		expect(onChange).toHaveBeenCalledWith({ sortMode: "status", sortReverse: false });
	});

	it("turning it on from a reversed A-Z gives plain Status, not Status reversed", () => {
		const { onChange } = open({ sortMode: "alphabetical", sortReverse: true });
		toggle("Sort children by status").click();
		expect(onChange).toHaveBeenCalledWith({ sortMode: "status", sortReverse: false });
		expect(toggle("Reverse order").value).toBe(false);
		expect(toggle("Reverse order").disabled).toBe(false); // Status is on, so Reverse is usable
	});

	it("turning it off from Status sets Manual and resets and disables Reverse", () => {
		const { onChange } = open({ sortMode: "status", sortReverse: true });
		expect(toggle("Sort children by status").value).toBe(true);
		expect(toggle("Reverse order").value).toBe(true);
		toggle("Sort children by status").click();
		expect(onChange).toHaveBeenCalledWith({ sortMode: "manual", sortReverse: false });
		expect(toggle("Reverse order").value).toBe(false);
		expect(toggle("Reverse order").disabled).toBe(true);
	});

	it("shows off for every non-Status mode, so 'off' can only ever come from Status", () => {
		for (const sortMode of ["alphabetical", "modified", "time-added", "manual"] as const) {
			open({ sortMode });
			expect(toggle("Sort children by status").value).toBe(false);
		}
		open({ sortMode: "status" });
		expect(toggle("Sort children by status").value).toBe(true);
	});
});
