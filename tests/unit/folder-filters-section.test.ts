import { describe, expect, it, vi } from "vitest";

/** PR-1.F1: the Folder modal's "File filters" section. The "obsidian" package ships types only, so
 * this file fakes the few runtime pieces the modal touches, following `api-source-modal.test.ts`.
 * Each fake element records its listeners and classes so a test can dispatch focus/mousedown and
 * read the red-outline class directly. */
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
		/** Simulates the user typing into the field. */
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

/** Two notes with mixed-case keys, plus one note with no frontmatter: the suggester should offer
 * `status`, `company` and `tags` once each. */
function mockApp() {
	const notes = [
		{ path: "Jobs/acme.md", frontmatter: { Status: "active", company: "Acme" } },
		{ path: "Jobs/beta.md", frontmatter: { status: "done", tags: ["job"] } },
		{ path: "Jobs/brief.md", frontmatter: null },
	];
	return {
		vault: {
			getRoot: () => ({ path: "/", children: [] }),
			getFiles: () => notes.map((n) => ({ path: n.path })),
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const note = notes.find((n) => n.path === file.path);
				return note?.frontmatter ? { frontmatter: note.frontmatter } : {};
			},
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

function openModal(source: FolderSourceConfig = folderSource()) {
	const modal = new ApiSourceModal(mockApp() as any, null, [], vi.fn(), source);
	(modal as any).onOpen();
	return modal;
}

function settingNamed(modal: unknown, name: string): any {
	return (modal as any).contentEl.__settings.find((s: any) => s.name === name);
}

function hasSettingNamed(modal: unknown, name: string): boolean {
	return settingNamed(modal, name) !== undefined;
}

/** A rule row is an unnamed setting with a key field, a value field and a trash button. */
function ruleRows(modal: unknown): any[] {
	return (modal as any).contentEl.__settings.filter((s: any) => s.name === "" && s.components.length === 3);
}

function addRuleButton(modal: unknown): any {
	return (modal as any).contentEl.__settings
		.find((s: any) => s.components[0]?.buttonEl?.textContent === "+ Add YAML rule")
		.components[0];
}

/** The "Key required" line for each rule, in render order. */
function ruleErrors(modal: unknown): any[] {
	return (modal as any).contentEl.children.filter((c: any) => (c.cls ?? "").includes("atlas-yaml-key-error"));
}

/** The key suggestion list belonging to the rule at `index`, in render order. */
function suggestionLists(modal: unknown): any[] {
	return (modal as any).contentEl.children.filter((c: any) => (c.cls ?? "").includes("atlas-yaml-key-suggest"));
}

function addRule(modal: unknown): void {
	addRuleButton(modal).simulateClick();
}

/** Every setting name and every rendered paragraph/heading text in the modal, joined. */
function allText(modal: unknown): string {
	const names = (modal as any).contentEl.__settings.map((s: any) => s.name);
	const texts = (modal as any).contentEl.children.map((c: any) => c.textContent);
	return [...names, ...texts].join("\n");
}

describe("PR-1.F1 — File filters section visibility (G1, G9, G11)", () => {
	it.each([
		{ showFiles: true, location: "inside", visible: true },
		{ showFiles: false, location: "inside", visible: false },
		{ showFiles: true, location: "outside", visible: false },
		{ showFiles: false, location: "outside", visible: false },
	] as const)("showFiles=$showFiles, location=$location → section visible: $visible", ({ showFiles, location, visible }) => {
		const modal = openModal(
			folderSource({
				showFiles,
				location,
				path: location === "inside" ? "Jobs" : "",
			})
		);
		expect(hasSettingNamed(modal, "File filters")).toBe(visible);
	});

	it("shows and hides the section live as Show files is toggled, without closing the modal", () => {
		const modal = openModal();
		expect(hasSettingNamed(modal, "File filters")).toBe(true);

		settingNamed(modal, "Show files").components[0].flip(false);
		expect(hasSettingNamed(modal, "File filters")).toBe(false);

		settingNamed(modal, "Show files").components[0].flip(true);
		expect(hasSettingNamed(modal, "File filters")).toBe(true);
	});

	it("shows and hides the section live when the source switches between inside and outside vault", () => {
		const modal = openModal();
		expect(hasSettingNamed(modal, "File filters")).toBe(true);

		settingNamed(modal, "Location").components[0].select("outside");
		expect(hasSettingNamed(modal, "File filters")).toBe(false);

		settingNamed(modal, "Location").components[0].select("inside");
		expect(hasSettingNamed(modal, "File filters")).toBe(true);
	});

	it("leaves the section unaffected by Show folders, with no Folder filters UI at all (G10, F2)", () => {
		for (const showFolders of [true, false]) {
			const modal = openModal(folderSource({ showFolders }));
			expect(hasSettingNamed(modal, "File filters")).toBe(true);
			expect(hasSettingNamed(modal, "Folder filters")).toBe(false);
			expect(allText(modal)).not.toMatch(/Folder filters/);
		}
		const modal = openModal();
		settingNamed(modal, "Show folders").components[0].flip(false);
		expect(hasSettingNamed(modal, "Folder filters")).toBe(false);
		expect(hasSettingNamed(modal, "File filters")).toBe(true);
	});
});

describe("PR-1.F1 — rule rows (G1, G2)", () => {
	it("starts with no rows and only the add button when there are no stored rules", () => {
		const modal = openModal();
		expect(ruleRows(modal)).toHaveLength(0);
		expect(addRuleButton(modal).buttonEl.textContent).toBe("+ Add YAML rule");
	});

	it("loads the stored rules in their saved order, with keys and values as entered", () => {
		const modal = openModal(
			folderSource({
				filters: {
					files: {
						yaml: {
							rules: [
								{ key: "Status", value: "Active" },
								{ key: "company", value: "[[Gamma Ltd]]" },
							],
						},
					},
				},
			})
		);
		const rows = ruleRows(modal);
		expect(rows).toHaveLength(2);
		expect(rows[0].components[0].value).toBe("Status");
		expect(rows[0].components[1].value).toBe("Active");
		expect(rows[1].components[0].value).toBe("company");
		expect(rows[1].components[1].value).toBe("[[Gamma Ltd]]");
	});

	it("adds a row with a key field and a value field, outlined as Key required straight away", () => {
		const modal = openModal();
		addRule(modal);
		expect(ruleRows(modal)).toHaveLength(1);
		expect(ruleRows(modal)[0].components).toHaveLength(3);
		expect(ruleErrors(modal)[0].textContent).toBe("Key required");
	});

	it("edits a rule in place, and the trash button removes just that rule", () => {
		const modal = openModal();
		addRule(modal);
		addRule(modal);
		const [first, second] = ruleRows(modal);
		first.components[0].type("status");
		first.components[1].type("active");
		second.components[0].type("tags");
		second.components[1].type("job");

		// Trash the first rule: the second survives with its own values.
		first.components[2].clickCallback();
		const rows = ruleRows(modal);
		expect(rows).toHaveLength(1);
		expect(rows[0].components[0].value).toBe("tags");
		expect(rows[0].components[1].value).toBe("job");
	});

	it("leaves only the add button when the only rule is trashed", () => {
		const modal = openModal();
		addRule(modal);
		ruleRows(modal)[0].components[2].clickCallback();
		expect(ruleRows(modal)).toHaveLength(0);
		expect(addRuleButton(modal)).toBeDefined();
	});

	it("keeps two rules on the same key, in order", () => {
		const modal = openModal();
		addRule(modal);
		addRule(modal);
		const [first, second] = ruleRows(modal);
		first.components[0].type("status");
		first.components[1].type("active");
		second.components[0].type("status");
		second.components[1].type("done");
		expect(ruleRows(modal).map((r) => r.components[1].value)).toEqual(["active", "done"]);
	});
});

describe("PR-1.F1 — key suggestions (G1, GP3)", () => {
	it("suggests frontmatter keys case-insensitively de-duplicated once the key field is focused and typed into", () => {
		const modal = openModal();
		addRule(modal);
		const key = ruleRows(modal)[0].components[0];
		key.inputEl.dispatch("focus");
		key.type("st");
		const items = suggestionLists(modal)[0].children.map((c: any) => c.textContent);
		expect(items).toEqual(["status"]);
	});

	it("lists no suggestions before the key field has focus", () => {
		const modal = openModal();
		addRule(modal);
		ruleRows(modal)[0].components[0].type("st");
		expect(suggestionLists(modal)[0].children).toHaveLength(0);
	});

	it("picking a suggestion sets the key without a full re-render, and hides the list", () => {
		const modal = openModal();
		addRule(modal);
		const row = ruleRows(modal)[0];
		row.components[0].inputEl.dispatch("focus");
		row.components[0].type("st");
		const item = suggestionLists(modal)[0].children[0];
		item.dispatch("mousedown");
		expect(row.components[0].value).toBe("status");
		expect(suggestionLists(modal)[0].children).toHaveLength(0);
		expect(ruleRows(modal)[0]).toBe(row);
	});

	it("accepts a key that is not in the vault as free text, with no error and no suggestions", () => {
		const modal = openModal();
		addRule(modal);
		const key = ruleRows(modal)[0].components[0];
		key.inputEl.dispatch("focus");
		key.type("my custom: key");
		expect(suggestionLists(modal)[0].children).toHaveLength(0);
		expect(ruleErrors(modal)[0].textContent).toBe("");
	});

	it("value field has no suggester or autocomplete attached (F8)", () => {
		const modal = openModal();
		addRule(modal);
		const value = ruleRows(modal)[0].components[1];
		expect(Object.keys(value.inputEl.__listeners)).toEqual([]);
	});
});

describe("PR-1.F1 — empty-key validation (E5)", () => {
	it("outlines a rule with an empty key red and shows \"Key required\"", () => {
		const modal = openModal();
		addRule(modal);
		const key = ruleRows(modal)[0].components[0];
		expect(key.inputEl.classes.has("atlas-yaml-key-invalid")).toBe(true);
		expect(ruleErrors(modal)[0].textContent).toBe("Key required");
	});

	it("treats a whitespace-only key as empty", () => {
		const modal = openModal();
		addRule(modal);
		const key = ruleRows(modal)[0].components[0];
		key.type("   ");
		expect(key.inputEl.classes.has("atlas-yaml-key-invalid")).toBe(true);
		expect(ruleErrors(modal)[0].textContent).toBe("Key required");
	});

	it("clears the outline and the message as soon as a key is typed", () => {
		const modal = openModal();
		addRule(modal);
		const key = ruleRows(modal)[0].components[0];
		key.type("s");
		expect(key.inputEl.classes.has("atlas-yaml-key-invalid")).toBe(false);
		expect(ruleErrors(modal)[0].textContent).toBe("");
	});

	it("does not outline a whitespace-only value, since only the key is required", () => {
		const modal = openModal();
		addRule(modal);
		const row = ruleRows(modal)[0];
		row.components[0].type("status");
		row.components[1].type("   ");
		expect(row.components[0].inputEl.classes.has("atlas-yaml-key-invalid")).toBe(false);
		expect(ruleErrors(modal)[0].textContent).toBe("");
	});
});

describe("PR-1.F1 — rules are kept while the section is hidden (G9)", () => {
	it("keeps rules and their values when Show files is toggled off then on", () => {
		const modal = openModal();
		addRule(modal);
		const row = ruleRows(modal)[0];
		row.components[0].type("status");
		row.components[1].type("active");

		settingNamed(modal, "Show files").components[0].flip(false);
		expect(ruleRows(modal)).toHaveLength(0);

		settingNamed(modal, "Show files").components[0].flip(true);
		const restored = ruleRows(modal);
		expect(restored).toHaveLength(1);
		expect(restored[0].components[0].value).toBe("status");
		expect(restored[0].components[1].value).toBe("active");
	});
});
