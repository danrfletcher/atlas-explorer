import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, MetadataCache } from "obsidian";
import type { Plugin } from "obsidian";
import { SourceLinkController } from "../../src/source-link-controller";
import { HIDDEN_ATTR, HOVER_BOX_ID, hideSourceLinkHover, registerBrokenSourceLinkHover } from "../../src/source-link-hover";
import { obsidianFirstLinkpathDest, seedPaths, sourcesVaultPaths } from "../sources-vault";

/**
 * E3: the hover over a broken `@source:` link carries the reason ("2 matches in whoop:" + the paths) in an
 * Atlas-owned box, and Obsidian's own hover popover is hidden while it is up. Real DOM, real events and a
 * real MutationObserver; nothing of Obsidian's tooltip API is involved. (Whether the box is visible in a
 * real Obsidian is checked live, not here.)
 */

const TIE = ["Sources/whoop/a/Plan.md", "Sources/whoop/b/Plan.md"];

let removers: Array<() => void> = [];
let unloadCallbacks: Array<() => void> = [];
let enabled = true;
let controller: SourceLinkController;

function setup(extra: string[] = []): void {
	const app = new App();
	seedPaths(app, [...sourcesVaultPaths(), ...extra]);
	app.metadataCache.getFirstLinkpathDest = obsidianFirstLinkpathDest(app) as MetadataCache["getFirstLinkpathDest"];
	controller = new SourceLinkController(app, () => ({ tephraEnabled: enabled, tephraLinkFallback: false }), () => {}, vi.fn());
	controller.sync();
	const plugin = {
		sourceLinks: controller,
		registerDomEvent: (el: EventTarget, type: string, cb: (evt: Event) => void, opts?: boolean | AddEventListenerOptions) => {
			el.addEventListener(type, cb, opts);
			removers.push(() => el.removeEventListener(type, cb, opts));
		},
		register: (cb: () => void) => {
			unloadCallbacks.push(cb);
		},
	};
	registerBrokenSourceLinkHover(plugin as unknown as Plugin & { sourceLinks: SourceLinkController });
}

/** A reading-view internal link, as Obsidian renders one. */
function link(href: string, cls: string, text = href): HTMLAnchorElement {
	const a = document.createElement("a");
	a.className = `internal-link ${cls}`.trim();
	a.setAttribute("data-href", href);
	a.setAttribute("href", href);
	a.textContent = text;
	document.body.appendChild(a);
	return a;
}

/** A live-preview link: a span wrapping an anchor. */
function wrappedLink(text: string): { span: HTMLElement; inner: HTMLElement } {
	const span = document.createElement("span");
	span.className = "cm-hmd-internal-link is-unresolved";
	const inner = document.createElement("a");
	inner.className = "cm-underline";
	inner.textContent = text;
	span.appendChild(inner);
	document.body.appendChild(span);
	return { span, inner };
}

/** Obsidian's own hover popover, appended to `<body>`. */
function popover(text = "Nowhere is not created yet. Click to create."): HTMLElement {
	const p = document.createElement("div");
	p.className = "popover hover-popover";
	p.textContent = text;
	document.body.appendChild(p);
	return p;
}

