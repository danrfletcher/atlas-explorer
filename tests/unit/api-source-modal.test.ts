import { describe, expect, it, vi } from "vitest";

/** Fix 2 (Round 1 human testing), corrected in Round 2 (T1-T5): the real Obsidian `Modal`'s
 * scrolling element is `modalEl` (the ancestor `.modal`), not `contentEl` (`.modal-content`, which
 * never itself scrolls in this modal's layout) — clearing/rebuilding `contentEl`'s content (as every
 * `render()` does) leaves `modalEl`'s scroll position to drift in a real browser, that's the bug.
 * Mutable so individual tests can control the mocked HTTP response `fetchSample()` receives; declared
 * via `vi.hoisted` since `vi.mock` factories are hoisted above regular imports/consts. */
const mockHttpResponse = vi.hoisted(() => ({ status: 200, text: "[]" }));

/** T1: the real bug only shows up in Obsidian's actual `ButtonComponent`, whose click listener is
 * bound once at construction and gates on the component's own `disabled` field — not whatever gets
 * poked onto `buttonEl.disabled` afterwards. The "obsidian" package ships types only (no runtime), so
 * no test here can use the real class; instead this mock reproduces that exact gating rule (see
 * `FakeButtonComponent.simulateClick`) so a test can fail against the old bug and pass against the
 * fix without ever touching real DOM/Obsidian internals. */
