import { App, FuzzySuggestModal, Modal, Platform } from "obsidian";
import { validateClickActionValue } from "./click-action-validation";
import { ClickAction, ClickActionKind } from "./types";
import { sanitizeClickAction } from "./views";

/** Atlas-18 (G1/G2/G10): which kind of Bucket row a Click action is being set on. It decides what the
 * "no action" choice is called, because that choice always stores nothing (the key is absent). */
export type ClickActionTarget = "module" | "folder" | "api-item";

/** The dropdown's choices: the three kinds, plus `unset`, which stores nothing. */
export type ClickActionChoice = "unset" | ClickActionKind;

export interface ClickActionChoiceOption {
	value: ClickActionChoice;
	label: string;
}

const UNSET_LABELS: Record<ClickActionTarget, string> = {
	module: "Default (open the interface note)",
	folder: "None",
	"api-item": "Use source setting",
};

const UNSET_HELP: Record<ClickActionTarget, string> = {
	module: "Clicking this module opens its interface note, as it does today.",
	folder: "Clicking this Folder does nothing, as it does today.",
	"api-item": "This row follows its data source's click setting.",
};

const KIND_LABELS: Record<ClickActionKind, string> = {
	terminal: "Run terminal command (desktop only)",
	command: "Run Obsidian command",
	uri: "Open Obsidian URI",
};

const KIND_ORDER: ClickActionKind[] = ["terminal", "command", "uri"];

/** The Kind dropdown's options, in order. On mobile the terminal kind is not offered for a new setting,
 * but a terminal action that is already stored (synced from desktop) keeps its option so the modal can
 * show it; it can then be changed to another kind or cleared. */
export function clickActionChoices(target: ClickActionTarget, isMobile: boolean, stored?: ClickAction): ClickActionChoiceOption[] {
	const options: ClickActionChoiceOption[] = [{ value: "unset", label: UNSET_LABELS[target] }];
	for (const kind of KIND_ORDER) {
		if (kind === "terminal" && isMobile && stored?.kind !== "terminal") continue;
		options.push({ value: kind, label: KIND_LABELS[kind] });
	}
	return options;
}

/** The modal's whole state, kept apart from the DOM. It holds one draft value per kind for the life of the
 * modal (switching kind and back loses nothing), and only the active kind is ever turned into a result. */
export class ClickActionDraft {
	private active: ClickActionChoice;
	private readonly drafts: Record<ClickActionKind, string> = { terminal: "", command: "", uri: "" };
	/** The action this modal opened with; kept for the mobile read-only case. */
	readonly stored: ClickAction | undefined;

	/** `stored` is whatever the node holds in memory. A malformed one (an unknown kind, a non-string value,
	 * not an object at all) reads as no action rather than throwing, so the modal opens on the default. */
	constructor(readonly target: ClickActionTarget, stored: unknown, readonly isMobile: boolean) {
		this.stored = sanitizeClickAction(stored);
		this.active = this.stored ? this.stored.kind : "unset";
		if (this.stored) this.drafts[this.stored.kind] = this.stored.value;
	}

	get choice(): ClickActionChoice {
		return this.active;
	}

	get options(): ClickActionChoiceOption[] {
		return clickActionChoices(this.target, this.isMobile, this.stored);
	}

	/** Switches the active kind. A choice the dropdown does not offer (terminal on mobile with none stored)
	 * is ignored. */
	setChoice(choice: ClickActionChoice): void {
		if (!this.options.some((option) => option.value === choice)) return;
		this.active = choice;
	}

	/** The active kind's draft value (empty when there is no active kind). */
	get value(): string {
		return this.active === "unset" ? "" : this.drafts[this.active];
	}

	/** On mobile a terminal action is shown but not editable: it only can be changed to another kind or cleared. */
	get readOnly(): boolean {
		return this.isMobile && this.active === "terminal";
	}

	/** Sets the active kind's draft. Ignored while there is no active kind or the value is read-only. */
	setValue(value: string): void {
		if (this.active === "unset" || this.readOnly) return;
		this.drafts[this.active] = value;
	}

	/** `null` when the draft can be saved, otherwise the inline error. "No action" always can. */
	error(): string | null {
		if (this.active === "unset") return null;
		const result = validateClickActionValue(this.active, this.drafts[this.active]);
		return result.ok ? null : result.error;
	}

