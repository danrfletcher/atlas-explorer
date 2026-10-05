import { App, ButtonComponent, Modal, Notice, Platform, Setting, TFile, TFolder, TextComponent, setTooltip } from "obsidian";
import { collectFrontmatterKeys, filterYamlKeySuggestions } from "./yaml-key-suggest";
import { sanitizeFolderFilters } from "./views";
import { canSaveApiSource, findArrayFields, isMapError, isValidExtraFieldName, mapResponseRows, sampleFieldsForArrayField } from "./api-mapping";
import { generateJsFromMapping, runJsMapping, validateJsSource } from "./api-js-mapping";
import { httpGetJson } from "./api-http";
import { obsidianRequestImpl } from "./api-request-obsidian";
import { MIN_REFRESH_MINUTES, validateRefreshMinutes } from "./api-refresh-timer";
import { resolveArgv, validateCommand } from "./command-argv";
import { ConfirmModal } from "./modals";
import { resolveOutsidePath } from "./folder-source-outside";
import { parseCsv } from "./csv-parsing";
import { detectMarkdownTables, needsTableIndexPrompt, MarkdownTable } from "./markdown-table-mapping";
import { ApiClickAction, ApiFieldMapping, ApiHeader, ApiSourceConfig, CsvSourceConfig, DataSourceType, FolderSourceConfig, MarkdownTableSourceConfig } from "./types";

/** PR-1.F1 (G2): one YAML rule as the modal edits it. The key and value stay raw until Save. */
interface YamlRuleDraft {
	key: string;
	value: string;
}

/** PR-4 (G1): now a real discriminated union — a Folder result carries its own `FolderSourceConfig`
 * and no headers (it has none), instead of widening the "api" shape to cover both. PR-5: also
 * carries `outsidePath` — the modal's own device-local field, which (like headers) has no home in
 * `FolderSourceConfig` itself since it must never reach synced `data.json`. PR-7: a CSV result
 * carries its own `CsvSourceConfig`, no headers and no `outsidePath` either (a CSV source is always
 * vault-relative, G18). PR-8: a Markdown Table result carries its own `MarkdownTableSourceConfig`,
 * same no-headers/no-outsidePath shape as CSV. */
export type ApiSourceModalResult =
	| { type: "api"; source: ApiSourceConfig; headers: ApiHeader[] }
	| { type: "folder"; source: FolderSourceConfig; outsidePath: string }
	| { type: "csv"; source: CsvSourceConfig }
	| { type: "markdown-table"; source: MarkdownTableSourceConfig };

const SOURCE_TYPE_OPTIONS: { value: DataSourceType; label: string }[] = [
	{ value: "api", label: "API" },
	{ value: "folder", label: "Folder" },
	{ value: "markdown-table", label: "Markdown table" },
	{ value: "csv", label: "CSV" },
];

const MAPPING_TARGETS: { key: "idField" | "labelField" | "secondaryField"; label: string; required: boolean }[] = [
	{ key: "idField", label: "ID (required)", required: true },
	{ key: "labelField", label: "Label (required)", required: true },
	{ key: "secondaryField", label: "Secondary (optional)", required: false },
];

/**
 * G1/PR-3/PR-5: "Data source…" modal on a Folder. URL + device-local headers + GET-only fetch, a sample
 * fetch that lists the response's fields as draggable chips (G2), drop targets (id/label
 * required, secondary optional, plus extra named fields), Merge/Append/Overwrite fill modes, Overwrite's two guards (G6b, greyed
 * out and their values retained unless Overwrite is selected), two independent refresh toggles
 * (G5a "when Atlas view loads", G5b "every X minutes"), and the optional click action (G9b).
 */
export class ApiSourceModal extends Modal {
	/** PR-3 (G1): null only for a brand-new, never-saved source — editing an existing (necessarily
	 * "api", today) source pre-selects "api" immediately in the constructor, never null. */
	private selectedType: DataSourceType | null;
	private url: string;
	private headers: ApiHeader[];
	private mode: "append" | "merge" | "overwrite";
	private refreshOnViewLoad: boolean;
	/** G6b(i)/(ii): retained regardless of `mode` — only Overwrite's UI exposes them for editing, but
	 * switching away and back must not lose whatever was set. */
	private keepOnEmpty: boolean;
	private confirmBeforeDelete: boolean;
	/** G5b: off by default, no fixed value — the raw text field's own value, validated on every change
	 * rather than coerced, so a mid-edit invalid value doesn't silently become someone else's number. */
	private refreshEveryMinutesEnabled: boolean;
	private refreshEveryMinutesRaw: string;
	private mapping: ApiFieldMapping;
	private extraFields: { name: string; field: string }[] = [];
	private action: ApiClickAction;
	private command: string;
	private sampleFields: string[] = [];
	private arrayFieldCandidates: string[] = [];
	private lastResponse: unknown = null;
	/** T1: must be the `ButtonComponent` itself, not just its `buttonEl` — Obsidian's click handler
	 * gates on the component's own internal `disabled` field, not the DOM element's `disabled`
	 * attribute, so re-syncing only the latter (as this used to) left the button unclickable forever
	 * after any full `render()` recreated it in a disabled state. */
	private saveButton: ButtonComponent | null = null;
	/** PR-4/G3: "drag" (default) behaves exactly as PR-2/PR-3; "js" replaces the mapping step with
	 * `jsSource`. `mapping` itself is never cleared on drag→js — only a confirmed js→drag switch
	 * clears `jsSource` (see the mode dropdown's `onChange`), so toggling modes never loses either
	 * side's state until the user actually confirms discarding it. */
	private mappingMode: "drag" | "js";
	private jsSource: string;
	/** Test button output (row/skip/truncate summary or the mapping error) — mode-aware, never saves
	 * or touches the cache. Persists across re-renders until the next Test run, a mode switch, or a
	 * fresh Fetch sample. */
	private testResult: string | null = null;
	private testResultEl: HTMLElement | null = null;
	/** PR-4: Folder source's own fields — "inside" only is functional this PR (G1/E7); "outside" renders
	 * a deferred-to-PR-5 stub instead of a real config section. */
	private folderLocation: "inside" | "outside";
	private folderPath: string;
	/** PR-5 (G6): the Outside-Vault raw filesystem path field's own value — kept separate from
	 * `folderPath` (Inside-Vault only) so switching `folderLocation` can clear exactly one without
	 * ever mixing a vault-relative and an absolute path together. */
	private outsidePath: string;
	private showFiles: boolean;
	private showFolders: boolean;
	/** R1 fix: refs the user has removed from this source's managed set, carried through unedited —
	 * saving after only changing a toggle or path must not forget them and let reconcile resurrect
	 * rows the user deliberately removed. */
	private removedRefs: string[] | undefined;
	/** PR-1.F1 (G2): the File filters section's YAML rules, edited in place. Kept in memory while the
	 * section is hidden (Show files off, or an Outside-vault source) so toggling it back restores them.
	 * Only Save reads them, through the S1 sanitizer, so an empty-key rule is dropped there. */
	private yamlRules: YamlRuleDraft[];
	/** PR-1.F1 (G1): the vault's frontmatter keys, read once per modal open for the key suggester. */
	private yamlKeyCache: string[] | null = null;
	/** PR-7 (G18): CSV's own vault-relative file path — CSV otherwise reuses the API mapping/fill-mode/
	 * guard/refresh fields verbatim below, since only one type is ever selected at a time. */
	private csvPath: string;
	/** PR-8 (G18/G20): Markdown Table's own vault-relative `.md` file path and selected table index —
	 * otherwise reuses the API mapping/fill-mode/guard/refresh fields verbatim, same as CSV above.
	 * `mdTableIndex` is `null` whenever the file has more than one table and the user hasn't explicitly
	 * chosen one yet (R1: never auto-pick table 1 when there's a genuine choice) — `0` both when there's
	 * no choice to make (zero or one table) and when loading a previously-saved config's stored index. */
	private mdTablePath: string;
	private mdTableIndex: number | null;
	/** PR-8 (G20): the tables detected by the last "Load sample" — cached so the index-picker dropdown
	 * can switch between tables (re-deriving `sampleFields` for the newly chosen one) without needing
	 * to re-read the file from disk on every selection change. */
	private mdTables: MarkdownTable[] = [];