vi.mock("obsidian", () => {
	function createFakeElement(onEmpty?: () => void): any {
		const el: any = {
			children: [] as any[],
			__settings: [] as any[],
			cls: undefined as string | undefined,
			textContent: "",
			scrollTop: 0,
			empty() {
				this.children = [];
				this.__settings = [];
				this.scrollTop = 0;
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
			__listeners: {} as Record<string, ((evt: any) => void)[]>,
			addEventListener(type: string, cb: (evt: any) => void) {
				(this.__listeners[type] ??= []).push(cb);
			},
			/** Simulates a real DOM event dispatch for the drop handlers under test — real drag-and-drop
			 * verification is a container/manual-testing concern (see PR-6.C spec), this only exercises
			 * the same event-handling code path at the unit level. */
			dispatch(type: string, evt: any) {
				for (const cb of this.__listeners[type] ?? []) cb(evt);
			},
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
		/** Simulates the user typing a new value into the field. */
		type(v: string) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeToggleComponent {
		value = false;
		disabled = false;
		private changeCb?: (v: boolean) => void;
		setValue(v: boolean) {
			this.value = v;
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			return this;
		}
		onChange(cb: (v: boolean) => void) {
			this.changeCb = cb;
			return this;
		}
		/** Simulates the user flipping the toggle. */
		flip(v: boolean) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeDropdownComponent {
		value = "";
		/** PR-3: options recorded in add order, so a test can assert exactly which/how many were added. */
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
		/** Simulates the user picking a different option. */
		select(v: string) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeButtonComponent {
		buttonEl: any = createFakeElement();
		/** The gate Obsidian's real click listener actually checks. */
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
			this.buttonEl.disabled = d;
			return this;
		}
		onClick(cb: () => void) {
			this.clickCallback = cb;
			return this;
		}
		/** Mirrors Obsidian's real click handler (`if (this.disabled || !cb) return; cb();`), gated on
		 * the component's own field — never on `buttonEl.disabled` directly. */
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
		/** Never cleared by `render()` in the real modal — only `contentEl` is. Its `scrollTop` is set
		 * to drift on every `contentEl.empty()` here to mirror the real bug (T1): clearing/regrowing
		 * `contentEl`'s content disturbs `modalEl`'s visible scroll position even though nothing in
		 * `render()` writes to `modalEl` directly, so a test can fail against code that reads/writes
		 * `contentEl.scrollTop` (always 0, never the real scrolling element) and pass only against a
		 * fix that captures/restores `modalEl.scrollTop` itself. */
		modalEl: any = createFakeElement();
		contentEl: any = createFakeElement(() => {
			this.modalEl.scrollTop = 0;
		});
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
		requestUrl: async () => mockHttpResponse,
		setTooltip: vi.fn(),
	};
});

import { ApiSourceModal } from "../../src/api-source-modal";
import { ApiSourceConfig } from "../../src/types";

function settingNamed(modal: unknown, name: string): any {
	const contentEl = (modal as any).contentEl;
	return contentEl.__settings.find((s: any) => s.name === name);
}

/** Drop zones live in a `Setting`'s `controlEl`, which the fake `Setting` never attaches to its
 * container's `children` — so finding them needs to walk both the element tree and every setting's
 * `controlEl` recorded on `contentEl.__settings`. Order matches render order: the three
 * `MAPPING_TARGETS` zones (ID, Label, Secondary), then one per existing extra field, then the
 * "add extra field" zone last. */
function findAllByClass(el: any, cls: string, seen = new Set<unknown>()): any[] {
	if (!el || seen.has(el)) return [];
	seen.add(el);
	const out: any[] = [];
	if ((el.cls ?? "").split(/\s+/).includes(cls)) out.push(el);
	for (const child of el.children ?? []) out.push(...findAllByClass(child, cls, seen));
	for (const setting of el.__settings ?? []) out.push(...findAllByClass(setting.controlEl, cls, seen));
	return out;
}

function dropField(dropZone: any, field: string): void {
	dropZone.dispatch("drop", { preventDefault() {}, dataTransfer: { getData: () => field } });
}

function validConfig(): ApiSourceConfig {
	return {
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
	};
}

describe("T1/T3/T5/T7 — ApiSourceModal's Save button after an empty-then-valid 'Refresh every' edit", () => {
	it("stays clickable through the exact repro sequence: enable while blank (forces a re-render with a disabled Save), then type a valid value", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, validConfig(), [], onSave);
		(modal as any).onOpen();

		// GP5 / T5: mode Overwrite, "refresh on view load" on.
		settingNamed(modal, "Fill mode").components[0].select("overwrite");
		settingNamed(modal, "Refresh when Atlas view loads").components[0].flip(true);

		// T1 step 1: turn ON "Refresh every" while its minutes field is still blank — this is the
		// full render() that (pre-fix) left a fresh, permanently-disabled Save button behind.
		settingNamed(modal, "Refresh every").components[0].flip(true);

		const minutesField = () => settingNamed(modal, "Refresh every").components[1];
		const errorText = () => (modal as any).contentEl.children.find((c: any) => c.cls === "atlas-api-field-error")?.textContent;

		// Toggling on from blank now pre-fills the floor (MIN_REFRESH_MINUTES) instead of leaving the
		// field empty, so this is already a valid value and Save stays enabled — no premature error.
		expect(errorText()).toBeFalsy();
		expect((modal as any).saveButton.disabled).toBe(false);

		// T7 / C38 checkpoint 2: 3, 4 and blank are all rejected with an inline error and a blocked Save.
		for (const bad of ["3", "4", ""]) {
			minutesField().type(bad);
			expect(errorText()).toBeTruthy();
			expect((modal as any).saveButton.disabled).toBe(true);
		}

		// T1 step 2: type a valid value. Pre-fix, updateSaveButton() only touched the raw buttonEl's
		// `.disabled` attribute, never the ButtonComponent's own field the click handler gates on, so
		// the button stayed permanently unresponsive from here on.
		minutesField().type("60");
		expect(errorText()).toBeFalsy();
		expect((modal as any).saveButton.disabled).toBe(false);

		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave).toHaveBeenCalledWith({
			type: "api",
			source: expect.objectContaining({
				mode: "overwrite",
				refreshOnViewLoad: true,
				refreshEveryMinutesEnabled: true,
				refreshEveryMinutes: 60,
			}),
			headers: [],
		});
	});

	it("supports click action configuration and validates command placeholders", () => {
		const onSave = vi.fn();
		const config = validConfig();
		config.mapping.extraFields = { path: "item_path" };
		const modal = new ApiSourceModal({} as any, config, [], onSave);
		(modal as any).onOpen();

		// Switch click action to run-command
		const clickActionSetting = settingNamed(modal, "Action on click");
		expect(clickActionSetting).toBeTruthy();
		clickActionSetting.components[0].select("run-command");

		// Check warning text exists
		const warningEl = (modal as any).contentEl.children.find((c: any) => c.cls === "atlas-api-command-warning");
		expect(warningEl?.textContent).toContain("Commands run with the user's trust");

		// Command setting is now present
		const commandSetting = settingNamed(modal, "Command");
		expect(commandSetting).toBeTruthy();

		const commandField = commandSetting.components[0];
		const errorEls = () => (modal as any).contentEl.children.filter((c: any) => c.cls === "atlas-api-field-error");

		// Type unbalanced quote -> rejected
		commandField.type('echo "hello');
		expect((modal as any).saveButton.disabled).toBe(true);
		expect(errorEls().some((e: any) => e.textContent.includes("Unbalanced quote"))).toBe(true);

		// Type unknown placeholder -> rejected
		commandField.type("echo {unknown_prop}");
		expect((modal as any).saveButton.disabled).toBe(true);
		expect(errorEls().some((e: any) => e.textContent.includes("Unknown placeholder"))).toBe(true);

		// Type valid placeholder -> accepted
		commandField.type("echo {path}");
		expect((modal as any).saveButton.disabled).toBe(false);

		// Save and verify payload
		(modal as any).saveButton.simulateClick();
		expect(onSave).toHaveBeenCalledWith({
			type: "api",
			source: expect.objectContaining({
				action: "run-command",
				clickAction: "run-command",
				command: "echo {path}",
				mapping: expect.objectContaining({
					extraFields: { path: "item_path" },
				}),
			}),
			headers: [],
		});
	});
});

describe("Fix 2 (Round 1 human testing) — Fetch sample / Test preserve the modal's scroll position", () => {
	it("render() restores modalEl.scrollTop across a full re-render", () => {
		// PR-6.C round 3: scroll preservation moved from an opt-in renderPreservingScroll() wrapper
		// (only 5 of ~20 call sites remembered to use it) into render() itself, unconditionally, so
		// every call site — present and future — is covered with nothing separate to remember.
		const modal = new ApiSourceModal({} as any, validConfig(), [], vi.fn());
		(modal as any).onOpen();

		(modal as any).modalEl.scrollTop = 240;
		(modal as any).render();

		expect((modal as any).modalEl.scrollTop).toBe(240);
	});

	it("runTest() preserves the modal's scroll position instead of letting it drift", async () => {
		const modal = new ApiSourceModal({} as any, validConfig(), [], vi.fn());
		(modal as any).onOpen();
		(modal as any).lastResponse = [{ id: "1", name: "One" }];

		(modal as any).modalEl.scrollTop = 180;
		await (modal as any).runTest();

		expect((modal as any).modalEl.scrollTop).toBe(180);
		// Regression: the test result content itself still updates — only scroll is unaffected.
		expect((modal as any).testResult).toContain("1 row(s)");
	});

	it("fetchSample() preserves the modal's scroll position instead of letting it drift", async () => {
		mockHttpResponse.status = 200;
		mockHttpResponse.text = JSON.stringify([{ id: "1", name: "One" }]);
		const modal = new ApiSourceModal({} as any, validConfig(), [], vi.fn());
		(modal as any).onOpen();

		(modal as any).modalEl.scrollTop = 300;
		await (modal as any).fetchSample();

		expect((modal as any).modalEl.scrollTop).toBe(300);
		// Regression: the sample content itself still updates — only scroll is unaffected.
		expect((modal as any).sampleFields).toContain("id");
	});
});

describe("PR-6.C fix — scroll position resets on the drop-triggered re-render", () => {
	async function modalWithSample(): Promise<ApiSourceModal> {
		mockHttpResponse.status = 200;
		mockHttpResponse.text = JSON.stringify([{ id: "1", name: "One", extra: "x" }]);
		const modal = new ApiSourceModal({} as any, validConfig(), [], vi.fn());
		(modal as any).onOpen();
		await (modal as any).fetchSample();
		return modal;
	}

	it("dropping a field onto a mapping target (ID/Label/Secondary) preserves scroll", async () => {
		const modal = await modalWithSample();
		const [idZone] = findAllByClass((modal as any).contentEl, "atlas-api-drop-zone");

		(modal as any).modalEl.scrollTop = 275;
		dropField(idZone, "id");

		expect((modal as any).modalEl.scrollTop).toBe(275);
		// Regression: the drop itself still assigns the mapping.
		expect((modal as any).mapping.idField).toBe("id");
	});

	it("dropping a field onto an existing extra field's target preserves scroll", async () => {
		const modal = await modalWithSample();
		(modal as any).extraFields = [{ name: "path", field: "" }];
		(modal as any).render();

		const zones = findAllByClass((modal as any).contentEl, "atlas-api-drop-zone");
		// After the 3 MAPPING_TARGETS zones comes the one for the existing extra field.
		const extraZone = zones[3];

		(modal as any).modalEl.scrollTop = 150;
		dropField(extraZone, "extra");

		expect((modal as any).modalEl.scrollTop).toBe(150);
		// Regression: the drop itself still assigns the extra field's mapping.
		expect((modal as any).extraFields[0].field).toBe("extra");
	});

	it("dropping a field onto the 'add extra field' zone preserves scroll", async () => {
		const modal = await modalWithSample();
		const zones = findAllByClass((modal as any).contentEl, "atlas-api-drop-zone");
		// With no existing extra fields, the "add extra field" zone is the last one after ID/Label/Secondary.
		const addZone = zones[zones.length - 1];

		(modal as any).modalEl.scrollTop = 90;
		dropField(addZone, "extra");

		expect((modal as any).modalEl.scrollTop).toBe(90);
		// Regression: the drop itself still creates a new extra field mapped to the dropped field.
		expect((modal as any).extraFields).toHaveLength(1);
		expect((modal as any).extraFields[0].field).toBe("extra");
	});
});

describe("PR-3 — source type dropdown and modal-body switching", () => {
	it("dropdown renders 4 options, none pre-selected on open", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		const dropdown = settingNamed(modal, "Source type").components[0];
		expect(dropdown.options).toEqual([
			{ value: "api", label: "API" },
			{ value: "folder", label: "Folder" },
			{ value: "markdown-table", label: "Markdown table" },
			{ value: "csv", label: "CSV" },
		]);
		expect(dropdown.value).toBe("");
	});

	it("modal body stays empty until a type is selected", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		expect(settingNamed(modal, "URL")).toBeUndefined();
		expect(settingNamed(modal, "Fill mode")).toBeUndefined();
		expect((modal as any).saveButton.disabled).toBe(true);
	});

	it("type-switch discards old config, defaults unselected", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, validConfig(), [], onSave);
		(modal as any).onOpen();

		settingNamed(modal, "URL").components[0].type("https://changed.example.com/items");
		expect(settingNamed(modal, "URL").components[0].value).toBe("https://changed.example.com/items");

		// Switching away from "api" removes the API config section entirely — a stub type has no
		// fields of its own to carry anything over into.
		settingNamed(modal, "Source type").components[0].select("folder");
		expect(settingNamed(modal, "URL")).toBeUndefined();

		// Switching back into "api" starts from a blank config, not the earlier edited value — no
		// stale fields leak across the switch.
		settingNamed(modal, "Source type").components[0].select("api");
		expect(settingNamed(modal, "URL").components[0].value).toBe("");
	});

	it("selecting API renders existing API config form with unchanged fields", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("api");

		// The pre-existing API config form renders unchanged: URL, the disabled "GET" Method field,
		// and the same Fill mode options/default as before this PR.
		expect(settingNamed(modal, "URL")).toBeTruthy();
		const methodField = settingNamed(modal, "Method").components[0];
		expect(methodField.value).toBe("GET");
		expect(methodField.disabled).toBe(true);
		const fillModeDropdown = settingNamed(modal, "Fill mode").components[0];
		expect(fillModeDropdown.options.map((o: { value: string }) => o.value)).toEqual(["merge", "append", "overwrite"]);
		expect(fillModeDropdown.value).toBe("merge");

		// Filling in and saving a valid API config still works exactly as before the switch to
		// type-based rendering.
		settingNamed(modal, "URL").components[0].type("https://api.example.com/items");
		(modal as any).mapping = { idField: "id", labelField: "name" };
		(modal as any).updateSaveButton();
		expect((modal as any).saveButton.disabled).toBe(false);

		(modal as any).saveButton.simulateClick();
		expect(onSave).toHaveBeenCalledWith({
			type: "api",
			source: expect.objectContaining({ url: "https://api.example.com/items", method: "GET" }),
			headers: [],
		});
	});

	it("Save disabled/blocked when no type selected", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();

		expect((modal as any).saveButton.disabled).toBe(true);
		(modal as any).saveButton.simulateClick();
		expect(onSave).not.toHaveBeenCalled();

		// Still blocked after selecting a stub type — Table/CSV have no config of their own to ever
		// become savable against in this PR.
		settingNamed(modal, "Source type").components[0].select("markdown-table");
		expect((modal as any).saveButton.disabled).toBe(true);

		// Folder (PR-4) has a real config section, but Save stays blocked until a folder path is
		// chosen — the selector starts empty (GP1/PR-3 contract), not defaulted to anything.
		settingNamed(modal, "Source type").components[0].select("folder");
		expect((modal as any).saveButton.disabled).toBe(true);
	});
});

