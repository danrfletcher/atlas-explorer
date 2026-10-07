import { describe, expect, it, vi } from "vitest";

/** PR-1.F1: what the Folder modal's Save writes for `filters`. The Obsidian fake follows
 * `folder-filters-section.test.ts`, which follows `api-source-modal.test.ts`. */
vi.mock("obsidian", () => {
	function createFakeElement(): any {
		const el: any = {
			children: [] as any[],
			__settings: [] as any[],
			cls: undefined as string | undefined,
			textContent: "",
			scrollTop: 0,
			classes: new Set<string>(),
			classList: {
				toggle(name: string, on?: boolean) {
					const want = on ?? !el.classes.has(name);
					if (want) el.classes.add(name);
					else el.classes.delete(name);
					return want;
				},
				contains(name: string) {
					return el.classes.has(name);
				},
			},
			empty() {
				this.children = [];
				this.__settings = [];
				this.scrollTop = 0;
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
			__listeners: {} as Record<string, ((evt: any) => void)[]>,
			addEventListener(type: string, cb: (evt: any) => void) {
				(this.__listeners[type] ??= []).push(cb);
			},
			dispatch(type: string, evt: any = {}) {
				for (const cb of this.__listeners[type] ?? []) cb({ preventDefault() {}, ...evt });
			},
		};
		return el;
	}

	class FakeTextComponent {
		inputEl: any = createFakeElement();
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
		private changeCb?: (v: string) => void;
		addOption() {
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
		clickCallback?: () => void;
		setIcon() {
			return this;
		}
		setTooltip() {
			return this;
		}
		onClick(cb: () => void) {
			this.clickCallback = cb;
			return this;
		}
	}

	class FakeSetting {
		name = "";
		components: any[] = [];
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

	return {
		App: class {},
		ButtonComponent: FakeButtonComponent,
		Modal: FakeModal,
		Notice: class {},
		Platform: { isMobile: false },
		Setting: FakeSetting,
		TFolder: class {},
		TFile: class {},
		requestUrl: async () => ({ status: 200, text: "[]" }),
		setTooltip: vi.fn(),
	};
});

import { ApiSourceModal } from "../../src/api-source-modal";
import type { FolderSourceConfig } from "../../src/types";

function mockApp() {
	return {
		vault: {
			getRoot: () => ({ path: "/", children: [] }),
			getFiles: () => [{ path: "Jobs/acme.md" }],
		},
		metadataCache: {
			getFileCache: () => ({ frontmatter: { Status: "active" } }),
		},
	};
}

function folderSource(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		type: "folder",
		location: "inside",
		path: "Jobs",
		showFiles: true,
		showFolders: true,
		mode: "merge",
		...overrides,
	} as FolderSourceConfig;
}

function openModal(source: FolderSourceConfig, onSave = vi.fn(), outsidePath = "") {
	const modal = new ApiSourceModal(mockApp() as any, null, [], onSave, source, outsidePath);
	(modal as any).onOpen();
	return modal;
}

function settingNamed(modal: unknown, name: string): any {
	return (modal as any).contentEl.__settings.find((s: any) => s.name === name);
}

function ruleRows(modal: unknown): any[] {
	return (modal as any).contentEl.__settings.filter((s: any) => s.name === "" && s.components.length === 3);
}

function addRule(modal: unknown): void {
	(modal as any).contentEl.__settings
		.find((s: any) => s.components[0]?.buttonEl?.textContent === "+ Add YAML rule")
		.components[0].simulateClick();
}

function save(modal: unknown): void {
	(modal as any).saveButton.simulateClick();
}

/** The config the modal's Save handed to `onSave`. */
function savedSource(onSave: ReturnType<typeof vi.fn>): FolderSourceConfig {
	expect(onSave).toHaveBeenCalledTimes(1);
	return onSave.mock.calls[0][0].source as FolderSourceConfig;
}

describe("PR-1.F1 — Save builds filters.files.yaml.rules (G2, E5)", () => {
	it("saves each rule's trimmed key and value through the S1 sanitizer", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource(), onSave);
		addRule(modal);
		const row = ruleRows(modal)[0];
		row.components[0].type("  status ");
		row.components[1].type(" active ");
		save(modal);
		expect(savedSource(onSave).filters).toEqual({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } });
	});

	it("drops empty-key and whitespace-only-key rules on Save, keeping the valid ones in order", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource(), onSave);
		for (let i = 0; i < 4; i++) addRule(modal);
		const [a, b, c, d] = ruleRows(modal);
		a.components[0].type("status");
		a.components[1].type("active");
		b.components[0].type("");
		b.components[1].type("ignored");
		c.components[0].type("   ");
		c.components[1].type("ignored");
		d.components[0].type("company");
		d.components[1].type("Acme");
		save(modal);
		expect(savedSource(onSave).filters).toEqual({
			files: {
				yaml: {
					rules: [
						{ key: "status", value: "active" },
						{ key: "company", value: "Acme" },
					],
				},
			},
		});
	});

	it("saves a whitespace-only value as an empty value, meaning key present", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource(), onSave);
		addRule(modal);
		const row = ruleRows(modal)[0];
		row.components[0].type("tags");
		row.components[1].type("   ");
		save(modal);
		expect(savedSource(onSave).filters).toEqual({ files: { yaml: { rules: [{ key: "tags", value: "" }] } } });
	});

	it("leaves the source unfiltered when no valid rule remains after dropping empty keys", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource(), onSave);
		addRule(modal);
		save(modal);
		expect(savedSource(onSave).filters).toBeUndefined();
	});

	it("keeps Save enabled with an invalid rule present", () => {
		const modal = openModal(folderSource());
		addRule(modal);
		expect((modal as any).saveButton.disabled).toBe(false);
	});

	it("keeps unicode, spaces, colons and quotes in keys and values unchanged through Save", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource(), onSave);
		addRule(modal);
		const row = ruleRows(modal)[0];
		row.components[0].type("créé: \"date\"");
		row.components[1].type("Zürich 'é' [[Gamma Ltd]]");
		save(modal);
		expect(savedSource(onSave).filters).toEqual({
			files: { yaml: { rules: [{ key: "créé: \"date\"", value: "Zürich 'é' [[Gamma Ltd]]" }] } },
		});
	});

	it("saves rules while Show files is off, so they survive being hidden", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource({ filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } } }), onSave);
		settingNamed(modal, "Show files").components[0].flip(false);
		save(modal);
		expect(savedSource(onSave).showFiles).toBe(false);
		expect(savedSource(onSave).filters).toEqual({ files: { yaml: { rules: [{ key: "status", value: "active" }] } } });
	});

	it("carries no rules for an Outside-vault source", () => {
		const onSave = vi.fn();
		const modal = openModal(
			folderSource({
				location: "outside",
				path: "",
				filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } },
			}),
			onSave,
			"/Users/you/External"
		);
		save(modal);
		expect(savedSource(onSave).filters).toBeUndefined();
	});
});

describe("PR-1.F1 — saved rules round-trip through reopening the modal (G2)", () => {
	it("shows the saved rules in order, with keys and values as entered", () => {
		const onSave = vi.fn();
		const modal = openModal(folderSource(), onSave);
		addRule(modal);
		addRule(modal);
		const [first, second] = ruleRows(modal);
		first.components[0].type("Status");
		first.components[1].type("Active");
		second.components[0].type("company");
		second.components[1].type("[[Gamma Ltd]]");
		save(modal);

		const reopened = openModal(savedSource(onSave));
		const rows = ruleRows(reopened);
		expect(rows.map((r) => [r.components[0].value, r.components[1].value])).toEqual([
			["Status", "Active"],
			["company", "[[Gamma Ltd]]"],
		]);
	});
});

describe("PR-1.F1 — closing without Save leaves stored rules untouched (G2)", () => {
	it("does not write edits made in the modal to the stored source", () => {
		const stored = folderSource({ filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } } });
		const snapshot = structuredClone(stored);
		const modal = openModal(stored);
		const row = ruleRows(modal)[0];
		row.components[1].type("done");
		addRule(modal);
		(modal as any).close();
		expect(stored).toEqual(snapshot);
	});
});
