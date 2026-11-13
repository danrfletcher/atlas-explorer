import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice, Plugin, editorLivePreviewField } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SourceLinkController } from "../../src/source-link-controller";
import {
	SourceLinkWidget,
	buildDecorations,
	sourceLinkLivePreviewPlugin,
	buildSourceLinkAnchor,
	registerSourceLinkFallbackPostProcessor,
	renderSourceLinksInReadingView,
} from "../../src/source-link-fallback";
import { plainNameClashes } from "../../src/source-links";
import { seedPaths, sourcesVaultPaths } from "../sources-vault";

/** The Q13 fallback: reading-view post-processor and live-preview widget, in jsdom, against a real
 * `SourceLinkController` in fallback mode. */

let app: App;
let controller: SourceLinkController;
let host: { app: App; sourceLinks: SourceLinkController };
let open: ReturnType<typeof vi.fn>;
let trigger: ReturnType<typeof vi.fn>;
const settings = { tephraMode: true, tephraLinkFallback: true };

beforeEach(() => {
	Notice.reset();
	settings.tephraMode = true;
	app = new App();
	seedPaths(app, sourcesVaultPaths());
	open = vi.fn(async () => {});
	trigger = vi.fn();
	Object.assign(app.workspace, { openLinkText: open, trigger });
	controller = new SourceLinkController(app, () => settings, undefined, vi.fn());
	controller.sync();
	host = { app, sourceLinks: controller };
});

/** What Obsidian renders for `[[@whoop:Workout Plan]]` in reading view before post-processors run. */
function rendered(href: string, text = href): HTMLElement {
	const root = document.createElement("div");
	const a = document.createElement("a");
	a.className = "internal-link";
	a.setAttribute("data-href", href);
	a.setAttribute("href", href);
	a.textContent = text;
	root.appendChild(a);
	return root;
}