describe("R1 — Markdown Table: no auto-pick of the first table when there's a genuine choice", () => {
	function twoTables() {
		return [
			{ headers: ["id", "name"], rows: [{ id: "1", name: "One" }], skippedCount: 0 },
			{ headers: ["id", "name"], rows: [{ id: "2", name: "Two" }], skippedCount: 0 },
		];
	}

	it("a file with more than one table starts with no table selected, hides the mapping UI, and blocks Save until one is explicitly chosen", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();
		settingNamed(modal, "Source type").components[0].select("markdown-table");

		// Simulates the state right after "Load sample" detects two tables (R1 fix: index starts unset,
		// not auto-picked).
		(modal as any).mdTablePath = "notes/table.md";
		(modal as any).mdTables = twoTables();
		(modal as any).mdTableIndex = null;
		(modal as any).render();

		const tableDropdown = settingNamed(modal, "Table").components[0];
		expect(tableDropdown.value).toBe("");
		expect(tableDropdown.options[0]).toEqual({ value: "", label: "Choose a table…" });

		// Mapping stays hidden until a table is picked.
		expect(settingNamed(modal, "Mapping mode")).toBeUndefined();

		// Save stays blocked even once the mapping fields a user could otherwise reach are filled in
		// directly, since there's no table chosen for them to belong to.
		(modal as any).mapping = { idField: "id", labelField: "name" };
		expect((modal as any).canSave()).toBe(false);
		expect((modal as any).saveButton.disabled).toBe(true);
		(modal as any).saveButton.simulateClick();
		expect(onSave).not.toHaveBeenCalled();

		// Picking a table reveals the mapping UI and unblocks Save once mapped.
		tableDropdown.select("1");
		expect((modal as any).mdTableIndex).toBe(1);
		expect(settingNamed(modal, "Mapping mode")).toBeTruthy();
		expect((modal as any).saveButton.disabled).toBe(false);
	});

	it("a file with zero or exactly one table never shows the picker and the mapping UI renders immediately", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();
		settingNamed(modal, "Source type").components[0].select("markdown-table");

		(modal as any).mdTables = [twoTables()[0]];
		(modal as any).mdTableIndex = 0;
		(modal as any).render();

		expect(settingNamed(modal, "Table")).toBeUndefined();
		expect(settingNamed(modal, "Mapping mode")).toBeTruthy();
	});
});

