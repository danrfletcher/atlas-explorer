import { describe, expect, it, vi } from "vitest";

/** Same hand-rolled "obsidian" mock as `tests/unit/api-source-modal-outside-vault.test.ts` — trimmed
 * to just what driving the Folder body's Location/Fill-mode/Show-files/Show-folders fields needs. */
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

function settingNamed(modal: unknown, name: string): any {
	const contentEl = (modal as any).contentEl;
	return contentEl.__settings.find((s: any) => s.name === name);
}

describe("folder-source-config-regression — G15: Location toggle clears path only", () => {
	it("Inside -> Outside -> Inside clears folderPath/outsidePath but leaves Show files/Show folders/Fill mode untouched", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Show files").components[0].flip(false);
		settingNamed(modal, "Show folders").components[0].flip(true);
		settingNamed(modal, "Fill mode").components[0].select("append");
		(modal as any).folderPath = "Projects/Sub";

		settingNamed(modal, "Location").components[0].select("outside");
		expect((modal as any).folderPath).toBe("");
		expect((modal as any).outsidePath).toBe("");
		expect(settingNamed(modal, "Show files").components[0].value).toBe(false);
		expect(settingNamed(modal, "Show folders").components[0].value).toBe(true);
		expect(settingNamed(modal, "Fill mode").components[0].value).toBe("append");

		settingNamed(modal, "Path").components[0].type("/Volumes/External/Notes");
		settingNamed(modal, "Location").components[0].select("inside");

		expect((modal as any).folderPath).toBe("");
		expect((modal as any).outsidePath).toBe("");
		expect(settingNamed(modal, "Show files").components[0].value).toBe(false);
		expect(settingNamed(modal, "Show folders").components[0].value).toBe(true);
		expect(settingNamed(modal, "Fill mode").components[0].value).toBe("append");
	});

	it("an existing FolderSourceConfig with mode=\"overwrite\" pre-selects it, and toggling Location to Outside and back leaves it as \"overwrite\"", () => {
		const folderSource = {
			type: "folder" as const,
			location: "inside" as const,
			path: "Projects",
			showFiles: true,
			showFolders: false,
			mode: "overwrite" as const,
		};
		const modal = new ApiSourceModal({} as any, null, [], vi.fn(), folderSource);
		(modal as any).onOpen();

		expect(settingNamed(modal, "Fill mode").components[0].value).toBe("overwrite");

		settingNamed(modal, "Location").components[0].select("outside");
		settingNamed(modal, "Location").components[0].select("inside");

		expect(settingNamed(modal, "Fill mode").components[0].value).toBe("overwrite");
		expect(settingNamed(modal, "Show files").components[0].value).toBe(true);
		expect(settingNamed(modal, "Show folders").components[0].value).toBe(false);
	});

	it("saving a folder source after switching Fill mode persists the chosen mode in the resulting FolderSourceConfig", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		(modal as any).folderPath = "Projects";
		settingNamed(modal, "Fill mode").components[0].select("append");
		(modal as any).updateSaveButton();

		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "folder",
				source: expect.objectContaining({ mode: "append", location: "inside", path: "Projects" }),
			})
		);
	});
});
