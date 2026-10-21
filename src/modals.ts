import { App, Modal, Setting, TextComponent, ToggleComponent } from "obsidian";
import { StatusSet } from "./statuses";
import { ApplyToConfig, StatusGovernance } from "./types";

/** A single text field + OK/Cancel, for anything that needs a short name from the user (new view,
 * rename, new meta folder). Submits on Enter or the OK button.
 * PR-2.F2: `onCancel` (Cancel button, Esc, or the close button — anything that closes this modal
 * without submitting) is optional and defaults to a no-op, so every existing caller is unaffected;
 * "Add under… > Folder" is the first caller that needs it, to release its per-parent lock on E1. */
export class TextPromptModal extends Modal {
	private value: string;
	private submitted = false;

	constructor(
		app: App,
		private title: string,
		initialValue: string,
		private onSubmit: (value: string) => void,
		private placeholder = "",
		private onCancel?: () => void
	) {
		super(app);
		this.value = initialValue;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		let inputEl: HTMLInputElement | undefined;
		new Setting(contentEl).addText((text) => {
			inputEl = text.inputEl;
			text.setPlaceholder(this.placeholder)
				.setValue(this.value)
				.onChange((value) => (this.value = value));
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setCta()
					.setButtonText("OK")
					.onClick(() => this.submit())
			);
		window.setTimeout(() => {
			inputEl?.focus();
			inputEl?.select();
		}, 0);
	}

	private submit(): void {
		this.submitted = true;
		const value = this.value;
		this.close();
		this.onSubmit(value);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.submitted) this.onCancel?.();
	}
}

/** PR 15/17: the "Statuses" modal — opened from a bucket item's (or the view-name selector's, for
 * root-level assignment) right-click menu. A master on/off toggle plus which status set governs
 * the *children* of the right-clicked item (Dan's own spec: "the statuses apply to the first
 * direct children under that item" — this item's own row is never itself affected), plus (PR 17)
 * inherit-to-subfolders, hide-completed/cancelled, which unit kinds receive treatment, per-
 * status truncation, and (PR 22) sorting children by status with an optional reverse. Everything
 * below the master toggle is disabled while it's off, but never
 * discarded (Dan's own edge case AC) — `this.governance` keeps every field locally regardless of
 * `statusEnabled`, the same way the underlying data model does. Applies live on every change
 * (matching the reference plugin's own framing of a persistent, greyed-out-until-enabled modal)
 * rather than a draft-then-submit OK/Cancel pattern, since there's nothing here worth batching.
 * Re-renders itself on any change that affects what else should be shown/enabled (master toggle,
 * status set choice, a truncate-row's own enable flip) rather than tracking a component reference
 * per field — simpler once the modal has this many fields, matching the settings tab's own
 * `display()` re-render pattern. Text fields (truncate labels) don't trigger a re-render, only
 * their own `onChange`, so typing in them doesn't fight the modal for focus. */
export class StatusesModal extends Modal {
	private governance: StatusGovernance;