describe("PR-4 — Folder source config section", () => {
	it("selecting Folder + Inside vault renders the folder path field and both Show toggles, path starting empty", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");

		expect(settingNamed(modal, "Location").components[0].value).toBe("inside");
		const folderField = settingNamed(modal, "Folder").components[0];
		expect(folderField.value).toBe("");
		expect(settingNamed(modal, "Show files").components[0].value).toBe(true);
		expect(settingNamed(modal, "Show folders").components[0].value).toBe(true);
		// PR-1 (G1): Folder sources have no refresh toggles at all — they always refresh.
		expect(settingNamed(modal, "Refresh when Atlas view loads")).toBeUndefined();
		expect(settingNamed(modal, "Refresh every")).toBeUndefined();
	});

	it("PR-5: selecting Outside vault shows a raw path field instead of the vault-folder suggester, but keeps the shared Show toggles", () => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn());
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		settingNamed(modal, "Location").components[0].select("outside");

		expect(settingNamed(modal, "Folder")).toBeUndefined();
		expect(settingNamed(modal, "Path")).toBeTruthy();
		expect(settingNamed(modal, "Show files")).toBeTruthy();
		expect(settingNamed(modal, "Show folders")).toBeTruthy();
	});

	it("Save stays disabled until a folder path is entered, then saves a FolderSourceConfig", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();

		settingNamed(modal, "Source type").components[0].select("folder");
		expect((modal as any).saveButton.disabled).toBe(true);

		settingNamed(modal, "Folder").components[0].type("Projects/Active");
		expect((modal as any).saveButton.disabled).toBe(false);

		(modal as any).saveButton.simulateClick();
		expect(onSave).toHaveBeenCalledWith({
			type: "folder",
			source: expect.objectContaining({
				type: "folder",
				location: "inside",
				path: "Projects/Active",
				showFiles: true,
				showFolders: true,
			}),
			outsidePath: "",
		});
	});

	it("an existing FolderSourceConfig pre-selects Folder and restores its fields", () => {
		const folderSource = {
			location: "inside" as const,
			path: "Archive",
			showFiles: false,
			showFolders: true,
		};
		const modal = new ApiSourceModal({} as any, null, [], vi.fn(), folderSource);
		(modal as any).onOpen();

		expect(settingNamed(modal, "Source type").components[0].value).toBe("folder");
		expect(settingNamed(modal, "Folder").components[0].value).toBe("Archive");
		expect(settingNamed(modal, "Show files").components[0].value).toBe(false);
		expect(settingNamed(modal, "Show folders").components[0].value).toBe(true);
		expect(settingNamed(modal, "Refresh when Atlas view loads")).toBeUndefined();
	});
});

