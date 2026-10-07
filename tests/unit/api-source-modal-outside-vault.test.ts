import { describe, expect, it, vi } from "vitest";

/** Same hand-rolled "obsidian" mock approach as `tests/unit/api-source-modal.test.ts` (that package
 * ships types only, no runtime) — trimmed to just what driving the Folder/Outside-Vault body needs:
 * `Setting`'s dropdown/text/toggle components, `Modal`, and `setTooltip` for the connection dot. */
vi.mock("obsidian", () => {
	function createFakeElement(onEmpty?: () => void): any {
		const el: any = {
			children: [] as any[],
			__settings: [] as any[],
			cls: undefined as string | undefined,
			textContent: "",
			empty() {
				this.children = [];
				this.__settings = [];
				onEmpty?.();
			},
			createEl(_tag: string, opts?: { text?: string; cls?: string }) {
				const child = createFakeElement();
				if (opts?.text) child.textContent = opts.text;
				if (opts?.cls) child.cls = opts.cls;
				this.children.push(child);
				return child;
			},
			createDiv(opts?: { cls?: string }) {
				return this.createEl("div", opts);
			},
			createSpan(opts?: { cls?: string; text?: string }) {
				return this.createEl("span", opts);
			},
			setText(t: string) {
				this.textContent = t;
			},
			setAttr() {},
		};
		return el;
	}

	class FakeTextComponent {
		value = "";
		disabled = false;
		private changeCb?: (v: string) => void;
		setPlaceholder() {
			return this;
		}
		setValue(v: string) {
			this.value = v;
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			return this;
		}
		onChange(cb: (v: string) => void) {
			this.changeCb = cb;
			return this;
		}
		/** Simulates the user typing a new value into the field, one change event per call — same as
		 * a real `<input>`'s `onChange` firing per keystroke, which is exactly what the live
		 * no-caching indicator design (G11) depends on. */
		type(v: string) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeToggleComponent {
		value = false;
		private changeCb?: (v: boolean) => void;
		setValue(v: boolean) {
			this.value = v;
			return this;
		}
		onChange(cb: (v: boolean) => void) {
			this.changeCb = cb;
			return this;
		}
		flip(v: boolean) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeDropdownComponent {
		value = "";
		options: { value: string; label: string }[] = [];
		private changeCb?: (v: string) => void;
		addOption(value: string, label: string) {
			this.options.push({ value, label });
			return this;
		}
		setValue(v: string) {
			this.value = v;
			return this;
		}
		onChange(cb: (v: string) => void) {
			this.changeCb = cb;
			return this;
		}
		select(v: string) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeButtonComponent {
		buttonEl: any = createFakeElement();
		disabled = false;
		private clickCallback?: () => void;
		setButtonText(t: string) {
			this.buttonEl.textContent = t;
			return this;
		}
		setCta() {
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			return this;
		}
		onClick(cb: () => void) {
			this.clickCallback = cb;
			return this;
		}
		simulateClick() {
			if (this.disabled || !this.clickCallback) return;
			this.clickCallback();
		}
	}

	class FakeExtraButtonComponent {
		setIcon() {
			return this;
		}
		setTooltip() {
			return this;
		}
		onClick() {
			return this;
		}
	}

	class FakeSetting {
		name = "";
		components: unknown[] = [];
		controlEl: any = createFakeElement();
		constructor(public containerEl: any) {
			if (!containerEl.__settings) containerEl.__settings = [];
			containerEl.__settings.push(this);
		}
		setName(n: string) {
			this.name = n;
			return this;
		}
		setDesc() {
			return this;
		}
		setHeading() {
			return this;
		}
		addText(cb: (t: FakeTextComponent) => void) {
			const t = new FakeTextComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addToggle(cb: (t: FakeToggleComponent) => void) {
			const t = new FakeToggleComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addDropdown(cb: (t: FakeDropdownComponent) => void) {
			const t = new FakeDropdownComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addButton(cb: (t: FakeButtonComponent) => void) {
			const t = new FakeButtonComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addExtraButton(cb: (t: FakeExtraButtonComponent) => void) {
			const t = new FakeExtraButtonComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
	}

	class FakeModal {
		app: unknown;
		modalEl: any = createFakeElement();
		contentEl: any = createFakeElement();
		constructor(app: unknown) {
			this.app = app;
		}
		open() {
			(this as any).onOpen?.();
		}
		close() {
			(this as any).onClose?.();
		}
	}

	class FakeNotice {
		constructor(_message?: string) {}
	}

	return {
		App: class {},
		ButtonComponent: FakeButtonComponent,
		Modal: FakeModal,
		Notice: FakeNotice,
		Platform: { isMobile: false },
		Setting: FakeSetting,
		requestUrl: async () => ({ status: 200, text: "[]" }),
		setTooltip: vi.fn(),
	};
});

import { ApiSourceModal } from "../../src/api-source-modal";
import { FolderSourceConfig } from "../../src/types";

function settingNamed(modal: unknown, name: string): any {
	const contentEl = (modal as any).contentEl;
	return contentEl.__settings.find((s: any) => s.name === name);
}

function indicatorDot(modal: unknown): { cls: string } {
	// The connection dot is appended directly to the "Path" setting's `controlEl` (see
	// `renderOutsidePathField`: `setting.controlEl.createSpan()`), as the last child. The real
	// implementation assigns `indicatorEl.className = ...` directly (not via `createSpan`'s `cls`
	// option), so the fake element exposes that live-assigned value as a plain `className` property.
	const setting = settingNamed(modal, "Path");
	const children = setting.controlEl.children as any[];
	const el = children[children.length - 1];
	return { cls: el.className ?? "" };
}

describe("api-source-modal-outside-vault — G6: raw-path-field-rendered rule", () => {
	it("selecting Folder + Outside vault renders a 'Path' text field (not a vault-folder suggester)", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");

		const pathSetting = settingNamed(modal, "Path");
		expect(pathSetting).toBeTruthy();
		expect(pathSetting.components[0]).toBeInstanceOf(Object);
		expect(typeof pathSetting.components[0].type).toBe("function"); // a FakeTextComponent, not a filter list
	});

	it("typing into the Path field updates the modal's outsidePath and enables Save", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");
		expect((modal as any).saveButton.disabled).toBe(true);

		settingNamed(modal, "Path").components[0].type("/Volumes/External/Notes");
		expect((modal as any).outsidePath).toBe("/Volumes/External/Notes");
		expect((modal as any).saveButton.disabled).toBe(false);

		(modal as any).saveButton.simulateClick();
		expect(onSave).toHaveBeenCalledWith({
			type: "folder",
			source: expect.objectContaining({ location: "outside", path: "" }),
			outsidePath: "/Volumes/External/Notes",
		});
	});

	it("an existing Outside-Vault FolderSourceConfig pre-selects Outside vault and restores the stored path", () => {
		const folderSource: FolderSourceConfig = {
			location: "outside",
			path: "",
			showFiles: true,
			showFolders: false,
		};
		const modal = new ApiSourceModal({} as any, null, [], vi.fn(), folderSource, "/Volumes/External/Notes");
		(modal as any).onOpen();

		expect(settingNamed(modal, "Location").components[0].value).toBe("outside");
		expect(settingNamed(modal, "Path").components[0].value).toBe("/Volumes/External/Notes");
		expect(settingNamed(modal, "Show files").components[0].value).toBe(true);
		expect(settingNamed(modal, "Show folders").components[0].value).toBe(false);
	});
});

describe("api-source-modal-outside-vault — G4: no-vault-suggester-shown-in-outside-mode rule", () => {
	it("Outside vault never renders the vault-relative 'Folder' suggester field", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");

		expect(settingNamed(modal, "Folder")).toBeUndefined();
	});

	it("switching back to Inside vault re-renders the 'Folder' suggester and removes the 'Path' field", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");
		expect(settingNamed(modal, "Path")).toBeTruthy();

		settingNamed(modal, "Location").components[0].select("inside");
		expect(settingNamed(modal, "Path")).toBeUndefined();
		expect(settingNamed(modal, "Folder")).toBeTruthy();
	});

	it("Inside vault still renders the Show files/Show folders toggles shared with Outside vault", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		expect(settingNamed(modal, "Show files")).toBeTruthy();
		expect(settingNamed(modal, "Show folders")).toBeTruthy();
	});
});

describe("api-source-modal-outside-vault — G6/G11: modal-indicator-reflects-store-state rule", () => {
	it("an initially-blank path renders the indicator red", () => {
		const folderSource: FolderSourceConfig = { location: "outside", path: "", showFiles: true, showFolders: true };
		const modal = new ApiSourceModal({} as any, null, [], vi.fn(), folderSource, "");
		(modal as any).onOpen();

		const dot = indicatorDot(modal);
		expect(dot.cls).toContain("atlas-api-dot-red");
	});

	it("typing a non-empty path that doesn't resolve on disk keeps the indicator red", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();
		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");

		settingNamed(modal, "Path").components[0].type("/definitely/does/not/exist/on/this/machine");

		const dot = indicatorDot(modal);
		expect(dot.cls).toContain("atlas-api-dot-red");
	});

	it("typing a path that does resolve on disk (the OS temp directory) turns the indicator green, live on keystroke", () => {
		const os = require("node:os") as typeof import("node:os");
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();
		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");

		expect(indicatorDot(modal).cls).toContain("atlas-api-dot-red");

		settingNamed(modal, "Path").components[0].type(os.tmpdir());

		expect(indicatorDot(modal).cls).toContain("atlas-api-dot-green");
	});

	it("clearing a previously-resolving path back to blank turns the indicator red again, live on keystroke", () => {
		const os = require("node:os") as typeof import("node:os");
		const folderSource: FolderSourceConfig = { location: "outside", path: "", showFiles: true, showFolders: true };
		const modal = new ApiSourceModal({} as any, null, [], vi.fn(), folderSource, os.tmpdir());
		(modal as any).onOpen();

		expect(indicatorDot(modal).cls).toContain("atlas-api-dot-green");

		settingNamed(modal, "Path").components[0].type("");

		expect(indicatorDot(modal).cls).toContain("atlas-api-dot-red");
	});
});
