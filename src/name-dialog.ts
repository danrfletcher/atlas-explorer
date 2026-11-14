import { App, Modal } from "obsidian";
import { NameRuleOptions, collectRootEntries, validateName } from "./name-rules";

export interface NameDialogOptions {
	title: string;
	initialValue: string;
	/** `non-empty` is for Create > Block, whose file is named by ID. Default `full`. */
	mode?: "full" | "non-empty";
	/** Root file paths that don't count as a clash (Create Module keeps the file's own name). */
	ignoreRootPaths?: string[];
	poolFolder?: string;
	excludedFolders?: string[];
	/** PR-3.F2 (G2): the confirm button's label. Every Create caller leaves this out and keeps
	 * "Create"; Add under > File/Module pass "Add" so the dialog reads "Add file under <parent>" /
	 * "Add" rather than "Create File" / "Create". Validation, the clash rule and the red/green
	 * classes are all unaffected by this — only the button's own text changes. */
	confirmLabel?: string;
	/** PR-5 (G3): replaces the vault's name rules. Add source passes its own source-name rules; every other
	 * caller leaves this out and keeps `validateName`. */
	validate?: (name: string) => { valid: true } | { valid: false; message: string };
	/** PR-5 (G3): runs once on confirm, after validation passes. It resolves a reason to keep the dialog open
	 * (the typed name stays, only the reason is shown, and confirm works again) or `null` to accept, which
	 * closes the dialog and resolves the name. While it runs a second confirm does nothing. */
	onSubmit?: (name: string) => Promise<string | null>;
}

/** Only one name dialog may be open at a time. */
let activeDialog: NameDialog | null = null;

/** Resolves the typed name exactly as typed, or `null` if cancelled (or if another name dialog is
 * already open). */
export function openNameDialog(app: App, options: NameDialogOptions): Promise<string | null> {
	if (activeDialog) return Promise.resolve(null);
	return new Promise((resolve) => {
		const dialog = new NameDialog(app, options, resolve);
		activeDialog = dialog;
		dialog.open();
	});
}

/** For plugin unload: cancels the open dialog, if any. */
export function closeNameDialog(): void {
	activeDialog?.close();
}

class NameDialog extends Modal {
	private inputEl!: HTMLInputElement;
	private messageEl!: HTMLElement;
	private createBtn!: HTMLButtonElement;
	private settled = false;
	/** An `onSubmit` is running: confirm does nothing until it answers. */
	private submitting = false;

	constructor(
		app: App,
		private options: NameDialogOptions,
		private resolve: (value: string | null) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.options.title);

		this.inputEl = contentEl.createEl("input", { type: "text", cls: "atlas-name-input" });
		this.inputEl.value = this.options.initialValue;
		this.messageEl = contentEl.createDiv({ cls: "atlas-name-message" });
		this.messageEl.setAttribute("role", "alert");

		const buttons = contentEl.createDiv({ cls: "atlas-name-buttons" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.settle(null));
		// A disabled button swallows the click and lets focus fall to the page, so the wrapper
		// (which receives the pointer events while the button is disabled) keeps focus in the box.
		const createWrap = buttons.createSpan({ cls: "atlas-name-create-wrap" });
		this.createBtn = createWrap.createEl("button", { text: this.options.confirmLabel ?? "Create", cls: "mod-cta" });
		this.createBtn.addEventListener("click", () => this.submit());
		createWrap.addEventListener("mousedown", (evt) => {
			if (!this.createBtn.disabled) return;
			evt.preventDefault();
			this.inputEl.focus();
		});

		this.inputEl.addEventListener("input", () => {
			const stripped = this.inputEl.value.replace(/[\r\n]/g, "");
			if (stripped !== this.inputEl.value) this.inputEl.value = stripped;
			this.validate();
		});
		this.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				if (!evt.isComposing) this.submit();
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.settle(null);
			}
		});

		this.validate();
		this.inputEl.focus();
		this.inputEl.select();
	}

	/** Reads the live vault root every time, so a note created while the dialog is open is caught. */
	private validate(): boolean {
		const { mode, ignoreRootPaths, poolFolder, excludedFolders } = this.options;
		const result = this.options.validate
			? this.options.validate(this.inputEl.value)
			: validateName(this.inputEl.value, {
					mode,
					ignoreRootPaths,
					poolFolder,
					excludedFolders,
					root: mode === "non-empty" ? [] : collectRootEntries(this.app.vault),
				} satisfies NameRuleOptions);

		this.showResult(result.valid, result.valid ? "" : result.message);
		return result.valid;
	}

	private showResult(valid: boolean, message: string): void {
		this.inputEl.toggleClass("atlas-name-valid", valid);
		this.inputEl.toggleClass("atlas-name-invalid", !valid);
		this.inputEl.setAttribute("aria-invalid", String(!valid));
		this.createBtn.disabled = !valid || this.submitting;
		this.messageEl.setText(valid ? "" : message);
		this.messageEl.toggleClass("atlas-hidden", valid);
	}

	private submit(): void {
		if (this.settled || this.submitting) return;
		if (!this.validate()) {
			this.inputEl.focus();
			return;
		}
		const { onSubmit } = this.options;
		if (!onSubmit) {
			this.settle(this.inputEl.value);
			return;
		}
		const value = this.inputEl.value;
		this.submitting = true;
		this.createBtn.disabled = true;
		void onSubmit(value).then(
			(refusal) => this.finishSubmit(value, refusal),
			() => this.finishSubmit(value, "Something went wrong. Try again.")
		);
	}

	private finishSubmit(value: string, refusal: string | null): void {
		this.submitting = false;
		if (this.settled) return; // cancelled while it ran
		if (refusal === null) {
			this.settle(value);
			return;
		}
		this.showResult(false, refusal);
		this.createBtn.disabled = false;
		this.inputEl.focus();
	}

	/** Resolves exactly once, releasing the one-dialog guard before handing control to the caller. */
	private settle(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		if (activeDialog === this) activeDialog = null;
		this.resolve(value);
		this.close();
	}

	onClose(): void {
		this.settle(null);
		this.contentEl.empty();
	}
}
