import { App, Plugin, TFile, editorLivePreviewField } from "obsidian";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { SourceLinkController } from "./source-link-controller";
import { isSourceLinkSyntax } from "./source-links";

/** Q13: PR-7's `[[` popup imports this to insert full vault paths when plain names clash. */
export { plainNameClashes } from "./source-links";

/**
 * Q13 fallback — only runs when `SourceLinkController` is in "fallback" mode (the G9 hook could not
 * be installed, or was forced off for the spike). Atlas renders `[[@source:path]]` itself as a
 * clickable internal-style link with hover preview, in reading view and live preview. `![[@…]]`
 * embeds are NOT rendered: that is the agreed gap (Q13 = A), not something to work around here.
 * With `tephraEnabled` off, or with the hook active, every function here returns without touching the DOM.
 */

interface FallbackHost {
	app: App;
	sourceLinks: SourceLinkController;
}

function splitSubpath(linktext: string): { path: string; subpath: string } {
	const hash = linktext.indexOf("#");
	return hash === -1 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, hash), subpath: linktext.slice(hash) };
}

/** Builds the anchor for one `@source:` link; shared by the reading-view and live-preview paths. */
export function buildSourceLinkAnchor(host: FallbackHost, linktext: string, sourcePath: string, text: string, tag: "a" | "span" = "a"): HTMLElement {
	const { path, subpath } = splitSubpath(linktext);
	const file: TFile | null = host.sourceLinks.resolveFile(path, sourcePath);
	const target = file ? file.path + subpath : linktext;
	const el = document.createElement(tag);
	el.classList.add("atlas-source-link");
	if (!file) el.classList.add("is-unresolved");
	el.setAttribute("data-href", target);
	if (tag === "a") el.setAttribute("href", target);
	el.textContent = text;
	el.addEventListener("click", (evt: MouseEvent) => {
		evt.preventDefault();
		evt.stopPropagation();
		if (!file) {
			host.sourceLinks.noticeIfBroken(path);
			return;
		}
		void host.app.workspace.openLinkText(target, sourcePath, evt.ctrlKey || evt.metaKey);
	});
	if (file) {
		el.addEventListener("mouseover", (evt: MouseEvent) => {
			host.app.workspace.trigger("hover-link", {
				event: evt,
				source: "preview",
				hoverParent: el,
				targetEl: el,
				linktext: target,
				sourcePath,
			});
		});
	}
	return el;
}

/**
 * Reading view: swaps each rendered `@source:` internal link for an Atlas anchor. The original
 * anchor is replaced rather than edited, because Obsidian's own click handler is attached to it and
 * would otherwise try to create a note called `@whoop:…`.
 */
export function renderSourceLinksInReadingView(host: FallbackHost, root: HTMLElement, sourcePath: string): void {
	if (!host.sourceLinks.isFallbackActive()) return;
	root.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
		const raw = a.getAttribute("data-href") ?? a.getAttribute("href");
		if (!raw) return;
		let linktext = raw;
		try {
			linktext = decodeURIComponent(raw);
		} catch {
			// Malformed escape sequence — use the raw attribute.
		}
		if (!isSourceLinkSyntax(linktext)) return;
		a.replaceWith(buildSourceLinkAnchor(host, linktext, sourcePath, a.textContent ?? linktext));
	});
}

/** Register next to `registerBlockLinkDisplayPostProcessor`; a no-op unless fallback mode is active. */
export function registerSourceLinkFallbackPostProcessor(plugin: Plugin & FallbackHost): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => renderSourceLinksInReadingView(plugin, el, ctx.sourcePath));
}

const SOURCE_WIKILINK_RE = /(!?)\[\[(@[^[\]|]+)(?:\|([^\]]*))?\]\]/g;

export class SourceLinkWidget extends WidgetType {
	constructor(private host: FallbackHost, private linktext: string, private text: string, private sourcePath: string) {
		super();
	}

	eq(other: SourceLinkWidget): boolean {
		return other.linktext === this.linktext && other.text === this.text && other.sourcePath === this.sourcePath;
	}

	toDOM(): HTMLElement {
		const el = buildSourceLinkAnchor(this.host, this.linktext, this.sourcePath, this.text, "span");
		el.classList.add("cm-hmd-internal-link");
		return el;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Exported for tests; the view plugin below is the only production caller. */
export function buildDecorations(host: FallbackHost, view: EditorView): DecorationSet {
	if (!host.sourceLinks.isFallbackActive()) return Decoration.none;
	if (!view.state.field(editorLivePreviewField)) return Decoration.none; // source mode shows raw text
	const sourcePath = host.app.workspace.getActiveFile()?.path ?? "";
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc;
	const { from: selFrom, to: selTo } = view.state.selection.main;
	for (const { from, to } of view.visibleRanges) {
		let pos = from;
		while (pos <= to) {
			const line = doc.lineAt(pos);
			SOURCE_WIKILINK_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = SOURCE_WIKILINK_RE.exec(line.text)) !== null) {
				if (m[1] === "!") continue; // embeds don't render in the fallback (agreed gap)
				// F9: only `@source:path` is Atlas syntax; `[[@home]]` and friends stay with Obsidian.
				if (!isSourceLinkSyntax(m[2])) continue;
				const start = line.from + m.index;
				const end = start + m[0].length;
				if (selFrom <= end && selTo >= start) continue; // cursor in the link: leave the raw text editable
				builder.add(start, end, Decoration.replace({ widget: new SourceLinkWidget(host, m[2], m[3] ?? m[2], sourcePath) }));
			}
			if (line.to + 1 <= pos) break;
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

/** Register next to `freeBlockLivePreviewPlugin`; decorations are empty unless fallback mode is active. */
export function sourceLinkLivePreviewPlugin(host: FallbackHost) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			/** Whether the fallback was active when `decorations` was built: a runtime mode change (the
			 * controller calls `workspace.updateOptions()`) reaches `update` as a bare reconfigure. */
			private wasActive: boolean;
			constructor(view: EditorView) {
				this.wasActive = host.sourceLinks.isFallbackActive();
				this.decorations = buildDecorations(host, view);
			}
			update(u: ViewUpdate) {
				const active = host.sourceLinks.isFallbackActive();
				if (u.docChanged || u.viewportChanged || u.selectionSet || active !== this.wasActive) {
					this.wasActive = active;
					this.decorations = buildDecorations(host, u.view);
				}
			}
		},
		{ decorations: (v) => v.decorations }
	);
}