	constructor(
		app: App,
		initial: ApiSourceConfig | null,
		initialHeaders: ApiHeader[],
		private onSave: (result: ApiSourceModalResult) => void,
		initialFolderSource: FolderSourceConfig | null = null,
		initialOutsidePath: string = "",
		initialCsvSource: CsvSourceConfig | null = null,
		initialMarkdownTableSource: MarkdownTableSourceConfig | null = null
	) {
		super(app);
		this.selectedType = initial
			? "api"
			: initialFolderSource
				? "folder"
				: initialCsvSource
					? "csv"
					: initialMarkdownTableSource
						? "markdown-table"
						: null;
		this.resetApiFieldsToBlank();
		this.resetFolderFieldsToBlank();
		this.resetCsvFieldsToBlank();
		this.resetMarkdownTableFieldsToBlank();
		this.headers = initialHeaders.map((h) => ({ ...h }));
		if (initial) {
			this.url = initial.url ?? "";
			this.mode = initial.mode ?? "merge";
			this.refreshOnViewLoad = initial.refreshOnViewLoad ?? false;
			this.keepOnEmpty = initial.keepOnEmpty ?? true;
			this.confirmBeforeDelete = initial.confirmBeforeDelete ?? true;
			this.refreshEveryMinutesEnabled = initial.refreshEveryMinutesEnabled ?? false;
			this.refreshEveryMinutesRaw = initial.refreshEveryMinutes !== undefined ? String(initial.refreshEveryMinutes) : "";
			this.mapping = initial.mapping ? { ...initial.mapping } : this.mapping;
			this.mappingMode = initial.mappingMode === "js" ? "js" : "drag";
			this.jsSource = initial.jsSource ?? "";
			this.action = initial.action ?? initial.clickAction ?? "open-attachment";
			this.command = initial.command ?? "";
			const rawExtras = initial.mapping?.extraFields;
			if (rawExtras && typeof rawExtras === "object") {
				this.extraFields = Object.entries(rawExtras).map(([name, field]) => ({ name, field }));
			}
		}
		if (initialFolderSource) {
			this.folderLocation = initialFolderSource.location;
			this.folderPath = initialFolderSource.path ?? "";
			this.outsidePath = initialFolderSource.location === "outside" ? initialOutsidePath : "";
			this.showFiles = initialFolderSource.showFiles ?? true;
			this.showFolders = initialFolderSource.showFolders ?? true;
			this.refreshOnViewLoad = initialFolderSource.refreshOnViewLoad ?? false;
			this.refreshEveryMinutesEnabled = initialFolderSource.refreshEveryMinutesEnabled ?? false;
			this.refreshEveryMinutesRaw =
				initialFolderSource.refreshEveryMinutes !== undefined ? String(initialFolderSource.refreshEveryMinutes) : "";
			this.removedRefs = initialFolderSource.removedRefs;
			this.yamlRules = (initialFolderSource.filters?.files?.yaml?.rules ?? []).map((rule) => ({ key: rule.key, value: rule.value }));
			this.mode = initialFolderSource.mode ?? "merge";
		}
		if (initialCsvSource) {
			this.csvPath = initialCsvSource.path ?? "";
			this.mapping = initialCsvSource.mapping ? { ...initialCsvSource.mapping } : this.mapping;
			this.mode = initialCsvSource.mode ?? "merge";
			this.refreshOnViewLoad = initialCsvSource.refreshOnViewLoad ?? false;
			this.keepOnEmpty = initialCsvSource.keepOnEmpty ?? true;
			this.confirmBeforeDelete = initialCsvSource.confirmBeforeDelete ?? true;
			this.refreshEveryMinutesEnabled = initialCsvSource.refreshEveryMinutesEnabled ?? false;
			this.refreshEveryMinutesRaw =
				initialCsvSource.refreshEveryMinutes !== undefined ? String(initialCsvSource.refreshEveryMinutes) : "";
			this.mappingMode = initialCsvSource.mappingMode === "js" ? "js" : "drag";
			this.jsSource = initialCsvSource.jsSource ?? "";
			const rawExtras = initialCsvSource.mapping?.extraFields;
			if (rawExtras && typeof rawExtras === "object") {
				this.extraFields = Object.entries(rawExtras).map(([name, field]) => ({ name, field }));
			}
		}
		if (initialMarkdownTableSource) {
			this.mdTablePath = initialMarkdownTableSource.path ?? "";
			this.mdTableIndex = initialMarkdownTableSource.tableIndex ?? 0;
			this.mapping = initialMarkdownTableSource.mapping ? { ...initialMarkdownTableSource.mapping } : this.mapping;
			this.mode = initialMarkdownTableSource.mode ?? "merge";
			this.refreshOnViewLoad = initialMarkdownTableSource.refreshOnViewLoad ?? false;
			this.keepOnEmpty = initialMarkdownTableSource.keepOnEmpty ?? true;
			this.confirmBeforeDelete = initialMarkdownTableSource.confirmBeforeDelete ?? true;
			this.refreshEveryMinutesEnabled = initialMarkdownTableSource.refreshEveryMinutesEnabled ?? false;
			this.refreshEveryMinutesRaw =
				initialMarkdownTableSource.refreshEveryMinutes !== undefined ? String(initialMarkdownTableSource.refreshEveryMinutes) : "";
			this.mappingMode = initialMarkdownTableSource.mappingMode === "js" ? "js" : "drag";
			this.jsSource = initialMarkdownTableSource.jsSource ?? "";
			const rawExtras = initialMarkdownTableSource.mapping?.extraFields;
			if (rawExtras && typeof rawExtras === "object") {
				this.extraFields = Object.entries(rawExtras).map(([name, field]) => ({ name, field }));
			}
		}
	}

	/** PR-3 (G2): the "api" config's blank starting state — shared by the constructor (brand-new
	 * source) and by the type dropdown's `onChange` (switching into "api" from anything else, or from
	 * "api" back to "api" after a discard, must never carry over a previous selection's field values). */
	private resetApiFieldsToBlank(): void {
		this.url = "";
		this.headers = [];
		this.mode = "merge";
		this.keepOnEmpty = true;
		this.confirmBeforeDelete = true;
		this.mapping = { idField: "", labelField: "", secondaryField: undefined };
		this.extraFields = [];
		this.mappingMode = "drag";
		this.jsSource = "";
		this.action = "open-attachment";
		this.command = "";
		this.sampleFields = [];
		this.arrayFieldCandidates = [];
		this.lastResponse = null;
		this.testResult = null;
		this.resetSharedRefreshFields();
	}

	/** G5a/G5b/G10: the two refresh toggles are shared, field-for-field, between "api" and "folder" —
	 * factored out so both `resetApiFieldsToBlank`/`resetFolderFieldsToBlank` reset them identically. */
	private resetSharedRefreshFields(): void {
		this.refreshOnViewLoad = false;
		this.refreshEveryMinutesEnabled = false;
		this.refreshEveryMinutesRaw = "";
	}

	/** PR-4 (G2/GP1): the Folder config's blank starting state, mirroring `resetApiFieldsToBlank` —
	 * "Inside Vault" and both Show-toggles default on, the path selector starts empty. */
	private resetFolderFieldsToBlank(): void {
		this.folderLocation = "inside";
		this.folderPath = "";
		this.outsidePath = "";
		this.showFiles = true;
		this.showFolders = true;
		this.removedRefs = undefined;
		this.yamlRules = [];
		this.mode = "merge";
		this.resetSharedRefreshFields();
	}

