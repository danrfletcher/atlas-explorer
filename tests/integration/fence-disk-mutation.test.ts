import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { StatusesManager } from "../../src/statuses";
import { AtlasExplorerView } from "../../src/explorer-view";
import { openRepaintRig, RepaintRig } from "./repaint-rig";
import { buildFixture, inboxKeys, keysOf } from "../auto-promotion-fixtures";
import type { Fixture } from "../auto-promotion-fixtures";

/** PR-1 (F1): the auto-promotion switch never writes to the vault. Every mutating call the mock
 * vault records (`create`, `createFolder`, `modify`, `delete`, `rename`, `fileManager.renameFile`) is
 * compared before and after; the mutating Obsidian calls the mock vault doesn't implement
 * (`trash`, `process`, `append`, `createBinary`, `modifyBinary`, `copy`, `fileManager.trashFile`,
 * `fileManager.processFrontMatter`) are installed as spies that must never fire. */

const UNIMPLEMENTED_WRITES = ["trash", "process", "append", "createBinary", "modifyBinary", "copy"] as const;
const MUTATING = ["create", "createFolder", "modify", "delete", "rename", "fileManager.renameFile"];

function guard(fx: Fixture) {
	const spies = UNIMPLEMENTED_WRITES.map((name) => {
		const spy = vi.fn();
		(fx.app.vault as unknown as Record<string, unknown>)[name] = spy;
		return { name: `vault.${name}`, spy };
	});
	const fileManager = fx.app.fileManager as unknown as Record<string, unknown>;
	for (const name of ["trashFile", "processFrontMatter"]) {
		const spy = vi.fn();
		fileManager[name] = spy;
		spies.push({ name: `fileManager.${name}`, spy });
	}
	return {
		mutatingCalls: () => fx.app.vault.calls.filter((c) => MUTATING.includes(c)),
		/** Names of the guarded calls that fired. */
		fired: () => spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.name),
	};
}

describe("fence F1: no vault mutation from the auto-promotion switch", () => {
	it.each(["view", "global"] as const)("filtering the inbox (%s mode) with the switch on and off makes no vault write", (mode) => {
		const fx = buildFixture();
		const g = guard(fx);
		const before = fx.app.vault.calls.length;
		for (const value of [false, true, false, true]) {
			fx.settings.autoPromotion = value;
			inboxKeys(fx, mode);
			keysOf(fx.views.getDismissedInboxUnits(fx.index.getUnits(), fx.viewId, mode, fx.index));
		}
		expect(g.mutatingCalls()).toEqual([]);
		expect(g.fired()).toEqual([]);
		expect(fx.app.vault.calls.length).toBe(before); // not even a read: classification is index-only
	});

	it("rebuilding and recomputing the index under either setting makes no vault write", () => {
		const fx = buildFixture();
		const g = guard(fx);
		for (const value of [false, true]) {
			fx.settings.autoPromotion = value;
			fx.index.rebuild();
			fx.index.onMetadataResolved();
		}
		expect(g.mutatingCalls()).toEqual([]);
		expect(g.fired()).toEqual([]);
	});

	it("the link-only classification and the inbox rule make no vault call at all", () => {
		const fx = buildFixture();
		const g = guard(fx);
		const before = fx.app.vault.calls.length;
		for (const unit of fx.index.getUnits()) {
			fx.index.isLinkOnlyPromotion(unit);
			fx.index.isSuppressedFromInbox(unit);
		}
		expect(fx.app.vault.calls.length).toBe(before);
		expect(g.fired()).toEqual([]);
	});

	it("flipping the switch does not rename, delete or move a file that exists in the vault", () => {
		const fx = buildFixture();
		const paths = () => fx.app.vault.getFiles().map((f) => f.path).sort();
		const before = paths();
		fx.settings.autoPromotion = true;
		inboxKeys(fx, "view");
		fx.settings.autoPromotion = false;
		inboxKeys(fx, "view");
		expect(paths()).toEqual(before);
		expect(fx.app.vault.contents.size).toBe(0); // nothing was written to any file either
	});

	describe("through the real explorer pane", () => {
		let rig: RepaintRig;
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => {
			rig?.close();
			vi.useRealTimers();
		});

		it("rendering the inbox as the switch flips makes no vault write", async () => {
			const fx = buildFixture();
			const g = guard(fx);
			rig = await openRepaintRig({ unitIndex: fx.index, viewsManager: fx.views, realLabels: { app: fx.app as unknown as App, settings: fx.settings } });
			const explorer = rig.h.explorer as unknown as AtlasExplorerView;
			for (const value of [true, false, true]) {
				fx.settings.autoPromotion = value;
				explorer.refresh();
				await rig.settle();
			}
			expect(g.mutatingCalls()).toEqual([]);
			expect(g.fired()).toEqual([]);
		});
	});

	it("saving the setting writes only the plugin's own data.json (saveData), never the vault", async () => {
		const fx = buildFixture();
		const g = guard(fx);
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		const saved: { settings: AtlasSettings }[] = [];
		Object.assign(plugin, {
			settings: fx.settings,
			unitIndex: fx.index,
			viewsManager: fx.views,
			statusesManager: new StatusesManager([], [], () => {}),
			expandedModuleFolders: new Set<string>(),
			saveData: async (data: { settings: AtlasSettings }) => {
				saved.push(data);
			},
		});
		const before = fx.app.vault.calls.length;
		fx.settings.autoPromotion = true;
		await plugin.saveSettings();
		expect(saved).toHaveLength(1);
		expect(saved[0].settings.autoPromotion).toBe(true);
		expect(fx.app.vault.calls.length).toBe(before);
		expect(g.mutatingCalls()).toEqual([]);
		expect(g.fired()).toEqual([]);
		expect(DEFAULT_SETTINGS.autoPromotion).toBe(false);
	});
});