describe("PR-1 (G1) — refresh toggles per source type", () => {
	const TOGGLE_NAMES = ["Refresh when Atlas view loads", "Refresh every"];

	function openWithType(type: "api" | "folder" | "csv" | "markdown-table", onSave = vi.fn()) {
		const modal = new ApiSourceModal({} as any, null, [], onSave);
		(modal as any).onOpen();
		settingNamed(modal, "Source type").components[0].select(type);
		return modal;
	}

	it("API sources show both refresh toggles", () => {
		const modal = openWithType("api");
		for (const name of TOGGLE_NAMES) expect(settingNamed(modal, name)).toBeTruthy();
	});

	it.each(["folder", "csv", "markdown-table"] as const)("%s sources hide both refresh toggles, in create mode", (type) => {
		const modal = openWithType(type);
		for (const name of TOGGLE_NAMES) expect(settingNamed(modal, name)).toBeUndefined();
	});

	it("CSV canSave ignores refresh settings: a valid path and mapping is savable with no refresh fields", () => {
		const modal = openWithType("csv");
		(modal as any).csvPath = "data.csv";
		(modal as any).mapping = { idField: "id", labelField: "name" };
		expect((modal as any).canSave()).toBe(true);
	});

	it("CSV save writes no removed refresh fields", () => {
		const onSave = vi.fn();
		const modal = openWithType("csv", onSave);
		(modal as any).csvPath = "data.csv";
		(modal as any).mapping = { idField: "id", labelField: "name" };
		(modal as any).render();
		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = JSON.stringify(onSave.mock.calls[0][0]);
		expect(saved).toContain("data.csv");
		expect(saved).not.toMatch(/refreshEveryMinutes|refreshOnViewLoad/);
	});

	it.each([
		["folder", { location: "inside" as const, path: "Projects", showFiles: true, showFolders: true }, undefined, undefined],
		["csv", undefined, { type: "csv" as const, path: "data.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const }, undefined],
		[
			"markdown-table",
			undefined,
			undefined,
			{ type: "markdown-table" as const, path: "notes/table.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge" as const },
		],
	])("%s sources hide both refresh toggles, in edit mode too", (type, folder, csv, md) => {
		const modal = new ApiSourceModal({} as any, null, [], vi.fn(), folder ?? null, "", csv ?? null, md ?? null);
		(modal as any).onOpen();
		expect(settingNamed(modal, "Source type").components[0].value).toBe(type);
		for (const name of TOGGLE_NAMES) expect(settingNamed(modal, name)).toBeUndefined();
	});

	it("API sources show both refresh toggles in edit mode, pre-filled from the saved source", () => {
		const modal = new ApiSourceModal(
			{} as any,
			{ url: "https://example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: true, refreshEveryMinutesEnabled: true, refreshEveryMinutes: 15 },
			[],
			vi.fn()
		);
		(modal as any).onOpen();
		expect(settingNamed(modal, "Refresh when Atlas view loads").components[0].value).toBe(true);
		expect(settingNamed(modal, "Refresh every").components[0].value).toBe(true);
		expect(settingNamed(modal, "Refresh every").components[1].value).toBe("15");
	});

	it("API save still writes its refresh settings (F1: API sources are unchanged)", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal(
			{} as any,
			{ url: "https://example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: true },
			[],
			onSave
		);
		(modal as any).onOpen();
		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0].source).toEqual(expect.objectContaining({ refreshOnViewLoad: true, refreshEveryMinutesEnabled: false }));
	});

	it("Folder canSave needs only a path and ignores refresh state", () => {
		const modal = openWithType("folder");
		expect((modal as any).canSave()).toBe(false);
		settingNamed(modal, "Folder").components[0].type("Projects");
		expect((modal as any).canSave()).toBe(true);
		(modal as any).refreshEveryMinutesEnabled = true;
		(modal as any).refreshEveryMinutesRaw = "";
		expect((modal as any).canSave()).toBe(true);
	});

	it("Markdown-table canSave ignores refresh state, and its save writes no removed refresh fields", () => {
		const onSave = vi.fn();
		const modal = openWithType("markdown-table", onSave);
		(modal as any).mdTablePath = "notes/table.md";
		(modal as any).mdTables = [{ headers: ["id", "name"], rows: [{ id: "1", name: "One" }], skippedCount: 0 }];
		(modal as any).mdTableIndex = 0;
		(modal as any).mapping = { idField: "id", labelField: "name" };
		(modal as any).refreshEveryMinutesEnabled = true;
		(modal as any).refreshEveryMinutesRaw = "";
		(modal as any).render();

		expect((modal as any).canSave()).toBe(true);
		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = JSON.stringify(onSave.mock.calls[0][0]);
		expect(saved).toContain("notes/table.md");
		expect(saved).not.toMatch(/refreshEveryMinutes|refreshOnViewLoad/);
	});

	it("Folder save writes no removed refresh fields", () => {
		const onSave = vi.fn();
		const modal = openWithType("folder", onSave);
		settingNamed(modal, "Folder").components[0].type("Projects/Active");
		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(onSave.mock.calls[0][0])).not.toMatch(/refreshEveryMinutes|refreshOnViewLoad/);
	});
});