describe("reading view post-processor", () => {
	it("replaces a resolvable @ link with an anchor whose data-href is the real path", () => {
		const root = rendered("@whoop:Workout Plan");
		renderSourceLinksInReadingView(host, root, "Weekly Review.md");
		const a = root.querySelector("a")!;
		expect(a.classList.contains("atlas-source-link")).toBe(true);
		expect(a.classList.contains("is-unresolved")).toBe(false);
		expect(a.getAttribute("data-href")).toBe("Sources/whoop/Workout Plan.md");
		expect(a.textContent).toBe("@whoop:Workout Plan");
	});

	it("keeps the heading and ^id subpath and the alias text", () => {
		const root = rendered("@whoop:Workout Plan#^plan1", "the plan");
		renderSourceLinksInReadingView(host, root, "Weekly Review.md");
		const a = root.querySelector("a")!;
		expect(a.getAttribute("data-href")).toBe("Sources/whoop/Workout Plan.md#^plan1");
		expect(a.textContent).toBe("the plan");
	});

	it("handles a URL-encoded href and non-markdown targets", () => {
		const root = rendered("@whoop:Workout%20Plan");
		renderSourceLinksInReadingView(host, root, "Weekly Review.md");
		expect(root.querySelector("a")!.getAttribute("data-href")).toBe("Sources/whoop/Workout Plan.md");
		const other = rendered("@tephra:crates/tephrad/src/registry.rs");
		renderSourceLinksInReadingView(host, other, "Weekly Review.md");
		expect(other.querySelector("a")!.getAttribute("data-href")).toBe("Sources/tephra/crates/tephrad/src/registry.rs");
	});

	it("click opens the target via openLinkText; ctrl/meta opens a new leaf", () => {
		const root = rendered("@whoop:Workout Plan#Week 1");
		renderSourceLinksInReadingView(host, root, "Weekly Review.md");
		const a = root.querySelector("a")!;
		a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(open).toHaveBeenLastCalledWith("Sources/whoop/Workout Plan.md#Week 1", "Weekly Review.md", false);
		a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		expect(open).toHaveBeenLastCalledWith("Sources/whoop/Workout Plan.md#Week 1", "Weekly Review.md", true);
	});

	it("hover triggers `hover-link` with the real target", () => {
		const root = rendered("@whoop:Workout Plan");
		renderSourceLinksInReadingView(host, root, "Weekly Review.md");
		const a = root.querySelector("a")!;
		a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		expect(trigger).toHaveBeenCalledTimes(1);
		const [name, payload] = trigger.mock.calls[0];
		expect(name).toBe("hover-link");
		expect(payload).toMatchObject({ source: "preview", linktext: "Sources/whoop/Workout Plan.md", sourcePath: "Weekly Review.md", targetEl: a, hoverParent: a });
	});

	it("a broken link renders unresolved, shows the notice on click, opens nothing and has no hover", () => {
		const root = rendered("@whoop:Nope");
		renderSourceLinksInReadingView(host, root, "Weekly Review.md");
		const a = root.querySelector("a")!;
		expect(a.classList.contains("is-unresolved")).toBe(true);
		a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		expect(Notice.instances.map((n) => n.message)).toEqual(["No file Nope in whoop"]);
		expect(open).not.toHaveBeenCalled();
		expect(trigger).not.toHaveBeenCalled();
		expect(app.vault.calls).not.toContain("create");
	});

	it("leaves plain links, [[@home]] and non-link anchors untouched", () => {
		for (const href of ["Leg Day", "@home", "https://example.com"]) {
			const root = rendered(href);
			const before = root.innerHTML;
			renderSourceLinksInReadingView(host, root, "Weekly Review.md");
			expect(root.innerHTML, href).toBe(before);
		}
	});

	it("does nothing at all when tephraMode is off or the hook is active", () => {
		settings.tephraMode = false;
		controller.sync();
		const off = rendered("@whoop:Workout Plan");
		const offBefore = off.innerHTML;
		renderSourceLinksInReadingView(host, off, "Weekly Review.md");
		expect(off.innerHTML).toBe(offBefore);
		settings.tephraMode = true;
		settings.tephraLinkFallback = false;
		controller.sync();
		expect(controller.getMode()).toBe("hook");
		const hooked = rendered("@whoop:Workout Plan");
		const hookedBefore = hooked.innerHTML;
		renderSourceLinksInReadingView(host, hooked, "Weekly Review.md");
		expect(hooked.innerHTML).toBe(hookedBefore);
		settings.tephraLinkFallback = true;
		controller.dispose();
	});

	it("registers one markdown post-processor that renders through the same path", () => {
		let processor: ((el: HTMLElement, ctx: { sourcePath: string }) => void) | undefined;
		const plugin = { app, sourceLinks: controller, registerMarkdownPostProcessor: (fn: typeof processor) => void (processor = fn) } as unknown as Plugin & typeof host;
		registerSourceLinkFallbackPostProcessor(plugin);
		const root = rendered("@whoop:Leg Day");
		processor!(root, { sourcePath: "Weekly Review.md" });
		expect(root.querySelector("a")!.getAttribute("data-href")).toBe("Sources/whoop/Leg Day.md");
	});
});

describe("live preview widget", () => {
	it("renders an anchor-like span with the right data-href and handles click and hover", () => {
		const widget = new SourceLinkWidget(host, "@whoop:Workout Plan#^plan1", "the plan", "Weekly Review.md");
		const el = widget.toDOM();
		expect(el.tagName).toBe("SPAN");
		expect(el.classList.contains("cm-hmd-internal-link")).toBe(true);
		expect(el.getAttribute("data-href")).toBe("Sources/whoop/Workout Plan.md#^plan1");
		expect(el.textContent).toBe("the plan");
		el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		expect(trigger.mock.calls[0][0]).toBe("hover-link");
		el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(open).toHaveBeenCalledWith("Sources/whoop/Workout Plan.md#^plan1", "Weekly Review.md", false);
		expect(widget.ignoreEvent()).toBe(true);
	});

	it("a broken link in live preview is unresolved and click shows the notice", () => {
		const el = new SourceLinkWidget(host, "@nosuch:x", "@nosuch:x", "Weekly Review.md").toDOM();
		expect(el.classList.contains("is-unresolved")).toBe(true);
		el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(Notice.instances.map((n) => n.message)).toEqual(["No file x in nosuch"]);
		expect(open).not.toHaveBeenCalled();
	});

	it("eq() compares what the widget renders", () => {
		const a = new SourceLinkWidget(host, "@whoop:x", "t", "a.md");
		expect(a.eq(new SourceLinkWidget(host, "@whoop:x", "t", "a.md"))).toBe(true);
		expect(a.eq(new SourceLinkWidget(host, "@whoop:y", "t", "a.md"))).toBe(false);
		expect(a.eq(new SourceLinkWidget(host, "@whoop:x", "u", "a.md"))).toBe(false);
	});

	it("buildSourceLinkAnchor never writes into the vault", () => {
		buildSourceLinkAnchor(host, "@whoop:Workout Plan", "Weekly Review.md", "x").click();
		expect(app.vault.calls).toEqual([]);
	});
});

