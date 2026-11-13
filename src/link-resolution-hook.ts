import { App, Notice, TFile } from "obsidian";
import {
	NOTES_SOURCE,
	SourceFileIndex,
	describeUnresolved,
	isSourceLinkSyntax,
	isUnderSourcesFolder,
	ownSourceOf,
	resolvePlainLinkInOwnSource,
	resolveSourceLink,
} from "./source-links";

/**
 * G9 — teaches Obsidian's link resolution about Tephra sources.
 *
 * What is touched (all through the narrow interfaces below, each inside try/catch, the same pattern
 * as `suggester-precedence.ts`):
 *   1. `app.metadataCache.getFirstLinkpathDest` — an own-property wrapper on the instance. In
 *      Obsidian 1.14.4 `resolveLinks` (which fills `resolvedLinks`/`unresolvedLinks`), the
 *      Backlinks and Outgoing-links panels, hover preview, embeds and the click handler all call
 *      this one method on the instance, so replacing it is what makes `[[@whoop:Plan]]` appear in
 *      `resolvedLinks`, Backlinks and the graph. See docs/decisions.md.
 *   2. `app.workspace.openLinkText` and the leaf-level `WorkspaceLeaf.prototype.openLinkText` —
 *      when an `@source:` link does not resolve, Obsidian would CREATE a note called `@whoop:Nope`.
 *      The wrappers show a notice instead and never call the original for such a link.
 * Uninstalling restores each original exactly (identity). If something else wrapped the same method
 * after us, our wrapper turns into a pass-through instead of clobbering theirs.
 *
 * Nothing here writes file content, makes a network call or adds a file to the vault (F2, F3).
 */

interface MetadataCacheInternals {
	getFirstLinkpathDest?: unknown;
	resolvedLinks?: unknown;
	unresolvedLinks?: unknown;
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

interface PatchHandle {
	/** False once restored: the wrapper then just calls the original. */
	active: boolean;
	restore(): void;
}

/** Replaces `target[key]` with `makeWrapper(original)`; returns a handle that restores it exactly. */
function patchMethod(target: object, key: string, makeWrapper: (original: AnyFn, handle: PatchHandle) => AnyFn): PatchHandle {
	const record = target as Record<string, unknown>;
	const original = record[key];
	if (typeof original !== "function") throw new Error(`${key} is not a function`);
	const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
	const handle: PatchHandle = {
		active: true,
		restore() {
			if (!handle.active) return;
			handle.active = false;
			// Only put things back if our wrapper is still the one in place; if another patch wrapped
			// over it, leave theirs alone — `active = false` already makes ours a pass-through.
			if (record[key] !== wrapper) return;
			if (hadOwn) record[key] = original;
			else delete record[key];
		},
	};
	const wrapper = makeWrapper(original as AnyFn, handle);
	record[key] = wrapper;
	return handle;
}

export type HookInstallResult = "installed" | "already-installed" | "unsupported";

export class LinkResolutionHook {
	private index: SourceFileIndex<TFile>;
	private handles: PatchHandle[] = [];
	private leafPatched = false;
	private warned = false;

	constructor(private app: App, private warn: (message: string, detail?: unknown) => void = (m, d) => console.warn(m, d ?? "")) {
		this.index = new SourceFileIndex<TFile>(() => this.app.vault.getFiles());
	}

	isInstalled(): boolean {
		return this.handles.length > 0 && this.handles[0].active;
	}

	/** Drop the lookup table; it is rebuilt on the next resolve. Call on vault create/delete/rename. */
	invalidate(): void {
		this.index.invalidate();
	}

	/**
	 * Installs the resolver wrapper (and the broken-link guards). Returns "unsupported" and leaves
	 * Obsidian completely untouched — logging once — when the internals are not what we expect.
	 */
	install(): HookInstallResult {
		if (this.isInstalled()) {
			// Installed at plugin load, when no leaf may exist yet: top up the leaf-level guard later.
			if (!this.leafPatched) this.patchLeafOpenLinkText();
			return "already-installed";
		}
		try {
			const cache = this.app.metadataCache as unknown as MetadataCacheInternals;
			if (
				typeof cache.getFirstLinkpathDest !== "function" ||
				typeof cache.resolvedLinks !== "object" ||
				cache.resolvedLinks === null ||
				typeof cache.unresolvedLinks !== "object" ||
				cache.unresolvedLinks === null ||
				typeof this.app.vault.getFiles !== "function"
			) {
				this.warnOnce("[Atlas] Obsidian's link-resolution internals changed; using the fallback link renderer instead.");
				return "unsupported";
			}
			this.index.invalidate();
			this.handles.push(patchMethod(this.app.metadataCache, "getFirstLinkpathDest", (original, handle) => this.makeResolver(original, handle)));
			this.patchOpenLinkText();
			return "installed";
		} catch (err) {
			this.uninstall(); // undo a half-finished install
			this.warnOnce("[Atlas] Could not hook Obsidian's link resolution; using the fallback link renderer instead.", err);
			return "unsupported";
		}
	}

	/** Restores every patched method exactly. Changes no files or settings (E8). */
	uninstall(): void {
		for (const handle of this.handles.reverse()) {
			try {
				handle.restore();
			} catch {
				handle.active = false;
			}
		}
		this.handles = [];
		this.leafPatched = false;
		this.index.invalidate();
	}

