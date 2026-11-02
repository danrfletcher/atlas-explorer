import { App } from "obsidian";

export function seedRoot(app: App, files: string[], folders: string[] = []): void {
	for (const f of folders) app.vault.seedFolder(f);
	for (const f of files) app.vault.seedFile(f);
}

export const modals = () => Array.from(document.querySelectorAll<HTMLElement>(".modal"));
export const inputEl = () => document.querySelector<HTMLInputElement>(".atlas-name-input")!;
export const messageEl = () => document.querySelector<HTMLElement>(".atlas-name-message")!;
export const button = (label: string) =>
	Array.from(document.querySelectorAll<HTMLButtonElement>(".atlas-name-buttons button")).find((b) => b.textContent === label)!;

export function type(value: string): void {
	const el = inputEl();
	el.value = value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function key(k: string, init: KeyboardEventInit = {}, target: HTMLElement = inputEl()): KeyboardEvent {
	const evt = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(evt);
	return evt;
}

/** Lets a resolved promise's continuation run. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** How many `holdUnit` releases are still outstanding for `path` (0 once every one has run). Reads
 * `UnitIndex`'s private hold map, so the production class carries no test-only accessor. */
export function heldCount(index: object, path: string): number {
	const held = (index as { held?: Map<string, number> }).held;
	if (!(held instanceof Map)) throw new Error("heldCount: UnitIndex no longer has a `held` map");
	return held.get(path) ?? 0;
}