	/** PR-7 (G18): CSV's blank starting state, mirroring `resetFolderFieldsToBlank` — CSV reuses the
	 * API mapping/fill-mode/guard fields verbatim (only one type is ever selected at a time), so only
	 * the file path and the mapping-related fields need resetting here. */
	private resetCsvFieldsToBlank(): void {
		this.csvPath = "";
		this.mapping = { idField: "", labelField: "", secondaryField: undefined };
		this.extraFields = [];
		this.mappingMode = "drag";
		this.jsSource = "";
		this.sampleFields = [];
		this.arrayFieldCandidates = [];
		this.lastResponse = null;
		this.testResult = null;
		this.mode = "merge";
		this.keepOnEmpty = true;
		this.confirmBeforeDelete = true;
		this.resetSharedRefreshFields();
	}

	/** PR-8 (G18/G20): Markdown Table's blank starting state, mirroring `resetCsvFieldsToBlank` — same
	 * reused mapping/fill-mode/guard fields, plus its own path and table-index/cached-tables fields. */
	private resetMarkdownTableFieldsToBlank(): void {
		this.mdTablePath = "";
		this.mdTableIndex = 0;
		this.mdTables = [];
		this.mapping = { idField: "", labelField: "", secondaryField: undefined };
		this.extraFields = [];
		this.mappingMode = "drag";
		this.jsSource = "";
		this.sampleFields = [];
		this.arrayFieldCandidates = [];
		this.lastResponse = null;
		this.testResult = null;
		this.mode = "merge";
		this.keepOnEmpty = true;
		this.confirmBeforeDelete = true;
		this.resetSharedRefreshFields();
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Fix 2 (Round 1 human testing), corrected in Round 2 (T1-T5), made unconditional after Round 3
	 * (PR-6.C — the same jump kept recurring on every toggle/dropdown one at a time, because only the
	 * handful of call sites someone remembered to wrap were protected): `render()` fully rebuilds
	 * `contentEl`, and clearing/regrowing its content inside the modal disturbs scroll position — but
	 * `contentEl` (Obsidian's `.modal-content`) never itself scrolls in this modal's layout
	 * (scrollHeight === clientHeight always, scrollTop permanently 0). The actual scrolling element the
	 * user sees is `modalEl` (the ancestor `.modal`), which a bare rebuild doesn't reset but whose
	 * position drifts anyway (e.g. via the browser's scroll anchoring) once the content changes size.
	 * `render()` itself now always captures and restores `modalEl.scrollTop` around the rebuild, so
	 * every call site — present and future — is covered with no separate "preserving" variant to
	 * remember to call. */
	private render(): void {
		const scrollTop = this.modalEl.scrollTop;
		this.renderBody();
		this.modalEl.scrollTop = scrollTop;
	}

	private renderBody(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Data source" });

		new Setting(contentEl)
			.setName("Source type")
			.addDropdown((dropdown) => {
				for (const option of SOURCE_TYPE_OPTIONS) dropdown.addOption(option.value, option.label);
				// G1: a brand-new source opens with none pre-selected — `setValue("")` matches no option
				// (there's deliberately no blank 5th option), which is how a plain <select> renders with
				// nothing shown as selected rather than defaulting to the first option in the list.
				dropdown.setValue(this.selectedType ?? "");
				dropdown.onChange((value) => {
					const next = (value || null) as DataSourceType | null;
					if (next === this.selectedType) return;
					this.selectedType = next;
					// G2: switching the type — into "api", "folder", "csv", or "markdown-table" — always
					// discards whatever config existed for the type being left; each type has its own
					// config to reset.
					if (next === "api") this.resetApiFieldsToBlank();
					else if (next === "folder") this.resetFolderFieldsToBlank();
					else if (next === "csv") this.resetCsvFieldsToBlank();
					else if (next === "markdown-table") this.resetMarkdownTableFieldsToBlank();
					this.render();
				});
			});

		if (this.selectedType === "api") {
			this.renderApiBody();
		} else if (this.selectedType === "folder") {
			this.renderFolderBody();
		} else if (this.selectedType === "csv") {
			this.renderCsvBody();
		} else if (this.selectedType === "markdown-table") {
			this.renderMarkdownTableBody();
		}

		const footer = new Setting(contentEl);
		footer.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
		footer.addButton((btn) => {
			this.saveButton = btn;
			btn
				.setCta()
				.setButtonText("Save")
				.setDisabled(!this.canSave())
				.onClick(() => this.save());
			return btn;
		});
	}

	/** PR-3 (G1): the modal body for the "api" source type — unchanged from before this PR beyond
	 * being behind the type dropdown instead of always rendering. */
	private renderApiBody(): void {
		const { contentEl } = this;

		new Setting(contentEl)
			.setName("URL")
			.addText((text) =>
				text
					.setPlaceholder("https://api.example.com/items")
					.setValue(this.url)
					.onChange((value) => (this.url = value))
			);

		new Setting(contentEl).setName("Method").addText((text) => text.setValue("GET").setDisabled(true));

		new Setting(contentEl)
			.setName("Headers")
			.setDesc("Stored on this device only — never synced, and kept as plain text, unencrypted.")
			.setHeading();
		for (let i = 0; i < this.headers.length; i++) {
			const header = this.headers[i];
			const row = new Setting(contentEl);
			row.addText((text) => text.setPlaceholder("Header name").setValue(header.key).onChange((value) => (header.key = value)));
			row.addText((text) => text.setPlaceholder("Value").setValue(header.value).onChange((value) => (header.value = value)));
			row.addExtraButton((btn) =>
				btn.setIcon("x").setTooltip("Remove header").onClick(() => {
					this.headers.splice(i, 1);
					this.render();
				})
			);
		}
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Add header").onClick(() => {
				this.headers.push({ key: "", value: "" });
				this.render();
			})
		);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Fetch sample").onClick(() => void this.fetchSample())
		);

		this.renderMappingFieldsUI(contentEl);
		this.renderFillModeAndGuardsUI(contentEl);
		this.renderRefreshToggles(contentEl);

		new Setting(contentEl).setName("Click action").setHeading();
		new Setting(contentEl)
			.setName("Action on click")
			.setDesc("What happens when an API row is clicked.")
			.addDropdown((dropdown) => {
				dropdown.addOption("open-attachment", "Open attachment (default)");
				dropdown.addOption("none", "None");
				if (Platform.isMobile) {
					// G13: Click-action commands are not available on mobile
				} else {
					dropdown.addOption("run-command", "Run terminal command in background");
				}
				dropdown.setValue(this.action);
				dropdown.onChange((value) => {
					this.action = value as ApiClickAction;
					this.render();
				});
			});

