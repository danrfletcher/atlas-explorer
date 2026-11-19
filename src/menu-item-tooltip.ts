import type { Menu, MenuItem } from "obsidian";

/** The text on a disabled source-menu item while Tephra is offline (G13/E1). */
export const TEPHRA_OFFLINE_TOOLTIP = "Tephra offline";

/**
 * PR-11: hover/focus text for a menu item, as an Atlas-owned element rather than `aria-label`, `setTooltip` or
 * Obsidian's own popover: Obsidian owns those and closes its tooltip when a menu opens. The element carries the
 * `atlas-tephra-tooltip` class (fixed position, above everything), sits in `document.body`, shows on pointer enter
 * and focus, and goes on leave, blur, when the menu hides, and when the item leaves the DOM.
 *
 * Obsidian doesn't type `MenuItem.dom`; it is there at runtime, and a missing one just means no tooltip.
 */
export function attachMenuItemTooltip(menu: Menu, item: MenuItem, text: string): void {
	const dom = (item as unknown as { dom?: HTMLElement }).dom;
	if (!dom) return;
	let tip: HTMLElement | null = null;
	const hide = (): void => {
		tip?.remove();
		tip = null;
	};
	const show = (): void => {
		if (!dom.isConnected) return hide();
		if (!tip) {
			tip = document.createElement("div");
			tip.className = "atlas-tephra-tooltip";
			tip.setAttribute("role", "tooltip");
			document.body.appendChild(tip);
		}
		tip.textContent = text;
		const rect = dom.getBoundingClientRect();
		tip.style.left = `${Math.max(0, Math.round(rect.right + 6))}px`;
		tip.style.top = `${Math.max(0, Math.round(rect.top))}px`;
	};
	dom.addEventListener("mouseenter", show);
	dom.addEventListener("focus", show);
	dom.addEventListener("mouseleave", hide);
	dom.addEventListener("blur", hide);
	(menu as unknown as { onHide?: (callback: () => void) => void }).onHide?.(hide);
}