	/**
	 * Resolves a link the way the hook does but WITHOUT needing the patch to be installed: used by
	 * the fallback renderer. `original` is what plain vault links delegate to.
	 */
	resolveFile(linktext: string, sourcePath: string, original?: (linkpath: string, sourcePath: string) => TFile | null): TFile | null {
		return this.resolve(linktext, sourcePath, original ?? ((l, s) => this.app.metadataCache.getFirstLinkpathDest(l, s)));
	}

	/** Shows the notice for a broken source link; returns true when `linktext` was one (so callers stop). */
	noticeIfBrokenSourceLink(linktext: unknown): boolean {
		if (!isSourceLinkSyntax(linktext)) return false;
		const hash = linktext.indexOf("#");
		const linkpath = hash === -1 ? linktext : linktext.slice(0, hash);
		const outcome = resolveSourceLink(this.index, linkpath);
		if (outcome.kind === "resolved" && this.live(outcome.file)) return false;
		const message = outcome.kind === "unresolved" ? describeUnresolved(outcome, linkpath) : `No file in ${linkpath}`;
		new Notice(message);
		return true;
	}

	private makeResolver(original: AnyFn, handle: PatchHandle): AnyFn {
		const resolve = this.resolve.bind(this);
		const warnOnce = this.warnOnce.bind(this);
		return function (this: unknown, linkpath: unknown, sourcePath: unknown) {
			if (!handle.active || typeof linkpath !== "string" || typeof sourcePath !== "string") {
				return original.call(this, linkpath, sourcePath);
			}
			try {
				return resolve(linkpath, sourcePath, (l: string, s: string) => original.call(this, l, s) as TFile | null);
			} catch (err) {
				warnOnce("[Atlas] Link resolution hook failed; falling back to Obsidian's own resolution.", err);
				return original.call(this, linkpath, sourcePath);
			}
		};
	}

	/**
	 * The rule (see `source-links.ts`): `@source:path` → that source; a plain link → the linking
	 * file's own source. A plain link in the vault is first resolved by Obsidian itself, so its answer
	 * is Obsidian's own unless that answer is a file under `Sources/`.
	 */
	private resolve(linkpath: string, sourcePath: string, original: (linkpath: string, sourcePath: string) => TFile | null): TFile | null {
		if (isSourceLinkSyntax(linkpath)) {
			const outcome = resolveSourceLink(this.index, linkpath);
			return outcome.kind === "resolved" ? this.live(outcome.file) : null;
		}
		if (linkpath === "") return original(linkpath, sourcePath); // `[[#heading]]`: the linking file itself
		if (ownSourceOf(sourcePath) === NOTES_SOURCE) {
			const hit = original(linkpath, sourcePath);
			if (!hit || !isUnderSourcesFolder(hit.path)) return hit;
		}
		return this.live(resolvePlainLinkInOwnSource(this.index, linkpath, sourcePath));
	}

	/** F2: only a real, currently-existing `TFile` is ever returned — never a stale or invented one. */
	private live(file: TFile | null): TFile | null {
		if (!file) return null;
		const current = this.app.vault.getAbstractFileByPath(file.path);
		return current instanceof TFile ? current : null;
	}

	private patchOpenLinkText(): void {
		this.handles.push(patchMethod(this.app.workspace, "openLinkText", this.makeOpenGuard()));
		this.patchLeafOpenLinkText();
	}

	/** Leaf-level `openLinkText` is where Obsidian actually creates the missing note, and a few
	 * callers (embeds, canvas) reach it without going through the workspace method. */
	private patchLeafOpenLinkText(): void {
		const proto = this.findLeafPrototype();
		if (!proto) return;
		this.handles.push(patchMethod(proto, "openLinkText", this.makeOpenGuard()));
		this.leafPatched = true;
	}

	private makeOpenGuard(): (original: AnyFn, handle: PatchHandle) => AnyFn {
		const noticeIfBroken = this.noticeIfBrokenSourceLink.bind(this);
		const warnOnce = this.warnOnce.bind(this);
		return (original, handle) =>
			function (this: unknown, ...args: unknown[]) {
				if (handle.active) {
					try {
						if (noticeIfBroken(args[0])) return Promise.resolve();
					} catch (err) {
						warnOnce("[Atlas] Broken-link guard failed; opening normally.", err);
					}
				}
				return original.apply(this, args);
			};
	}

	private findLeafPrototype(): object | null {
		let found: object | null = null;
		try {
			const workspace = this.app.workspace as unknown as { iterateAllLeaves?: (cb: (leaf: object) => void) => void };
			workspace.iterateAllLeaves?.((leaf) => {
				if (found) return;
				const proto = Object.getPrototypeOf(leaf) as { openLinkText?: unknown } | null;
				if (proto && typeof proto.openLinkText === "function") found = proto;
			});
		} catch {
			// No leaf prototype: the workspace-level guard still covers the common click paths.
		}
		return found;
	}

	private warnOnce(message: string, detail?: unknown): void {
		if (this.warned) return;
		this.warned = true;
		this.warn(message, detail);
	}
}