describe("live preview decorations (real EditorView)", () => {
	const livePreviewExt = (on: boolean) => (on ? editorLivePreviewField : editorLivePreviewField.init(() => false));

	/** Doc with the cursor parked on the last line, away from every link. */
	function viewFor(lines: string[], livePreview = true): EditorView {
		const doc = [...lines, "cursor parks here"].join("\n");
		return new EditorView({
			state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [livePreviewExt(livePreview)] }),
			parent: document.createElement("div"),
		});
	}

	/** The `[from, to)` ranges and the widget links that `buildDecorations` decorates. */
	function decorated(view: EditorView): { text: string; linktext: string }[] {
		const out: { text: string; linktext: string }[] = [];
		const set = buildDecorations(host, view);
		set.between(0, view.state.doc.length, (from, to, deco) => {
			const widget = (deco.spec as { widget: SourceLinkWidget }).widget;
			out.push({ text: view.state.sliceDoc(from, to), linktext: (widget as unknown as { linktext: string }).linktext });
		});
		return out;
	}

	beforeEach(() => {
		Object.assign(app.workspace, { getActiveFile: () => ({ path: "Weekly Review.md" }) });
	});

	it("decorates [[@source:path]] links, with and without alias or subpath", () => {
		const view = viewFor(["a [[@whoop:Workout Plan]] b [[@whoop:Workout Plan#^plan1|the plan]] c"]);
		expect(decorated(view)).toEqual([
			{ text: "[[@whoop:Workout Plan]]", linktext: "@whoop:Workout Plan" },
			{ text: "[[@whoop:Workout Plan#^plan1|the plan]]", linktext: "@whoop:Workout Plan#^plan1" },
		]);
	});

	it("F9: leaves [[@home]], [[@home#a:b]], [[@home|x:y]] and plain links to Obsidian, even with @home.md missing", () => {
		expect(app.vault.getAbstractFileByPath("@home.md")).toBeNull();
		const view = viewFor(["[[@home]] [[@home#a:b]] [[@home|x:y]] [[Leg Day]] [t](@whoop:x.md) [[@whoop:Workout Plan]]"]);
		expect(decorated(view)).toEqual([{ text: "[[@whoop:Workout Plan]]", linktext: "@whoop:Workout Plan" }]);
	});

	it("skips embeds, and a link under the cursor stays raw", () => {
		const doc = "![[@whoop:Workout Plan]]\n[[@whoop:Leg Day]]";
		const view = new EditorView({
			state: EditorState.create({ doc, selection: { anchor: doc.length - 3 }, extensions: [livePreviewExt(true)] }),
			parent: document.createElement("div"),
		});
		expect(decorated(view)).toEqual([]);
	});

	it("rebuilds when the mode changes at runtime, with no edit, scroll or selection change", () => {
		const plugin = sourceLinkLivePreviewPlugin(host);
		const doc = "[[@whoop:Workout Plan]]\ncursor parks here";
		const view = new EditorView({
			state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [livePreviewExt(true), plugin] }),
			parent: document.createElement("div"),
		});
		const size = () => view.plugin(plugin)!.decorations.size;
		expect(size()).toBe(1);
		settings.tephraMode = false;
		controller.sync(); // what turning Tephra mode off does; the controller then calls `workspace.updateOptions()`
		view.dispatch({}); // a bare transaction, as a reconfigure is: no doc, viewport or selection change
		expect(size()).toBe(0);
		settings.tephraMode = true;
		controller.sync();
		view.dispatch({});
		expect(size()).toBe(1);
	});

	it("decorates nothing in source mode or when the fallback is not active", () => {
		const links = ["[[@whoop:Workout Plan]]"];
		expect(decorated(viewFor(links, false))).toEqual([]);
		settings.tephraMode = false;
		controller.sync();
		expect(decorated(viewFor(links))).toEqual([]);
	});
});

describe("the plainNameClashes export for PR-7", () => {
	it("is re-exported from the fallback module", async () => {
		const mod = await import("../../src/source-link-fallback");
		expect(mod.plainNameClashes).toBe(plainNameClashes);
	});
});