	/** What Save stores: `undefined` (absent) for the no-action choice, otherwise the active kind and its
	 * value exactly as typed. Other kinds' drafts are never part of it. */
	result(): ClickAction | undefined {
		if (this.active === "unset") return undefined;
		return { kind: this.active, value: this.drafts[this.active] };
	}
}

export interface RegisteredCommand {
	id: string;
	name: string;
}

interface AppWithCommands {
	commands?: { commands?: Record<string, { id?: string; name?: string } | undefined> };
}

/** F9: every command registered right now, read from `app.commands.commands` at call time (never a
 * hard-coded list), sorted by display name. Obsidian's `commands` map is internal API, hence the cast. */
export function listRegisteredCommands(app: App): RegisteredCommand[] {
	const map = (app as unknown as AppWithCommands).commands?.commands ?? {};
	const out: RegisteredCommand[] = [];
	for (const [key, command] of Object.entries(map)) {
		if (!command) continue;
		out.push({ id: command.id ?? key, name: command.name ?? command.id ?? key });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The display name of a command id, or `null` when it is not registered right now. */
export function registeredCommandName(app: App, id: string): string | null {
	return listRegisteredCommands(app).find((command) => command.id === id)?.name ?? null;
}

/** G5: a fuzzy picker over every command registered right now, searched and shown by display name.
 * Choosing one hands back its id, not its name. */
export class CommandPickerModal extends FuzzySuggestModal<RegisteredCommand> {
	constructor(app: App, private onChoose: (id: string) => void) {
		super(app);
		// A prompt-style suggest modal never renders `setTitle`; the placeholder is what the user sees.
		this.setPlaceholder("Search commands…");
	}

	getItems(): RegisteredCommand[] {
		return listRegisteredCommands(this.app);
	}

	getItemText(item: RegisteredCommand): string {
		return item.name;
	}

	onChooseItem(item: RegisteredCommand): void {
		this.onChoose(item.id);
	}
}

/** Atlas-18 (G1/G2/G4-G6/G10): the **Click action…** modal. Kind dropdown, a value control for the chosen
 * kind, Save and Cancel. Save hands the result to `onSave` exactly once (`undefined` = clear the action);
 * Cancel, Escape and clicking outside hand back nothing, whatever was edited. It stores nothing itself
 * and runs nothing. */
export class ClickActionModal extends Modal {
	private readonly draft: ClickActionDraft;
	private selectEl!: HTMLSelectElement;
	private valueEl!: HTMLElement;
	private messageEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private textEl: HTMLInputElement | null = null;
	private picker: CommandPickerModal | null = null;
	private settled = false;

	constructor(
		app: App,
		target: ClickActionTarget,
		stored: unknown,
		private onSave: (action: ClickAction | undefined) => void,
		isMobile: boolean = Platform.isMobile
	) {
		super(app);
		this.draft = new ClickActionDraft(target, stored, isMobile);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Click action");

		const kindRow = contentEl.createDiv({ cls: "atlas-click-action-row" });
		kindRow.createSpan({ cls: "atlas-click-action-label", text: "Kind" });
		this.selectEl = kindRow.createEl("select", { cls: "dropdown atlas-click-action-kind" });
		for (const option of this.draft.options) this.selectEl.createEl("option", { text: option.label, attr: { value: option.value } });
		this.selectEl.value = this.draft.choice;
		this.selectEl.addEventListener("change", () => {
			this.draft.setChoice(this.selectEl.value as ClickActionChoice);
			this.renderValue(true);
		});

		this.valueEl = contentEl.createDiv({ cls: "atlas-click-action-value" });
		this.messageEl = contentEl.createDiv({ cls: "atlas-name-message" });
		this.messageEl.setAttribute("role", "alert");

		const buttons = contentEl.createDiv({ cls: "atlas-name-buttons" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		// A disabled button swallows the click and lets focus fall to the page, so the wrapper keeps it in the field.
		const saveWrap = buttons.createSpan({ cls: "atlas-name-create-wrap" });
		this.saveBtn = saveWrap.createEl("button", { text: "Save", cls: "mod-cta" });
		this.saveBtn.addEventListener("click", () => this.submit());
		saveWrap.addEventListener("mousedown", (evt) => {
			if (!this.saveBtn.disabled) return;
			evt.preventDefault();
			this.textEl?.focus();
		});

		this.renderValue(true);
	}

	/** Rebuilds only the value area for the active kind. `.modal` is what scrolls, and emptying part of it
	 * lets scroll anchoring reset it, so its position is saved and put back here, not at the call sites. */
	private renderValue(focus: boolean): void {
		const scrollTop = this.modalEl.scrollTop;
		this.valueEl.empty();
		this.textEl = null;
		const { choice } = this.draft;

		if (choice === "unset") {
			this.valueEl.createDiv({ cls: "atlas-click-action-help", text: UNSET_HELP[this.draft.target] });
		} else if (choice === "command") {
			this.renderCommandValue();
		} else {
			const input = this.valueEl.createEl("input", { type: "text", cls: "atlas-name-input" });
			input.value = this.draft.value;
			input.placeholder = choice === "terminal" ? "open -a Docker" : "obsidian://open?vault=Notes&file=Docker";
			input.spellcheck = false;
			input.setAttribute("aria-label", choice === "terminal" ? "Command line" : "URI");
			if (this.draft.readOnly) {
				input.readOnly = true;
				this.valueEl.createDiv({
					cls: "atlas-click-action-help",
					text: "Terminal commands only run on desktop. Choose another kind, or Default, to change this.",
				});
			}
			input.addEventListener("input", () => {
				this.draft.setValue(input.value);
				this.refreshState();
			});
			input.addEventListener("keydown", (evt) => {
				if (evt.key !== "Enter") return;
				evt.preventDefault();
				if (!evt.isComposing) this.submit();
			});
			this.textEl = input;
			if (focus) {
				input.focus();
				if (!this.draft.readOnly) input.select();
			}
		}

		this.refreshState();
		this.modalEl.scrollTop = scrollTop;
	}

	private renderCommandValue(): void {
		const id = this.draft.value;
		const row = this.valueEl.createDiv({ cls: "atlas-click-action-command" });
		const shown = row.createDiv({ cls: "atlas-click-action-command-shown" });
		if (id === "") {
			shown.createSpan({ cls: "atlas-click-action-command-name atlas-click-action-muted", text: "No command chosen" });
		} else {
			// G5: a stored id that is no longer registered is shown as the raw id and can still be saved unchanged.
			const name = registeredCommandName(this.app, id);
			shown.createSpan({ cls: "atlas-click-action-command-name", text: name ?? id });
			if (name !== null) shown.createDiv({ cls: "atlas-click-action-command-id", text: id });
			else shown.createDiv({ cls: "atlas-click-action-command-id", text: "Not registered right now" });
		}
		row.createEl("button", { text: id === "" ? "Choose command…" : "Change…", cls: "atlas-click-action-choose" }).addEventListener("click", () => this.openPicker());
	}

	private openPicker(): void {
		this.picker?.close();
		this.picker = new CommandPickerModal(this.app, (id) => {
			this.draft.setValue(id);
			this.renderValue(false);
		});
		this.picker.open();
	}

	/** Mirrors the draft's validity into the inline message, the field's border and the Save button. */
	private refreshState(): void {
		const error = this.draft.error();
		const invalid = error !== null;
		this.messageEl.setText(error ?? "");
		this.messageEl.toggleClass("atlas-hidden", !invalid);
		if (this.textEl) {
			this.textEl.toggleClass("atlas-name-valid", !invalid);
			this.textEl.toggleClass("atlas-name-invalid", invalid);
			this.textEl.setAttribute("aria-invalid", String(invalid));
		}
		this.saveBtn.disabled = invalid;
	}

	private submit(): void {
		if (this.settled) return;
		if (this.draft.error() !== null) {
			this.textEl?.focus();
			return;
		}
		this.settled = true;
		const result = this.draft.result();
		this.close();
		this.onSave(result);
	}

	/** Set by the opener to learn when this modal closes, however it closes (Save, Cancel, Escape, outside click). */
	onClosed?: () => void;

	onClose(): void {
		this.settled = true;
		this.picker?.close();
		this.picker = null;
		this.contentEl.empty();
		this.onClosed?.();
	}
}
