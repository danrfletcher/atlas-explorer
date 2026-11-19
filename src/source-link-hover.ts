import type { Plugin } from "obsidian";
import { isSourceLinkSyntax } from "./source-links";

/**
 * E3 — hover text for a broken `@source:` link ("2 matches in whoop:" and the tied paths, or "No file
 * Nope in whoop"). Obsidian owns its tooltip singleton and its hover popover and closes the tooltip when
 * the popover opens, so text given to it (`aria-label`, `displayTooltip`) is never visible on an
 * unresolved link. Atlas therefore owns the box: one `div.atlas-source-link-hover` on `document.body`,
 * filled with `textContent`, positioned `fixed` below the link, with no `tooltip`/`popover` class.
 * The link gets `aria-describedby` pointing at it (never `aria-label`, so Obsidian shows no second one).
 *
 * Obsidian's own popover for an unresolved link ("… is not created yet. Click to create.") may still
 * open in the DOM. While the box is up, a `MutationObserver` on `document.body` sets `display: none`
 * (and `data-atlas-hidden`) on each `.popover.hover-popover` added during this hover, and on nothing
 * else, so that text is not seen (G9: Obsidian never offers to create `@whoop:...`). Nothing is
 * patched, stored or written. With `tephraEnabled` off `describeBroken` returns null, so nothing happens.
 * The box and observer are removed on: mouseout that is not into a child of the link, scroll, Escape,
 * the link being detached, the next mouseover outside the link, and plugin unload.
 */

export interface BrokenLinkHost {
	sourceLinks: { describeBroken(linktext: string): string | null };
}

/** The box's id and CSS class; the link's `aria-describedby` points at the id. */
export const HOVER_BOX_ID = "atlas-source-link-hover";
const HOVER_BOX_CLASS = "atlas-source-link-hover";
/** Set on each Obsidian hover popover this module hides. */
export const HIDDEN_ATTR = "data-atlas-hidden";
/** Gap between the link and the box, and the minimum distance from the viewport edge, in px. */
const GAP = 4;

/** The link text of a rendered link: `data-href`, then `href`, then (live preview) its text. */
export function linktextOf(el: Element): string | null {
	const anchor = el.matches("[data-href], [href]") ? el : el.querySelector("[data-href], [href]");
	const raw = anchor?.getAttribute("data-href") ?? anchor?.getAttribute("href") ?? el.textContent?.trim() ?? "";
	if (raw === "") return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

interface ActiveHover {
	link: Element;
	box: HTMLElement;
	observer: MutationObserver;
	/** The link's `aria-describedby` before we set ours (null: it had none), restored on exit. */
	prevDescribedBy: string | null;
}

/** The one hover that is up, if any. One entry into a broken link shows the box once. */
let active: ActiveHover | null = null;

/** Hides each `.popover.hover-popover` among the added nodes; every other node is left alone. */
function hidePopovers(records: MutationRecord[]): void {
	for (const record of records) {
		for (const node of Array.from(record.addedNodes)) {
			if (node instanceof HTMLElement && node.matches(".popover.hover-popover")) {
				node.style.display = "none";
				node.setAttribute(HIDDEN_ATTR, "");
			}
		}
	}
}

/** Removes the box, disconnects the observer and restores the link's `aria-describedby`. Hidden popovers stay hidden. */
export function hideSourceLinkHover(): void {
	if (active === null) return;
	const { link, box, observer, prevDescribedBy } = active;
	active = null;
	// A popover added during the hover whose record has not been delivered yet still counts as during it.
	hidePopovers(observer.takeRecords());
	observer.disconnect();
	box.remove();
	if (link.getAttribute("aria-describedby") === HOVER_BOX_ID) {
		if (prevDescribedBy === null) link.removeAttribute("aria-describedby");
		else link.setAttribute("aria-describedby", prevDescribedBy);
	}
}

/** Places `box` (already in the DOM) `fixed` below `link`, flipped above it when there is no room, clamped to the viewport. */
function position(box: HTMLElement, link: Element): void {
	const rect = link.getBoundingClientRect();
	const w = box.offsetWidth;
	const h = box.offsetHeight;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	let top = rect.bottom + GAP;
	if (top + h > vh - GAP && rect.top - GAP - h >= GAP) top = rect.top - GAP - h;
	top = Math.max(GAP, Math.min(top, vh - h - GAP));
	const left = Math.max(GAP, Math.min(rect.left, vw - w - GAP));
	box.style.top = `${top}px`;
	box.style.left = `${left}px`;
}

function showSourceLinkHover(link: Element, message: string): void {
	hideSourceLinkHover();
	const box = document.createElement("div");
	box.id = HOVER_BOX_ID;
	box.className = HOVER_BOX_CLASS;
	box.setAttribute("role", "tooltip");
	box.textContent = message;
	box.style.position = "fixed";
	document.body.appendChild(box);
	position(box, link);

	const prevDescribedBy = link.getAttribute("aria-describedby");
	link.setAttribute("aria-describedby", HOVER_BOX_ID);

	const observer = new MutationObserver((records) => {
		hidePopovers(records);
		// A hover whose link was re-rendered away under a still pointer has no mouseout.
		if (!link.isConnected) hideSourceLinkHover();
	});
	observer.observe(document.body, { childList: true });
	active = { link, box, observer, prevDescribedBy };
}

/** The mouseover handler; exported so tests can drive it with real DOM events. */
export function onSourceLinkMouseOver(host: BrokenLinkHost, evt: Event): void {
	const target = evt.target;
	if (!(target instanceof Element)) return;
	// A pointer now over anything outside the hovered link (which a detached link never contains) means
	// it left, even if no mouseout reached us.
	if (active !== null && !active.link.contains(target)) hideSourceLinkHover();
	const el = target.closest(".is-unresolved");
	if (!el) return;
	// mouseover also fires when moving between children of the same link: not a new entry.
	if (active !== null && active.link === el) return;
	const linktext = linktextOf(el);
	if (linktext === null || !isSourceLinkSyntax(linktext)) return;
	const message = host.sourceLinks.describeBroken(linktext);
	if (message !== null) showSourceLinkHover(el, message);
}

/** The mouseout handler: the pointer left the link for good (not for one of its children). */
export function onSourceLinkMouseOut(evt: Event): void {
	if (active === null) return;
	if (!active.link.isConnected) {
		hideSourceLinkHover();
		return;
	}
	const to = (evt as MouseEvent).relatedTarget;
	if (to instanceof Node && active.link.contains(to)) return;
	if (evt.target instanceof Node && !active.link.contains(evt.target)) return;
	hideSourceLinkHover();
}

/**
 * Registers the delegated listeners on `document`. The mouseover is in the capture phase so it runs
 * before Obsidian's own handlers. The box goes away on mouseout, scroll, Escape, a detached link, the
 * next mouseover outside the link, and plugin unload.
 */
export function registerBrokenSourceLinkHover(plugin: Plugin & BrokenLinkHost): void {
	plugin.registerDomEvent(document, "mouseover", (evt) => onSourceLinkMouseOver(plugin, evt), true);
	plugin.registerDomEvent(document, "mouseout", (evt) => onSourceLinkMouseOut(evt), true);
	plugin.registerDomEvent(document, "scroll", () => hideSourceLinkHover(), true);
	plugin.registerDomEvent(document, "keydown", (evt) => {
		if (evt.key === "Escape") hideSourceLinkHover();
	}, true);
	plugin.register(() => hideSourceLinkHover());
}
