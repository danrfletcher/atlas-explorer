import type { App, EventRef, TFile } from "obsidian";
import { LinkResolutionHook } from "./link-resolution-hook";

/**
 * G9 — decides, from `settings.tephraEnabled`, whether the link-resolution hook (main design) or the
 * Q13 fallback renderer is active, and keeps that in step as the setting or the Obsidian internals
 * change.
 *
 *   off        — `tephraEnabled` is false: nothing is patched, no vault listeners, the renderers return
 *                at once. Atlas behaves exactly as without Tephra mode.
 *   hook       — Obsidian's own resolution was taught `@source:`; Obsidian renders everything.
 *   fallback   — the hook could not be installed (or `tephraLinkFallback` forces it): Atlas renders
 *                `[[@source:…]]` itself in reading view and live preview. No embeds (agreed gap).
 */
export type SourceLinkMode = "off" | "hook" | "fallback";

export interface SourceLinkSettings {
	tephraEnabled: boolean;
	/** Internal switch for the live spike: forces the Q13 fallback even when the hook would install. */
	tephraLinkFallback: boolean;
}

export class SourceLinkController {
	private hook: LinkResolutionHook;
	private mode: SourceLinkMode = "off";
	private refs: EventRef[] = [];

	constructor(
		private app: App,
		private getSettings: () => SourceLinkSettings,
		/** Called after the mode changes so open editors can re-run their extensions. */
		private onModeChange: () => void = () => {},
		warn?: (message: string, detail?: unknown) => void
	) {
		this.hook = new LinkResolutionHook(app, warn);
	}

	getMode(): SourceLinkMode {
		return this.mode;
	}

	isFallbackActive(): boolean {
		return this.mode === "fallback";
	}

	/** Reads the settings and installs or removes the hook / vault listeners to match. Idempotent. */
	sync(): void {
		const previous = this.mode;
		const settings = this.getSettings();
		if (settings.tephraEnabled !== true) {
			this.teardown();
			this.mode = "off";
		} else if (settings.tephraLinkFallback === true) {
			this.hook.uninstall();
			this.watchVault();
			this.mode = "fallback";
		} else {
			const result = this.hook.install();
			this.watchVault();
			this.mode = result === "unsupported" ? "fallback" : "hook";
		}
		if (this.mode !== previous) this.onModeChange();
	}

	/** Plugin unload (E8): removes the in-memory patch only — never touches files or settings. */
	dispose(): void {
		this.teardown();
		this.mode = "off";
	}

	/** Resolves a link by the Tephra rule, for the fallback renderer. Null when off. */
	resolveFile(linktext: string, sourcePath: string): TFile | null {
		if (this.mode === "off") return null;
		return this.hook.resolveFile(linktext, sourcePath);
	}

	/** Why a source link is broken (E3 hover text), or null when it resolves, is not one, or the mode is off. */
	describeBroken(linktext: string): string | null {
		if (this.mode === "off") return null;
		return this.hook.describeBrokenSourceLink(linktext);
	}

	/** Shows the "No file … in …" notice for a broken source link; true when `linktext` was one. */
	noticeIfBroken(linktext: string): boolean {
		return this.hook.noticeIfBrokenSourceLink(linktext);
	}

	private teardown(): void {
		this.hook.uninstall();
		for (const ref of this.refs) this.app.vault.offref(ref);
		this.refs = [];
	}

	/** The only cache is a path lookup table: drop it when the vault's file list changes. */
	private watchVault(): void {
		if (this.refs.length > 0) return;
		const invalidate = () => this.hook.invalidate();
		this.refs = [this.app.vault.on("create", invalidate), this.app.vault.on("delete", invalidate), this.app.vault.on("rename", invalidate)];
	}
}
