import type { TephraConnection, TephraSnapshot } from "./tephra-connection";
import { TEPHRA_START_ARGV, type TephraStarter } from "./tephra-start";

/** What the status bar item says for one connection state (G13). `online` and `offline` are Tephra's; `starting`
 * is "Start was clicked and no check has answered yet"; `checking` is the moment between turning the toggle on
 * (or reloading) and the first answer, when "offline" would be a guess. */
export type TephraStatusKind = "checking" | "online" | "offline" | "starting";

export interface TephraStatusLabel {
	kind: TephraStatusKind;
	/** The item's whole text, `Start` included when it has one. */
	text: string;
	/** Shown on hover and keyboard focus by an Atlas-owned element (never `aria-label` or Obsidian's tooltip). */
	tooltip: string;
	/** Whether the item carries a Start control. */
	showStart: boolean;
}

export const TEPHRA_REFUSED_TOOLTIP = "Tephra refused the token";

/**
 * G13/E1: the label rule, one pure function. `null` means no status-bar item at all (the toggle is off).
 *
 * Online: "Tephra · N sources" ("1 source" singular), N being what Tephra lists, vault included. A 401 counts as
 * offline for display: the same "Tephra offline · Start" text, with the tooltip "Tephra refused the token". Starting
 * wins over offline (never over online: if Tephra answered, it is running).
 */
export function tephraStatusLabel(snapshot: Pick<TephraSnapshot, "state" | "checked" | "sources" | "error">, starting: boolean): TephraStatusLabel | null {
	if (snapshot.state === "off") return null;
	if (snapshot.state === "online") {
		const count = snapshot.sources.length;
		return { kind: "online", text: `Tephra · ${count} ${count === 1 ? "source" : "sources"}`, tooltip: "Tephra is running. Click to open the Tephra settings.", showStart: false };
	}
	if (starting) return { kind: "starting", text: "Tephra starting…", tooltip: "Starting Tephra. This updates when it answers.", showStart: false };
	if (!snapshot.checked) return { kind: "checking", text: "Tephra · checking…", tooltip: "Checking whether Tephra is running.", showStart: false };
	const refused = snapshot.error?.kind === "unauthorized";
	return {
		kind: "offline",
		text: "Tephra offline · Start",
		tooltip: refused ? TEPHRA_REFUSED_TOOLTIP : `Tephra isn't running. Click Start to run \`${TEPHRA_START_ARGV.join(" ")}\`.`,
		showStart: true,
	};
}

export interface TephraStatusBarDeps {
	/** Adds one item to Obsidian's status bar (`Plugin.addStatusBarItem`). */
	addItem: () => HTMLElement;
	/** Opens Atlas settings on the Tephra tab. */
	openSettings: () => void;
	/** Dan clicked Start. The only way `tephractl` is ever run (F7). */
	start: () => void;
}

/**
 * G13: the status-bar item. It exists only while attached to a live connection whose state isn't `off`: with the
 * toggle off there is no connection, so there is no item. `attach()` replaces whatever it was attached to, and
 * `hide()` (the toggle going off, unload) removes the item and every subscription at once. The item is created at
 * most once per attach, so a connection that flaps between online and offline updates one item and never makes
 * a second.
 */
export class TephraStatusBar {
	private item: HTMLElement | null = null;
	private label: TephraStatusLabel | null = null;
	private tooltipEl: HTMLElement | null = null;
	private connection: Pick<TephraConnection, "getSnapshot"> | null = null;
	private starter: Pick<TephraStarter, "isStarting"> | null = null;
	private unsubscribers: Array<() => void> = [];

	constructor(private readonly deps: TephraStatusBarDeps) {}

	/** Follows `connection` (and the starter) from now on, drawing at once. Any earlier attachment is dropped. */
	attach(connection: Pick<TephraConnection, "getSnapshot" | "onChange">, starter: Pick<TephraStarter, "isStarting" | "onChange">): void {
		this.unsubscribe();
		this.connection = connection;
		this.starter = starter;
		this.unsubscribers = [connection.onChange(() => this.render()), starter.onChange(() => this.render())];
		this.render();
	}

	/** Removes the item and stops following the connection. Safe to call when nothing is attached. */
	hide(): void {
		this.unsubscribe();
		this.connection = null;
		this.starter = null;
		this.removeItem();
	}

	/** The item on screen, or null (for tests). */
	getItem(): HTMLElement | null {
		return this.item;
	}

	private unsubscribe(): void {
		for (const off of this.unsubscribers) off();
		this.unsubscribers = [];
	}

	private render(): void {
		if (!this.connection || !this.starter) return;
		const label = tephraStatusLabel(this.connection.getSnapshot(), this.starter.isStarting());
		if (!label) {
			this.removeItem();
			return;
		}
		const item = this.item ?? this.createItem();
		const previous = this.label;
		this.label = label;
		if (!previous || previous.text !== label.text || previous.showStart !== label.showStart) this.fill(item, label);
		item.dataset.state = label.kind;
		if (this.tooltipEl) this.tooltipEl.textContent = label.tooltip; // shown while hovered: keep it current
	}

	private createItem(): HTMLElement {
		const item = this.deps.addItem();
		item.classList.add("atlas-tephra-status");
		item.tabIndex = 0;
		item.setAttribute("role", "button");
		item.addEventListener("click", (event) => {
			const onStart = (event.target as Element | null)?.closest?.(".atlas-tephra-start") != null;
			if (onStart && this.label?.showStart) this.deps.start();
			else this.deps.openSettings();
		});
		item.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			if ((event.target as Element | null)?.closest?.(".atlas-tephra-start") != null && this.label?.showStart) this.deps.start();
			else this.deps.openSettings();
		});
		item.addEventListener("mouseenter", () => this.showTooltip());
		item.addEventListener("mouseleave", () => this.hideTooltip());
		item.addEventListener("focusin", () => this.showTooltip());
		item.addEventListener("focusout", () => this.hideTooltip());
		this.item = item;
		return item;
	}

	private fill(item: HTMLElement, label: TephraStatusLabel): void {
		item.textContent = "";
		if (!label.showStart) {
			item.textContent = label.text;
			return;
		}
		const name = document.createElement("span");
		name.className = "atlas-tephra-status-text";
		name.textContent = "Tephra offline";
		const start = document.createElement("span");
		start.className = "atlas-tephra-start";
		start.tabIndex = 0;
		start.setAttribute("role", "button");
		start.textContent = "Start";
		item.append(name, " · ", start);
	}

	private removeItem(): void {
		this.hideTooltip();
		this.item?.remove();
		this.item = null;
		this.label = null;
	}

	/** An Atlas-owned element, not `aria-label` or Obsidian's tooltip: Obsidian closes its own tooltip when one
	 * of its popovers opens. Fixed above the item, removed on leave, blur, `hide()` and when the item goes. */
	private showTooltip(): void {
		if (!this.item || !this.label) return;
		if (!this.tooltipEl) {
			const el = document.createElement("div");
			el.className = "atlas-tephra-tooltip";
			el.setAttribute("role", "tooltip");
			document.body.appendChild(el);
			this.tooltipEl = el;
		}
		this.tooltipEl.textContent = this.label.tooltip;
		const rect = this.item.getBoundingClientRect();
		this.tooltipEl.style.left = `${Math.max(0, Math.round(rect.left))}px`;
		this.tooltipEl.style.bottom = `${Math.max(0, Math.round(window.innerHeight - rect.top + 6))}px`;
	}

	private hideTooltip(): void {
		this.tooltipEl?.remove();
		this.tooltipEl = null;
	}
}