		if (this.action === "run-command" && !Platform.isMobile) {
			contentEl.createEl("p", {
				cls: "atlas-api-command-warning",
				text: "Commands run with the user's trust. Shell features (pipes, redirects, &&, globbing, ~, env vars) are unsupported in v1.",
			});

			let commandErrorEl: HTMLElement | null = null;
			const updateCommandValidity = () => {
				const availableExtras = this.extraFields.map((e) => e.name);
				const validation = validateCommand(this.command, availableExtras);
				commandErrorEl?.setText(validation.ok ? "" : validation.error);
				this.updateSaveButton();
			};

			new Setting(contentEl)
				.setName("Command")
				.setDesc("Command to execute in the background. Use {field} for extra mapped field values.")
				.addText((text) =>
					text
						.setPlaceholder("open -a Docker")
						.setValue(this.command)
						.onChange((value) => {
							this.command = value;
							updateCommandValidity();
						})
				);
			commandErrorEl = contentEl.createEl("p", { cls: "atlas-api-field-error" });
			updateCommandValidity();
		}
	}

	/** PR-3/PR-7: the mapping-mode dropdown, JS textarea, Test button, array-field dropdown, and
	 * drag-chip/extra-field UI — shared verbatim between "api" and "csv" (PR-7), since both feed the
	 * same `ApiFieldMapping` through the same mapping pipeline and differ only in how `lastResponse`
	 * gets populated (`fetchSample` vs. `loadCsvSample`). Factored out of `renderApiBody` so CSV
	 * reuses the exact existing mapping UI rather than a copy. */
	private renderMappingFieldsUI(contentEl: HTMLElement): void {
		new Setting(contentEl)
			.setName("Mapping mode")
			.addDropdown((dropdown) => {
				dropdown.addOption("drag", "Drag fields");
				dropdown.addOption("js", "JavaScript");
				dropdown.setValue(this.mappingMode);
				dropdown.onChange((value) => {
					const next = value as "drag" | "js";
					if (next === this.mappingMode) return;
					if (this.mappingMode === "js" && next === "drag") {
						// G3: re-render first so the dropdown's own displayed value snaps back to "js"
						// until the user actually confirms — Cancel (no callback at all, see
						// `ConfirmModal`) must leave the mode and the code untouched.
						this.render();
						new ConfirmModal(
							this.app,
							"Switching to drag-field mapping discards the JavaScript code — this can't be undone.",
							"Discard code",
							() => {
								this.mappingMode = "drag";
								this.jsSource = "";
								this.testResult = null;
								this.render();
							}
						).open();
						return;
					}
					this.mappingMode = next;
					this.testResult = null;
					if (next === "js") this.jsSource = generateJsFromMapping({ ...this.mapping, extraFields: this.buildExtraFieldsRecord() });
					this.render();
				});
			});

		if (this.mappingMode === "js") {
			contentEl.createEl("p", {
				cls: "atlas-api-js-warning",
				text: "JavaScript runs with Atlas's full trust — there is no sandbox. An infinite loop or a function that never resolves has no separate timeout of its own; only the request itself is capped.",
			});

			let jsErrorEl: HTMLElement | null = null;
			const updateJsValidity = () => {
				const validation = validateJsSource(this.jsSource);
				jsErrorEl?.setText(validation.ok ? "" : validation.error);
				this.updateSaveButton();
			};
			new Setting(contentEl)
				.setName("Mapping function")
				.setDesc("(response) => [{ id, label, secondary, extra }] — secondary and extra are optional.")
				.addTextArea((text) =>
					text.setValue(this.jsSource).onChange((value) => {
						this.jsSource = value;
						updateJsValidity();
					})
				);
			jsErrorEl = contentEl.createEl("p", { cls: "atlas-api-field-error" });
			updateJsValidity();
		}

		new Setting(contentEl).addButton((btn) => btn.setButtonText("Test").onClick(() => void this.runTest()));
		this.testResultEl = contentEl.createEl("p", { cls: "atlas-api-test-result" });
		this.testResultEl.setText(this.testResult ?? "");

		if (this.mappingMode === "drag" && this.arrayFieldCandidates.length > 0) {
			new Setting(contentEl)
				.setName("Array field")
				.setDesc("The response is an object — pick which field holds the list of rows.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Choose…");
					for (const field of this.arrayFieldCandidates) dropdown.addOption(field, field);
					dropdown.setValue(this.mapping.arrayField ?? "");
					dropdown.onChange((value) => {
						this.mapping.arrayField = value || undefined;
						this.applyMapping();
						this.render();
					});
				});
		}

		if (this.mappingMode === "drag" && this.sampleFields.length > 0) {
			new Setting(contentEl).setName("Map fields").setDesc("Drag a field onto a target below.").setHeading();
			const chipsEl = contentEl.createDiv({ cls: "atlas-api-field-chips" });
			for (const field of this.sampleFields) {
				const chip = chipsEl.createSpan({ cls: "atlas-api-field-chip", text: field });
				chip.setAttr("draggable", "true");
				chip.addEventListener("dragstart", (evt) => evt.dataTransfer?.setData("text/plain", field));
			}

			for (const target of MAPPING_TARGETS) {
				const targetRow = new Setting(contentEl).setName(target.label);
				const dropZone = targetRow.controlEl.createDiv({ cls: "atlas-api-drop-zone", text: this.mapping[target.key] || "Drop field here" });
				dropZone.addEventListener("dragover", (evt) => evt.preventDefault());
				dropZone.addEventListener("drop", (evt) => {
					evt.preventDefault();
					const field = evt.dataTransfer?.getData("text/plain");
					if (!field) return;
					this.mapping[target.key] = field;
					this.render();
				});
				if (this.mapping[target.key] && !target.required) {
					targetRow.addExtraButton((btn) =>
						btn.setIcon("x").setTooltip("Clear").onClick(() => {
							(this.mapping as unknown as Record<string, string | undefined>)[target.key] = undefined;
							this.render();
						})
					);
				}
			}

			for (let i = 0; i < this.extraFields.length; i++) {
				const extra = this.extraFields[i];
				const targetRow = new Setting(contentEl);
				targetRow.addText((text) =>
					text
						.setPlaceholder("field_name")
						.setValue(extra.name)
						.onChange((value) => {
							extra.name = value.trim();
							this.updateSaveButton();
						})
				);
				const dropZone = targetRow.controlEl.createDiv({ cls: "atlas-api-drop-zone", text: extra.field || "Drop field here" });
				dropZone.addEventListener("dragover", (evt) => evt.preventDefault());
				dropZone.addEventListener("drop", (evt) => {
					evt.preventDefault();
					const field = evt.dataTransfer?.getData("text/plain");
					if (!field) return;
					extra.field = field;
					this.render();
				});
				targetRow.addExtraButton((btn) =>
					btn
						.setIcon("x")
						.setTooltip("Remove extra field")
						.onClick(() => {
							this.extraFields.splice(i, 1);
							this.render();
						})
				);
			}

			const addExtraRow = new Setting(contentEl).setName("Extra field");
			const addDropZone = addExtraRow.controlEl.createDiv({
				cls: "atlas-api-drop-zone atlas-api-add-drop-zone",
				text: "Drop field here to add extra field",
			});
			addDropZone.addEventListener("dragover", (evt) => evt.preventDefault());
			addDropZone.addEventListener("drop", (evt) => {
				evt.preventDefault();
				const field = evt.dataTransfer?.getData("text/plain");
				if (!field) return;
				let name = field.replace(/[^a-zA-Z0-9_]/g, "_") || "extra";
				if (this.extraFields.some((e) => e.name === name)) {
					let n = 1;
					while (this.extraFields.some((e) => e.name === `${name}_${n}`)) n++;
					name = `${name}_${n}`;
				}
				this.extraFields.push({ name, field });
				this.render();
			});
			addExtraRow.addButton((btn) =>
				btn.setButtonText("Add extra field").onClick(() => {
					let name = "extra";
					let n = 1;
					while (this.extraFields.some((e) => e.name === `${name}_${n}`)) n++;
					this.extraFields.push({ name: `${name}_${n}`, field: "" });
					this.render();
				})
			);
		}
	}

	/** PR-3/PR-7: Fill mode + its two Overwrite-only guards — shared verbatim between "api" and "csv"
	 * (PR-7). Factored out of `renderApiBody` for the same reason as `renderMappingFieldsUI` above. */
	private renderFillModeAndGuardsUI(contentEl: HTMLElement): void {
		new Setting(contentEl)
			.setName("Fill mode")
			.setDesc("Merge keeps items by id across refreshes; Append only ever adds new ones; Overwrite replaces every row each refresh.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("merge", "Merge")
					.addOption("append", "Append")
					.addOption("overwrite", "Overwrite")
					.setValue(this.mode)
					.onChange((value) => {
						this.mode = value as "append" | "merge" | "overwrite";
						// Guard toggles' disabled state depends on `mode` — re-render so it updates live.
						this.render();
					})
			);

		const overwriteGuardsDisabled = this.mode !== "overwrite";
		new Setting(contentEl)
			.setName("Keep current rows if the response is empty")
			.setDesc("Overwrite only. On: an empty response leaves every row untouched. Off: an empty response deletes all rows (subject to the confirm guard below).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.keepOnEmpty)
					.setDisabled(overwriteGuardsDisabled)
					.onChange((value) => (this.keepOnEmpty = value))
			);
		new Setting(contentEl)
			.setName("Confirm before deleting rows")
			.setDesc("Overwrite only. Asks for confirmation whenever a refresh would delete one or more rows.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.confirmBeforeDelete)
					.setDisabled(overwriteGuardsDisabled)
					.onChange((value) => (this.confirmBeforeDelete = value))
			);
	}

	/** PR-7 (G17-G19): the CSV source's modal body — a vault-file picker in place of the API's URL
	 * field, a "Load sample" button in place of "Fetch sample" (reads+parses the file instead of
	 * making a request), then the exact same mapping/fill-mode/guard/refresh UI an API source uses.
	 * No headers, no click-action section — CSV has neither (see `CsvSourceConfig`'s own doc comment). */
	private renderCsvBody(): void {
		const { contentEl } = this;

		this.renderCsvPathSuggester(contentEl);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Load sample").onClick(() => void this.loadCsvSample())
		);

		this.renderMappingFieldsUI(contentEl);
		this.renderFillModeAndGuardsUI(contentEl);
		this.renderRefreshToggles(contentEl);
	}

	/** G18: a filterable list of every `.csv` file in the vault, vault-relative paths only — mirrors
	 * `renderFolderPathSuggester` but lists files rather than folders, filtered to the `.csv`
	 * extension. */
	private renderCsvPathSuggester(contentEl: HTMLElement): void {
		const allPaths = this.listVaultCsvFiles();
		let listEl: HTMLElement | null = null;
		const renderList = (filter: string) => {
			if (!listEl) return;
			listEl.empty();
			const normalized = filter.trim().toLowerCase();
			const matches = normalized ? allPaths.filter((p) => p.toLowerCase().includes(normalized)) : allPaths;
			for (const path of matches.slice(0, 50)) {
				const item = listEl.createEl("div", { cls: "atlas-folder-suggest-item", text: path });
				item.onclick = () => {
					this.csvPath = path;
					this.render();
				};
			}
		};

		new Setting(contentEl)
			.setName("CSV file")
			.setDesc("Vault-relative path to the .csv file. The first row is always treated as column headers.")
			.addText((text) =>
				text
					.setPlaceholder("Search vault .csv files…")
					.setValue(this.csvPath)
					.onChange((value) => {
						this.csvPath = value;
						this.updateSaveButton();
						renderList(value);
					})
			);
		listEl = contentEl.createEl("div", { cls: "atlas-folder-suggest-list" });
		renderList(this.csvPath);
	}

	/** Recursively walks the vault root, mirroring `listVaultFolders`, but collects `.csv` files
	 * instead of folders. */
	private listVaultCsvFiles(): string[] {
		const root = this.app.vault?.getRoot();
		if (!root) return [];
		const paths: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
				else if (child.path.toLowerCase().endsWith(".csv")) paths.push(child.path);
			}
		};
		walk(root);
		return paths;
	}

	/** PR-7: mirrors `fetchSample`'s role for CSV — reads+parses the selected file (G19) and derives
	 * `sampleFields` from the parsed rows' own keys via the existing `sampleFieldsForArrayField`
	 * helper, exactly as a plain-array API response would (CSV rows are already flat, so there's never
	 * an array field to pick). Never touches `apiCache` — same contract `fetchSample`/`runTest` have. */
	private async loadCsvSample(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.csvPath.trim());
		if (!(file instanceof TFile)) {
			new Notice("Atlas: file not found.");
			return;
		}
		const text = await this.app.vault.cachedRead(file);
		const parsed = parseCsv(text);
		if (!parsed.ok) {
			new Notice(`Atlas: ${parsed.error}`);
			return;
		}
		this.lastResponse = parsed.rows;
		this.arrayFieldCandidates = [];
		this.sampleFields = sampleFieldsForArrayField(parsed.rows, undefined);
		this.testResult = null;
		if (this.sampleFields.length === 0) {
			new Notice("Atlas: the CSV file has no data rows to map yet.");
		}
		this.render();
	}

	/** PR-8 (G17-G20): the Markdown Table source's modal body — a `.md`-filtered vault-file picker in
	 * place of CSV's `.csv` picker, a "Load sample" button that parses the file and (G20) shows an
	 * index-picker only when the file has more than one table, then the exact same mapping/fill-mode/
	 * guard/refresh UI an API/CSV source uses. No headers, no click-action section — same as CSV. */
	private renderMarkdownTableBody(): void {
		const { contentEl } = this;

		this.renderMarkdownTablePathSuggester(contentEl);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Load sample").onClick(() => void this.loadMarkdownTableSample())
		);

		// G20: the index-selection prompt — never shown when the file has zero or exactly one table,
		// since there's nothing to choose between.
		const needsPrompt = needsTableIndexPrompt(this.mdTables);
		if (needsPrompt) {
			new Setting(contentEl)
				.setName("Table")
				.setDesc(`This file has ${this.mdTables.length} tables — choose which one to use.`)
				.addDropdown((dropdown) => {
					// R1: no option is auto-selected — the placeholder is the only match until the user
					// picks a real table, so mapping below stays hidden and Save stays blocked until then.
					dropdown.addOption("", "Choose a table…");
					for (let i = 0; i < this.mdTables.length; i++) {
						dropdown.addOption(String(i), `Table ${i + 1} (${this.mdTables[i].headers.join(", ")})`);
					}
					dropdown.setValue(this.mdTableIndex === null ? "" : String(this.mdTableIndex));
					dropdown.onChange((value) => {
						this.mdTableIndex = value === "" ? null : Number(value);
						this.applyMarkdownTableSelection();
						this.render();
					});
				});
		}

		// R1: mapping only ever renders once there's no real choice to make (0/1 tables) or the user has
		// explicitly chosen one — never pre-filled from an auto-picked table.
		if (!needsPrompt || this.mdTableIndex !== null) {
			this.renderMappingFieldsUI(contentEl);
			this.renderFillModeAndGuardsUI(contentEl);
			this.renderRefreshToggles(contentEl);
		}
	}

	/** G18: a filterable list of every `.md` file in the vault, vault-relative paths only — mirrors
	 * `renderCsvPathSuggester` but filtered to the `.md` extension. */
	private renderMarkdownTablePathSuggester(contentEl: HTMLElement): void {
		const allPaths = this.listVaultMdFiles();
		let listEl: HTMLElement | null = null;
		const renderList = (filter: string) => {
			if (!listEl) return;
			listEl.empty();
			const normalized = filter.trim().toLowerCase();
			const matches = normalized ? allPaths.filter((p) => p.toLowerCase().includes(normalized)) : allPaths;
			for (const path of matches.slice(0, 50)) {
				const item = listEl.createEl("div", { cls: "atlas-folder-suggest-item", text: path });
				item.onclick = () => {
					this.mdTablePath = path;
					this.render();
				};
			}
		};

		new Setting(contentEl)
			.setName("Markdown file")
			.setDesc("Vault-relative path to the .md file containing the table.")
			.addText((text) =>
				text
					.setPlaceholder("Search vault .md files…")
					.setValue(this.mdTablePath)
					.onChange((value) => {
						this.mdTablePath = value;
						this.updateSaveButton();
						renderList(value);
					})
			);
		listEl = contentEl.createEl("div", { cls: "atlas-folder-suggest-list" });
		renderList(this.mdTablePath);
	}

	/** Recursively walks the vault root, mirroring `listVaultCsvFiles`, but collects `.md` files
	 * instead. */
	private listVaultMdFiles(): string[] {
		const root = this.app.vault?.getRoot();
		if (!root) return [];
		const paths: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
				else if (child.path.toLowerCase().endsWith(".md")) paths.push(child.path);
			}
		};
		walk(root);
		return paths;
	}

	/** PR-8 (G20): mirrors `loadCsvSample`'s role for Markdown Table — reads the selected file and
	 * detects every table in it (`detectMarkdownTables`). R1: when there's more than one table, the
	 * selected index starts at `null` (no auto-pick) — the index picker, rendered only when there's more
	 * than one, is how the user then actually chooses; with zero or one table there's no real choice, so
	 * it defaults to 0. Then derives `sampleFields` from whichever table (if any) is selected via
	 * `applyMarkdownTableSelection`. */
	private async loadMarkdownTableSample(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.mdTablePath.trim());
		if (!(file instanceof TFile)) {
			new Notice("Atlas: file not found.");
			return;
		}
		const text = await this.app.vault.cachedRead(file);
		this.mdTables = detectMarkdownTables(text);
		if (this.mdTables.length === 0) {
			new Notice("Atlas: no markdown table found in this file.");
		}
		this.mdTableIndex = needsTableIndexPrompt(this.mdTables) ? null : 0;
		this.applyMarkdownTableSelection();
		this.render();
	}

	/** PR-8: re-derives `sampleFields`/`lastResponse` from whichever table in `mdTables` is currently
	 * selected by `mdTableIndex` — called both after a fresh "Load sample" and after switching the
	 * index-picker dropdown, so the mapping UI below always reflects the currently-selected table's
	 * own rows/headers. R1: no table selected yet (`mdTableIndex === null`) means no rows/fields either. */
	private applyMarkdownTableSelection(): void {
		const table = this.mdTableIndex === null ? undefined : this.mdTables[this.mdTableIndex];
		this.lastResponse = table ? table.rows : [];
		this.arrayFieldCandidates = [];
		this.sampleFields = sampleFieldsForArrayField(this.lastResponse, undefined);
		this.testResult = null;
	}

	/** G5a/G5b/G10: shared verbatim between "api" and "folder" — same two toggles, same fields, same
	 * validation. Factored out so Folder reuses the exact existing refresh machinery rather than a copy. */
	private renderRefreshToggles(contentEl: HTMLElement): void {
		new Setting(contentEl)
			.setName("Refresh when Atlas view loads")
			.addToggle((toggle) => toggle.setValue(this.refreshOnViewLoad).onChange((value) => (this.refreshOnViewLoad = value)));

		let refreshErrorEl: HTMLElement | null = null;
		const updateRefreshMinutesValidity = () => {
			const validation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
			refreshErrorEl?.setText(validation && !validation.ok ? validation.error : "");
			this.updateSaveButton();
		};
		new Setting(contentEl)
			.setName("Refresh every")
			.setDesc("Minutes between automatic refreshes while this Atlas view is open. Minimum 5 — off by default.")
			.addToggle((toggle) =>
				toggle.setValue(this.refreshEveryMinutesEnabled).onChange((value) => {
					this.refreshEveryMinutesEnabled = value;
					// Turning it on with nothing typed yet pre-fills the floor rather than leaving the
					// field blank — a blank field on a freshly-enabled toggle isn't an invalid entry the
					// user made, so it shouldn't show the "minimum 5" error before they've touched it.
					if (value && !this.refreshEveryMinutesRaw.trim()) {
						this.refreshEveryMinutesRaw = String(MIN_REFRESH_MINUTES);
					}
					// Enabling/disabling the field's own editability — a discrete click, not a keystroke,
					// so a full re-render here doesn't cost focus the way it would mid-typing.
					this.render();
				})
			)
			.addText((text) =>
				text
					.setPlaceholder("minutes")
					.setValue(this.refreshEveryMinutesRaw)
					.setDisabled(!this.refreshEveryMinutesEnabled)
					.onChange((value) => {
						this.refreshEveryMinutesRaw = value;
						updateRefreshMinutesValidity();
					})
			);
		refreshErrorEl = contentEl.createEl("p", { cls: "atlas-api-field-error" });
		updateRefreshMinutesValidity();
	}

	/** PR-4/PR-5: the Folder source's modal body — Inside Vault keeps its vault-folder suggester (E7);
	 * Outside Vault (G6) now renders a real raw filesystem path field with its own live connection
	 * indicator instead of PR-4's deferred stub. */
	private renderFolderBody(): void {
		const { contentEl } = this;

		new Setting(contentEl)
			.setName("Location")
			.addDropdown((dropdown) => {
				dropdown.addOption("inside", "Inside vault");
				dropdown.addOption("outside", "Outside vault");
				dropdown.setValue(this.folderLocation);
				dropdown.onChange((value) => {
					const next = value === "outside" ? "outside" : "inside";
					if (next === this.folderLocation) return;
					// Acceptance: toggling Inside<->Outside clears the previously stored path (relative
					// or absolute) rather than attempting to convert it — never carry one over as the
					// other's starting value.
					this.folderLocation = next;
					this.folderPath = "";
					this.outsidePath = "";
					this.render();
				});
			});

		if (this.folderLocation === "outside") {
			this.renderOutsidePathField(contentEl);
		} else {
			this.renderFolderPathSuggester(contentEl);
		}

		// PR-1.F1 (G9): flipping Show files reveals or hides the File filters section at once.
		new Setting(contentEl)
			.setName("Show files")
			.addToggle((toggle) =>
				toggle.setValue(this.showFiles).onChange((value) => {
					this.showFiles = value;
					this.render();
				})
			);
		new Setting(contentEl)
			.setName("Show folders")
			.addToggle((toggle) => toggle.setValue(this.showFolders).onChange((value) => (this.showFolders = value)));

		// PR-6 (G12-G14): governs how a managed child's row reconciles when its file is deleted from
		// the vault — same three values/shared field as the API source's own "Fill mode" above, no
		// guard toggles here since `keepOnEmpty`/`confirmBeforeDelete` are API-refresh-only concerns.
		new Setting(contentEl)
			.setName("Fill mode")
			.setDesc(
				"Governs what happens when a child file is deleted from the vault. Merge shows the row as \"not found\" with Remove available; Append keeps the row but clears its attachment/link; Overwrite removes the row immediately."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("merge", "Merge")
					.addOption("append", "Append")
					.addOption("overwrite", "Overwrite")
					.setValue(this.mode)
					.onChange((value) => {
						this.mode = value as "append" | "merge" | "overwrite";
					})
			);

		this.renderRefreshToggles(contentEl);

		// PR-1.F1 (G9/G10/G11): File filters only for Inside-vault sources with Show files on. Show
		// folders never changes this section, and no Folder filters UI exists in v1.
		if (this.showFiles && this.folderLocation === "inside") this.renderFileFiltersSection(contentEl);
	}

	/** PR-1.F1 (G1/G2): the "File filters" section at the bottom of the Folder modal. Each row is a
	 * `key = value` YAML rule, ANDed on match. Rules are edited in place, and their trash button removes
	 * them. Saved with the modal's existing Save. */
	private renderFileFiltersSection(contentEl: HTMLElement): void {
		new Setting(contentEl).setName("File filters").setHeading();
		for (let i = 0; i < this.yamlRules.length; i++) {
			this.renderYamlRuleRow(contentEl, this.yamlRules[i], i);
		}
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("+ Add YAML rule").onClick(() => {
				this.yamlRules.push({ key: "", value: "" });
				this.render();
			})
		);
	}

	/** PR-1.F1 (G1/E5/F8): one rule row. The key field suggests vault frontmatter keys while it has
	 * focus, and accepts free text. The value field is plain text with no suggester. An empty key is
	 * outlined red with "Key required", which clears as soon as a key is typed. Save stays enabled. */
	private renderYamlRuleRow(contentEl: HTMLElement, rule: YamlRuleDraft, index: number): void {
		let keyField: TextComponent | null = null;
		let focused = false;
		const row = new Setting(contentEl);
		row.addText((text) => {
			keyField = text;
			text
				.setPlaceholder("Key")
				.setValue(rule.key)
				.onChange((value) => {
					rule.key = value;
					updateKeyState();
					renderSuggestions();
				});
			text.inputEl.addEventListener("focus", () => {
				focused = true;
				renderSuggestions();
			});
			text.inputEl.addEventListener("blur", () => {
				focused = false;
				listEl.empty();
			});
		});
		row.addText((text) =>
			text
				.setPlaceholder("Value")
				.setValue(rule.value)
				.onChange((value) => (rule.value = value))
		);
		row.addExtraButton((btn) =>
			btn.setIcon("trash").setTooltip("Remove rule").onClick(() => {
				this.yamlRules.splice(index, 1);
				this.render();
			})
		);

		const errorEl = contentEl.createEl("p", { cls: "atlas-api-field-error atlas-yaml-key-error" });
		const listEl = contentEl.createEl("div", { cls: "atlas-folder-suggest-list atlas-yaml-key-suggest" });

		const updateKeyState = () => {
			const missing = rule.key.trim() === "";
			keyField?.inputEl.classList.toggle("atlas-yaml-key-invalid", missing);
			errorEl.setText(missing ? "Key required" : "");
		};
		const renderSuggestions = () => {
			listEl.empty();
			if (!focused) return;
			for (const key of filterYamlKeySuggestions(this.vaultFrontmatterKeys(), rule.key)) {
				const item = listEl.createEl("div", { cls: "atlas-folder-suggest-item", text: key });
				// mousedown (not click) with preventDefault keeps focus in the key field while picking.
				item.addEventListener("mousedown", (evt) => {
					evt.preventDefault();
					rule.key = key;
					keyField?.setValue(key);
					listEl.empty();
					updateKeyState();
				});
			}
		};
		updateKeyState();
	}

	/** PR-1.F1 (G1): the vault's frontmatter keys, read from `app.metadataCache` and cached for this
	 * modal's lifetime. */
	private vaultFrontmatterKeys(): string[] {
		this.yamlKeyCache ??= collectFrontmatterKeys(this.app);
		return this.yamlKeyCache;
	}

	/** PR-5 (G6/G11): the Outside-Vault raw path field — no vault-folder suggester (there is nothing
	 * vault-relative to suggest), plus a red/green connection dot that recomputes `resolveOutsidePath`
	 * fresh on every keystroke, matching the explorer row's own dot (both read live, neither caches a
	 * connection state anywhere — satisfies F10's "no timer" fence by construction, not by omission). */
	private renderOutsidePathField(contentEl: HTMLElement): void {
		let indicatorEl: HTMLElement | null = null;
		const updateIndicator = () => {
			if (!indicatorEl) return;
			const resolved = resolveOutsidePath(this.outsidePath);
			indicatorEl.className = `atlas-api-connection-dot atlas-api-dot-${resolved ? "green" : "red"}`;
			setTooltip(indicatorEl, resolved ? "Path resolves on this device" : "Path does not resolve on this device");
		};

		const setting = new Setting(contentEl)
			.setName("Path")
			.setDesc("Absolute filesystem path on this device. Stored device-local only — never synced.")
			.addText((text) =>
				text
					.setPlaceholder("/Users/you/External Drive/Notes")
					.setValue(this.outsidePath)
					.onChange((value) => {
						this.outsidePath = value;
						updateIndicator();
						this.updateSaveButton();
					})
			);
		indicatorEl = setting.controlEl.createSpan();
		updateIndicator();
	}

	/** G3/GP1: a filterable list of every vault folder, vault-relative paths only — the selector starts
	 * empty (no default folder), matching the PR-3 contract that nothing is pre-selected until chosen. */
	private renderFolderPathSuggester(contentEl: HTMLElement): void {
		const allPaths = this.listVaultFolders();
		let listEl: HTMLElement | null = null;
		const renderList = (filter: string) => {
			if (!listEl) return;
			listEl.empty();
			const normalized = filter.trim().toLowerCase();
			const matches = normalized ? allPaths.filter((p) => p.toLowerCase().includes(normalized)) : allPaths;
			for (const path of matches.slice(0, 50)) {
				const item = listEl.createEl("div", { cls: "atlas-folder-suggest-item", text: path || "/" });
				item.onclick = () => {
					this.folderPath = path;
					this.render();
				};
			}
		};

		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Vault-relative path to the folder whose contents should populate this source.")
			.addText((text) =>
				text
					.setPlaceholder("Search vault folders…")
					.setValue(this.folderPath)
					.onChange((value) => {
						this.folderPath = value;
						this.updateSaveButton();
						renderList(value);
					})
			);
		listEl = contentEl.createEl("div", { cls: "atlas-folder-suggest-list" });
		renderList(this.folderPath);
	}

	/** Recursively walks the vault root so the suggester can offer every folder, not just top-level
	 * ones — narrow `TFolder`/`children` surface only, kept simple since this is UI-only plumbing. */
	private listVaultFolders(): string[] {
		const root = this.app.vault?.getRoot();
		if (!root) return [];
		const paths: string[] = [];
		const walk = (folder: TFolder) => {
			paths.push(folder.path);
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
			}
		};
		walk(root);
		return paths.filter((p) => p !== "/");
	}

	private buildExtraFieldsRecord(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const e of this.extraFields) {
			if (e.name && e.field && isValidExtraFieldName(e.name)) {
				out[e.name] = e.field;
			}
		}
		return out;
	}

	private canSave(): boolean {
		if (this.selectedType === "folder") {
			// E8: a path that doesn't currently resolve is still savable (it may start resolving later,
			// e.g. a drive remounting) — only blank/whitespace-only is rejected outright, same contract
			// Inside Vault already has for a path that doesn't currently resolve to a real folder.
			if (this.folderLocation === "outside" ? !this.outsidePath.trim() : !this.folderPath.trim()) return false;
			if (this.refreshEveryMinutesEnabled && !validateRefreshMinutes(this.refreshEveryMinutesRaw).ok) return false;
			return true;
		}
		if (this.selectedType === "csv") {
			if (this.mappingMode === "js") {
				if (!this.csvPath.trim()) return false;
				if (!validateJsSource(this.jsSource).ok) return false;
			} else if (!canSaveApiSource(this.csvPath, this.mapping)) {
				return false;
			}
			if (this.refreshEveryMinutesEnabled && !validateRefreshMinutes(this.refreshEveryMinutesRaw).ok) return false;
			for (let i = 0; i < this.extraFields.length; i++) {
				const extra = this.extraFields[i];
				if (!isValidExtraFieldName(extra.name)) return false;
				if (this.extraFields.findIndex((other) => other.name === extra.name) !== i) return false;
			}
			return true;
		}
		if (this.selectedType === "markdown-table") {
			// R1: block Save until an explicit table is chosen whenever there's a real choice to make.
			if (needsTableIndexPrompt(this.mdTables) && this.mdTableIndex === null) return false;
			if (this.mappingMode === "js") {
				if (!this.mdTablePath.trim()) return false;
				if (!validateJsSource(this.jsSource).ok) return false;
			} else if (!canSaveApiSource(this.mdTablePath, this.mapping)) {
				return false;
			}
			if (this.refreshEveryMinutesEnabled && !validateRefreshMinutes(this.refreshEveryMinutesRaw).ok) return false;
			for (let i = 0; i < this.extraFields.length; i++) {
				const extra = this.extraFields[i];
				if (!isValidExtraFieldName(extra.name)) return false;
				if (this.extraFields.findIndex((other) => other.name === extra.name) !== i) return false;
			}
			return true;
		}
		if (this.selectedType !== "api") return false;
		if (this.mappingMode === "js") {
			if (!this.url.trim()) return false;
			if (!validateJsSource(this.jsSource).ok) return false;
		} else if (!canSaveApiSource(this.url, this.mapping)) {
			return false;
		}
		if (this.refreshEveryMinutesEnabled && !validateRefreshMinutes(this.refreshEveryMinutesRaw).ok) return false;

		// Check extra fields validity: valid identifier, unique
		for (let i = 0; i < this.extraFields.length; i++) {
			const extra = this.extraFields[i];
			if (!isValidExtraFieldName(extra.name)) return false;
			if (this.extraFields.findIndex((other) => other.name === extra.name) !== i) return false;
		}

		// Check command validity if run-command is selected
		if (this.action === "run-command" && !Platform.isMobile) {
			const availableExtras = this.extraFields.map((e) => e.name);
			if (!validateCommand(this.command, availableExtras).ok) return false;
		}

		return true;
	}

	private updateSaveButton(): void {
		this.saveButton?.setDisabled(!this.canSave());
	}

	/** R2: was deriving `sampleFields` from the *top-level* response's own keys (`Object.keys`) no
	 * matter which array field got picked — wrong for an object response, whose rows live one level
	 * down inside that array. Now shares `sampleFieldsForArrayField` with the initial `fetchSample`
	 * fetch, so both derive fields from the chosen array's first item, not the wrapper object. */
	private applyMapping(): void {
		if (!this.lastResponse) return;
		this.sampleFields = sampleFieldsForArrayField(this.lastResponse, this.mapping.arrayField);
	}

	private async fetchSample(): Promise<void> {
		// R8/G13: mobile shows cached rows only — Fetch sample would otherwise attempt a live request.
		if (Platform.isMobile) {
			new Notice("Fetching a sample isn't available on mobile.");
			return;
		}
		const headerRecord: Record<string, string> = {};
		for (const header of this.headers) if (header.key) headerRecord[header.key] = header.value;

		const result = await httpGetJson(this.url, headerRecord, { requestImpl: obsidianRequestImpl });
		if (!result.ok) {
			new Notice(`Atlas: fetch failed — ${result.error.message}`);
			return;
		}
		this.lastResponse = result.json;
		this.arrayFieldCandidates = findArrayFields(result.json);
		this.sampleFields = sampleFieldsForArrayField(result.json, this.mapping.arrayField);
		this.testResult = null;
		if (this.sampleFields.length === 0 && this.arrayFieldCandidates.length === 0 && !Array.isArray(result.json)) {
			new Notice("Atlas: response is not a JSON list and has no array field to pick.");
		}
		this.render();
	}

	/** G3: "The Test button, Fetch sample and Save all use the active mode." Runs the active mode's
	 * mapping against the last-fetched sample and shows the resulting row/skip/truncate summary or the
	 * mapping error — never saves, never touches `apiCache`. */
	private async runTest(): Promise<void> {
		if (this.lastResponse === null) {
			new Notice("Fetch a sample first.");
			return;
		}
		const mappingWithExtras: ApiFieldMapping = {
			...this.mapping,
			extraFields: this.buildExtraFieldsRecord(),
		};
		const result = this.mappingMode === "js" ? await runJsMapping(this.jsSource, this.lastResponse) : mapResponseRows(this.lastResponse, mappingWithExtras);
		if (isMapError(result)) {
			this.testResult = `Error: ${result.error}`;
		} else {
			const parts = [`${result.rows.length} row(s)`];
			if (result.skippedCount > 0) parts.push(`${result.skippedCount} skipped`);
			if (result.truncated) parts.push("truncated at 5,000");

			if (this.action === "run-command" && this.command.trim()) {
				const availableExtras = this.extraFields.map((e) => e.name);
				const validation = validateCommand(this.command, availableExtras);
				if (!validation.ok) {
					parts.push(`Command error: ${validation.error}`);
				} else if (result.rows.length > 0) {
					const firstRow = result.rows[0];
					const resolved = resolveArgv(validation.tokens, firstRow.extra);
					if (resolved.ok) {
						parts.push(`Argv preview: ${JSON.stringify(resolved.argv)}`);
					} else {
						parts.push(`Argv preview error: ${resolved.error}`);
					}
				}
			}

			this.testResult = parts.join(", ");
		}
		this.render();
	}

	private save(): void {
		if (!this.canSave()) return;
		if (this.selectedType === "folder") {
			const refreshEveryMinutesValidation = this.refreshEveryMinutesEnabled
				? validateRefreshMinutes(this.refreshEveryMinutesRaw)
				: null;
			const source: FolderSourceConfig = {
				type: "folder",
				location: this.folderLocation,
				// G6: `path` stays vault-relative-only — the Outside-Vault absolute path never reaches
				// this (synced) shape at all, only the modal result's own `outsidePath` field.
				path: this.folderLocation === "inside" ? this.folderPath.trim() : "",
				showFiles: this.showFiles,
				showFolders: this.showFolders,
				refreshOnViewLoad: this.refreshOnViewLoad,
				refreshEveryMinutesEnabled: this.refreshEveryMinutesEnabled,
				refreshEveryMinutes: refreshEveryMinutesValidation?.ok ? refreshEveryMinutesValidation.minutes : undefined,
				removedRefs: this.removedRefs,
				mode: this.mode,
				// PR-1.F1 (G3/E5/F3): Save keeps only well-formed rules, so empty-key rules are dropped, and
				// no valid rule leaves the source unfiltered. Outside-vault sources never carry rules.
				filters:
					this.folderLocation === "inside"
						? sanitizeFolderFilters({ files: { yaml: { rules: this.yamlRules } } })
						: undefined,
			};
			this.close();
			this.onSave({ type: "folder", source, outsidePath: this.folderLocation === "outside" ? this.outsidePath.trim() : "" });
			return;
		}
		if (this.selectedType === "csv") {
			const refreshEveryMinutesValidation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
			const extraFieldsRecord = this.buildExtraFieldsRecord();
			const source: CsvSourceConfig = {
				type: "csv",
				path: this.csvPath.trim(),
				mapping: {
					...this.mapping,
					extraFields: Object.keys(extraFieldsRecord).length > 0 ? extraFieldsRecord : undefined,
				},
				mode: this.mode,
				refreshOnViewLoad: this.refreshOnViewLoad,
				refreshEveryMinutesEnabled: this.refreshEveryMinutesEnabled,
				refreshEveryMinutes: refreshEveryMinutesValidation?.ok ? refreshEveryMinutesValidation.minutes : undefined,
				keepOnEmpty: this.keepOnEmpty,
				confirmBeforeDelete: this.confirmBeforeDelete,
				mappingMode: this.mappingMode === "js" ? "js" : undefined,
				jsSource: this.mappingMode === "js" ? this.jsSource : undefined,
			};
			this.close();
			this.onSave({ type: "csv", source });
			return;
		}
		if (this.selectedType === "markdown-table") {
			const refreshEveryMinutesValidation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
			const extraFieldsRecord = this.buildExtraFieldsRecord();
			const source: MarkdownTableSourceConfig = {
				type: "markdown-table",
				path: this.mdTablePath.trim(),
				// `canSave()` above already guarantees a table is chosen whenever one must be (R1); the
				// fallback here only satisfies the type checker, never actually taken.
				tableIndex: this.mdTableIndex ?? 0,
				mapping: {
					...this.mapping,
					extraFields: Object.keys(extraFieldsRecord).length > 0 ? extraFieldsRecord : undefined,
				},
				mode: this.mode,
				refreshOnViewLoad: this.refreshOnViewLoad,
				refreshEveryMinutesEnabled: this.refreshEveryMinutesEnabled,
				refreshEveryMinutes: refreshEveryMinutesValidation?.ok ? refreshEveryMinutesValidation.minutes : undefined,
				keepOnEmpty: this.keepOnEmpty,
				confirmBeforeDelete: this.confirmBeforeDelete,
				mappingMode: this.mappingMode === "js" ? "js" : undefined,
				jsSource: this.mappingMode === "js" ? this.jsSource : undefined,
			};
			this.close();
			this.onSave({ type: "markdown-table", source });
			return;
		}
		// canSave() above guarantees selectedType === "api" by this point.
		const refreshEveryMinutesValidation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
		const extraFieldsRecord = this.buildExtraFieldsRecord();
		const source: ApiSourceConfig = {
			type: "api",
			url: this.url.trim(),
			method: "GET",
			mapping: {
				...this.mapping,
				extraFields: Object.keys(extraFieldsRecord).length > 0 ? extraFieldsRecord : undefined,
			},
			mode: this.mode,
			refreshOnViewLoad: this.refreshOnViewLoad,
			refreshEveryMinutesEnabled: this.refreshEveryMinutesEnabled,
			refreshEveryMinutes: refreshEveryMinutesValidation?.ok ? refreshEveryMinutesValidation.minutes : undefined,
			keepOnEmpty: this.keepOnEmpty,
			confirmBeforeDelete: this.confirmBeforeDelete,
			mappingMode: this.mappingMode === "js" ? "js" : undefined,
			jsSource: this.mappingMode === "js" ? this.jsSource : undefined,
			action: this.action,
			clickAction: this.action,
			command: this.action === "run-command" ? this.command.trim() : undefined,
		};
		this.close();
		this.onSave({ type: "api", source, headers: this.headers.filter((h) => h.key.trim().length > 0) });
	}
}