const hover = (el: Element) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
const out = (el: Element, to: Element | null) => el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
const hoverFrom = (el: Element, from: Element | null) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: from }));
const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
const box = () => document.getElementById(HOVER_BOX_ID);
/** MutationObserver callbacks run as microtasks; a macrotask turn lets them all run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const isHidden = (el: Element) => (el as HTMLElement).style.display === "none" && el.hasAttribute(HIDDEN_ATTR);

beforeEach(() => {
	enabled = true;
});
afterEach(() => {
	hideSourceLinkHover();
	for (const remove of removers) remove();
	removers = [];
	unloadCallbacks = [];
	document.body.innerHTML = "";
});

describe("the hover box on a broken source link (E3)", () => {
	it("an ambiguous link shows '2 matches in whoop:' then one path per line", () => {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		hover(a);
		const b = box();
		expect(b).not.toBeNull();
		expect(b?.parentElement).toBe(document.body);
		expect(b?.textContent?.split("\n")[0]).toBe("2 matches in whoop:");
		expect(b?.textContent?.split("\n").slice(1).sort()).toEqual(TIE.slice().sort());
		expect(document.querySelectorAll("div.atlas-source-link-hover")).toHaveLength(1);
	});

	it("a link to a missing file shows 'No file Nope in whoop'", () => {
		setup();
		hover(link("@whoop:Nope", "is-unresolved"));
		expect(box()?.textContent).toBe("No file Nope in whoop");
	});

	it("is set with textContent (no markup is parsed) and carries no tooltip or popover class", () => {
		setup();
		hover(link("@whoop:<b>x</b>", "is-unresolved"));
		const b = box();
		expect(b).not.toBeNull();
		expect(b?.children).toHaveLength(0);
		expect(b?.classList.contains("tooltip")).toBe(false);
		expect(b?.classList.contains("popover")).toBe(false);
		expect(b?.className).toBe("atlas-source-link-hover");
		expect(b?.style.position).toBe("fixed");
	});

	it("points the link at the box with aria-describedby and never sets aria-label", () => {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		hover(a);
		expect(a.getAttribute("aria-describedby")).toBe(HOVER_BOX_ID);
		expect(a.hasAttribute("aria-label")).toBe(false);
		out(a, document.body);
		expect(a.hasAttribute("aria-describedby")).toBe(false);
	});

	it("restores an aria-describedby the link already had", () => {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		a.setAttribute("aria-describedby", "other");
		hover(a);
		expect(a.getAttribute("aria-describedby")).toBe(HOVER_BOX_ID);
		escape();
		expect(a.getAttribute("aria-describedby")).toBe("other");
	});

	it("hovering a child of a live-preview link shows the box for the unresolved element, once", () => {
		setup(TIE);
		const { span, inner } = wrappedLink("@whoop:Plan");
		hoverFrom(span, null);
		const first = box();
		expect(first?.textContent).toContain("2 matches in whoop:");
		hoverFrom(inner, span);
		hoverFrom(span, inner);
		hover(inner);
		expect(box()).toBe(first);
		expect(document.querySelectorAll("div.atlas-source-link-hover")).toHaveLength(1);
		expect(span.getAttribute("aria-describedby")).toBe(HOVER_BOX_ID);
	});

	it("places the box below the link, flips it above at the bottom edge and clamps it to the viewport", () => {
		setup(TIE);
		const sizes = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
		const heights = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
		window.innerWidth = 1000;
		window.innerHeight = 800;
		try {
			const a = link("@whoop:Plan", "is-unresolved");
			const rectOf = (left: number, top: number) =>
				vi.spyOn(a, "getBoundingClientRect").mockReturnValue({ left, top, right: left + 50, bottom: top + 20, width: 50, height: 20, x: left, y: top, toJSON: () => ({}) });

			rectOf(100, 100);
			hover(a);
			expect(box()?.style.top).toBe("124px");
			expect(box()?.style.left).toBe("100px");
			hideSourceLinkHover();

			rectOf(950, 780); // no room below, and the box would overflow the right edge
			hover(a);
			expect(box()?.style.top).toBe("716px"); // 780 - 4 - 60
			expect(box()?.style.left).toBe("796px"); // 1000 - 200 - 4
		} finally {
			sizes.mockRestore();
			heights.mockRestore();
		}
	});

	it("a resolved link, a plain unresolved link, a resolved-but-marked link and the toggle-off state show nothing", () => {
		setup(TIE);
		hover(link("@whoop:Workout Plan", ""));
		hover(link("@whoop:Workout Plan", "is-unresolved"));
		hover(link("Nowhere", "is-unresolved"));
		expect(box()).toBeNull();
		for (const r of removers) r();
		removers = [];
		document.body.innerHTML = "";
		enabled = false;
		setup(TIE);
		hover(link("@whoop:Plan", "is-unresolved"));
		expect(box()).toBeNull();
	});
});

describe("the box is removed on every exit path", () => {
	function shown(): HTMLAnchorElement {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		hover(a);
		expect(box()).not.toBeNull();
		return a;
	}

	it("mouseout that leaves the link", () => {
		const a = shown();
		out(a, document.body);
		expect(box()).toBeNull();
	});

	it("mouseout into a child of the link keeps it", () => {
		setup(TIE);
		const { span, inner } = wrappedLink("@whoop:Plan");
		hover(span);
		out(span, inner);
		expect(box()).not.toBeNull();
		out(inner, span);
		expect(box()).not.toBeNull();
		out(inner, document.body);
		expect(box()).toBeNull();
	});

	it("scroll", () => {
		shown();
		document.dispatchEvent(new Event("scroll"));
		expect(box()).toBeNull();
	});

	it("Escape", () => {
		shown();
		escape();
		expect(box()).toBeNull();
	});

	it("the link being detached, seen by the observer with no further pointer event", async () => {
		const a = shown();
		a.remove();
		document.body.appendChild(document.createElement("p")); // any body change wakes the observer
		await flush();
		expect(box()).toBeNull();
	});

	it("the link being detached, seen on the next mouseout anywhere", () => {
		const a = shown();
		const other = document.createElement("p");
		document.body.appendChild(other);
		a.remove();
		out(other, null);
		expect(box()).toBeNull();
	});

	it("the next mouseover outside the link, including after the link was replaced", () => {
		const a = shown();
		const fresh = link("@whoop:Plan", "is-unresolved");
		a.replaceWith(fresh);
		const plain = document.createElement("p");
		document.body.appendChild(plain);
		hover(plain);
		expect(box()).toBeNull();
	});

	it("moving straight onto another link replaces the box with that link's", () => {
		const a = shown();
		const nope = link("@whoop:Nope", "is-unresolved");
		hoverFrom(nope, a);
		expect(document.querySelectorAll("div.atlas-source-link-hover")).toHaveLength(1);
		expect(box()?.textContent).toBe("No file Nope in whoop");
		expect(a.hasAttribute("aria-describedby")).toBe(false);
	});

	it("plugin unload", () => {
		shown();
		expect(unloadCallbacks).toHaveLength(1);
		unloadCallbacks[0]();
		expect(box()).toBeNull();
	});

	it("leaving and coming back shows the box again", () => {
		const a = shown();
		out(a, document.body);
		hoverFrom(a, document.body);
		expect(box()).not.toBeNull();
	});
});

describe("Obsidian's hover popover while the box is up", () => {
	it("a .hover-popover appended during the hover is hidden, and the box is not removed by it", async () => {
		setup(TIE);
		hover(link("@whoop:Plan", "is-unresolved"));
		const p = popover();
		await flush();
		expect(isHidden(p)).toBe(true);
		expect(box()).not.toBeNull();
	});

	it("touches only a .popover.hover-popover: other nodes added meanwhile are left alone", async () => {
		setup(TIE);
		hover(link("@whoop:Plan", "is-unresolved"));
		const menu = document.createElement("div");
		menu.className = "menu";
		const bare = document.createElement("div");
		bare.className = "hover-popover";
		const justPopover = document.createElement("div");
		justPopover.className = "popover";
		document.body.append(menu, bare, justPopover);
		await flush();
		for (const el of [menu, bare, justPopover]) {
			expect((el as HTMLElement).style.display).toBe("");
			expect(el.hasAttribute(HIDDEN_ATTR)).toBe(false);
		}
	});

	it("every popover added during the same hover is hidden", async () => {
		setup(TIE);
		hover(link("@whoop:Plan", "is-unresolved"));
		const first = popover();
		const second = popover();
		await flush();
		expect(isHidden(first) && isHidden(second)).toBe(true);
	});

	it("a popover that was already open before the hover is untouched", async () => {
		setup(TIE);
		const before = popover();
		hover(link("@whoop:Plan", "is-unresolved"));
		popover(); // wakes the observer
		await flush();
		expect(before.style.display).toBe("");
		expect(before.hasAttribute(HIDDEN_ATTR)).toBe(false);
	});

	it("a popover appended after the hover ended is untouched, and the observer is disconnected", async () => {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
		try {
			hover(a);
			out(a, document.body);
			expect(disconnect).toHaveBeenCalledTimes(1);
		} finally {
			disconnect.mockRestore();
		}
		const late = popover();
		await flush();
		expect(late.style.display).toBe("");
		expect(late.hasAttribute(HIDDEN_ATTR)).toBe(false);
	});

	it("a popover already hidden stays hidden after the box goes", async () => {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		hover(a);
		const p = popover();
		await flush();
		out(a, document.body);
		expect(box()).toBeNull();
		expect(isHidden(p)).toBe(true);
	});

	it("a popover appended and then the hover ended before the observer ran is still hidden", async () => {
		setup(TIE);
		const a = link("@whoop:Plan", "is-unresolved");
		hover(a);
		const p = popover();
		out(a, document.body); // same synchronous turn: the observer callback has not run yet
		await flush();
		expect(box()).toBeNull();
		expect(isHidden(p)).toBe(true);
	});

	it("a popover during a hover of [[Nowhere]], of a resolved @ link or with the toggle off is untouched", async () => {
		setup(TIE);
		for (const a of [link("Nowhere", "is-unresolved"), link("@whoop:Workout Plan", ""), link("@whoop:Workout Plan", "is-unresolved")]) {
			hover(a);
			const p = popover();
			await flush();
			expect(p.style.display).toBe("");
			expect(p.hasAttribute(HIDDEN_ATTR)).toBe(false);
			out(a, document.body);
		}
		for (const r of removers) r();
		removers = [];
		enabled = false;
		setup(TIE);
		hover(link("@whoop:Plan", "is-unresolved"));
		const p = popover();
		await flush();
		expect(p.style.display).toBe("");
	});

	it("no global rule or body class is involved: the body class list is never touched", () => {
		setup(TIE);
		const before = document.body.className;
		hover(link("@whoop:Plan", "is-unresolved"));
		expect(document.body.className).toBe(before);
	});
});