	constructor(app: App, private statusSets: StatusSet[], initial: StatusGovernance, private onChange: (patch: Partial<StatusGovernance>) => void) {
		super(app);
		this.governance = { ...initial };
		// Dan-found (PR 17): defaulted and *persisted* here too, not just cosmetically shown by the
		// dropdown's own `setValue` fallback — belt and braces so there's no possible path where the
		// saved governance ends up with `statusEnabled: true` but `statusSetId` still unset because
		// the only change the user ever made was the master toggle, never the dropdown itself.
		if (this.governance.statusSetId === undefined && statusSets.length > 0) {
			this.governance.statusSetId = statusSets[0].id;
			this.onChange({ statusSetId: this.governance.statusSetId });
		}
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		// Dan-found: every change re-renders this modal (see the class doc comment for why), which
		// was silently resetting scroll to the top on each one — jarring on a modal this tall. The
		// element that actually scrolls is `modalEl` (`.modal`, `overflow-y: auto`), not `contentEl`
		// (`.modal-content`, which just grows to its natural height with no scroll of its own) —
		// confirmed live via `getComputedStyle`/`scrollHeight` before assuming which one to save.
		const scrollTop = this.modalEl.scrollTop;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Statuses" });

		const hasSets = this.statusSets.length > 0;
		if (!hasSets) {
			contentEl.createEl("p", {
				text: "No status sets exist yet — create one in Settings → Atlas → Status before enabling this.",
				cls: "setting-item-description",
			});
			// Dan-found bug (PR 14): the toggle used to stay enabled with no set to actually assign,
			// silently persisting `statusEnabled: true, statusSetId: undefined` — enabled but never
			// resolving to a visible status anywhere. Disabling the toggle itself when there's
			// nothing to pick makes that state unreachable instead of just unlikely.
			if (this.governance.statusEnabled) {
				this.governance.statusEnabled = false;
				this.onChange({ statusEnabled: false });
			}
		}
		// (statusSetId's own default is handled once, in the constructor — see its comment.)

		new Setting(contentEl)
			.setName("Enable statuses")
			.setDesc("Applies to this item's direct children, not this item itself.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.statusEnabled)
					.setDisabled(!hasSets)
					.onChange((value) => {
						this.governance.statusEnabled = value;
						this.onChange({ statusEnabled: value });
						this.render();
					})
			);

		const disabled = !this.governance.statusEnabled || !hasSets;

		new Setting(contentEl).setName("Status set").addDropdown((dropdown) => {
			if (!hasSets) {
				dropdown.addOption("", "Create a status set first");
			} else {
				for (const set of this.statusSets) dropdown.addOption(set.id, set.name);
				dropdown.setValue(this.governance.statusSetId ?? this.statusSets[0].id);
			}
			dropdown.setDisabled(disabled);
			dropdown.onChange((value) => {
				this.governance.statusSetId = value || undefined;
				this.onChange({ statusSetId: this.governance.statusSetId });
				this.render(); // the truncate section below depends on which set is now chosen
			});
		});

		new Setting(contentEl)
			.setName("Inherit to subfolders")
			.setDesc("Apply this status set all the way down the tree, not just to direct children, until a closer item has its own assignment.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.inheritToSubfolders)
					.setDisabled(disabled)
					.onChange((value) => {
						this.governance.inheritToSubfolders = value;
						this.onChange({ inheritToSubfolders: value });
					})
			);

		new Setting(contentEl)
			.setName("Hide completed")
			.setDesc("Hide items whose current status is marked completed.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.hideCompleted)
					.setDisabled(disabled)
					.onChange((value) => {
						this.governance.hideCompleted = value;
						this.onChange({ hideCompleted: value });
					})
			);

		new Setting(contentEl)
			.setName("Hide cancelled")
			.setDesc("Hide items whose current status is marked cancelled.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.hideCancelled)
					.setDisabled(disabled)
					.onChange((value) => {
						this.governance.hideCancelled = value;
						this.onChange({ hideCancelled: value });
					})
			);

		new Setting(contentEl).setName("Apply statuses to").setHeading();
		const applyToFields: { key: keyof ApplyToConfig; label: string; desc: string }[] = [
			{ key: "block", label: "Blocks", desc: "Free and promoted blocks." },
			{ key: "file", label: "Files", desc: "Files and promoted files." },
			{ key: "module", label: "Modules", desc: "Real folders on disk." },
			{ key: "metaFolder", label: "Meta folders", desc: "Organizational labels with no disk presence." },
		];
		for (const field of applyToFields) {
			new Setting(contentEl)
				.setName(field.label)
				.setDesc(field.desc)
				.addToggle((toggle) =>
					toggle
						.setValue(this.governance.applyTo?.[field.key] ?? true)
						.setDisabled(disabled)
						.onChange((value) => {
							const next: ApplyToConfig = { ...this.governance.applyTo, [field.key]: value };
							this.governance.applyTo = next;
							this.onChange({ applyTo: next });
						})
				);
		}

		// PR 22 (grilled with Dan directly): ranks children by their resolved status's own position
		// within this governor's status set instead of today's manual/drag-ordered arrangement.
		// "Reverse" only ever modifies *that* rank order — it's not a general "flip my manual
		// arrangement" toggle, so it's meaningless (and disabled) while sort-by-status is off, rather
		// than shown as some independent control.
		let reverseToggle: ToggleComponent | null = null;
		new Setting(contentEl)
			.setName("Sort children by status")
			.setDesc("Order by each item's own status instead of the manually-arranged order.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.governance.sortMode === "status")
					.setDisabled(disabled)
					.onChange((value) => {
						// G12/G19: on sets Status from whatever mode was set before; off can only
						// have come from Status (the toggle shows on only then), and sets Manual.
						// Like picking a mode in the "Sort children…" menu, either resets Reverse.
						this.governance.sortMode = value ? "status" : "manual";
						this.governance.sortReverse = false;
						this.onChange({ sortMode: this.governance.sortMode, sortReverse: false });
						reverseToggle?.setValue(false).setDisabled(disabled || !value);
					})
			);
		new Setting(contentEl)
			.setName("Reverse order")
			.setDesc("Reverse the status-based sort above.")
			.addToggle((toggle) => {
				reverseToggle = toggle;
				toggle
					.setValue(!!this.governance.sortReverse)
					.setDisabled(disabled || this.governance.sortMode !== "status")
					.onChange((value) => {
						this.governance.sortReverse = value;
						this.onChange({ sortReverse: value });
					});
			});

		const chosenSet = this.statusSets.find((s) => s.id === this.governance.statusSetId);
		if (chosenSet && chosenSet.statuses.length > 0) {
			new Setting(contentEl).setName("Truncate statuses").setHeading();
			contentEl.createEl("p", {
				text: "Collapse every item with a given status into a single summary row instead of listing each one.",
				cls: "setting-item-description",
			});
			for (const status of chosenSet.statuses) {
				const truncConfig = this.governance.truncatedStatuses?.[status.id];
				const truncEnabled = !!truncConfig?.enabled;
				const row = new Setting(contentEl).setName(status.label);
				// Dan-found: the label field used to only exist in the DOM once truncation was turned
				// on for this status, added *after* the toggle — since `Setting`'s control group is
				// right-aligned as a block, that made the toggle itself visibly jump left every time
				// the field appeared/disappeared (the group growing wider pushed its own left edge,
				// and everything in it, further left to stay flush against the row's right edge).
				// Fixed per Dan's own preferred alternative: the field is always present (ordered
				// before the toggle, so the toggle stays the fixed rightmost element regardless), just
				// disabled and unfocusable until truncation is actually on for this status — nothing
				// appears/disappears anymore, so nothing can jump.
				let labelInput: TextComponent | null = null;
				row.addText((text) => {
					labelInput = text;
					text
						.setPlaceholder("Summary label")
						.setValue(truncConfig?.label ?? "")
						.setDisabled(disabled || !truncEnabled)
						.onChange((value) => {
							const current = this.governance.truncatedStatuses?.[status.id];
							const next = { ...this.governance.truncatedStatuses, [status.id]: { enabled: !!current?.enabled, label: value } };
							this.governance.truncatedStatuses = next;
							this.onChange({ truncatedStatuses: next });
						});
				});
				row.addToggle((toggle) =>
					toggle
						.setValue(truncEnabled)
						.setDisabled(disabled)
						.onChange((value) => {
							const current = this.governance.truncatedStatuses?.[status.id];
							const next = { ...this.governance.truncatedStatuses, [status.id]: { enabled: value, label: current?.label } };
							this.governance.truncatedStatuses = next;
							this.onChange({ truncatedStatuses: next });
							// Only the affected field's own disabled state needs to change — no need
							// for a full `this.render()` (and the scroll-position jump that would
							// otherwise risk, even with it now preserved) just for this.
							labelInput?.setDisabled(disabled || !value);
						})
				);
			}
		}

		new Setting(contentEl).addButton((btn) => btn.setButtonText("Done").setCta().onClick(() => this.close()));

		this.modalEl.scrollTop = scrollTop;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private message: string, private confirmLabel: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setWarning()
					.setButtonText(this.confirmLabel)
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** G6b(ii): confirms deleting `count` row(s) before an Overwrite refresh applies. Unlike `ConfirmModal`,
 * the caller needs to tell "Cancel" (a deliberate button click) apart from "dismissed" (Escape, or the
 * whole Atlas view closing out from under an open modal) — an automatic refresh's confirmation treats
 * those two differently (G6b: dismissed keeps rows and goes amber; an explicit Cancel just keeps rows).
 * `onOpen`'s two buttons both call `close()` themselves after recording which one fired; `onClose()`
 * fires on every path (both buttons *and* Escape/outside-click alike, per Obsidian's `Modal` lifecycle)
 * and reports "dismissed" only when neither button already claimed the answer. */
export class ConfirmDeleteRowsModal extends Modal {
	private answered: "confirmed" | "cancelled" | null = null;

	constructor(app: App, private count: number, private onAnswer: (answer: "confirmed" | "cancelled" | "dismissed") => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const noun = this.count === 1 ? "row" : "rows";
		contentEl.createEl("p", { text: `This refresh will delete ${this.count} ${noun} no longer in the response. This can't be undone.` });
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.answered = "cancelled";
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setWarning()
					.setButtonText("Delete rows")
					.onClick(() => {
						this.answered = "confirmed";
						this.close();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onAnswer(this.answered ?? "dismissed");
	}
}
