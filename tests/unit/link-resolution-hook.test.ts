import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, MetadataCache, Notice, TFile } from "obsidian";
import AtlasPlugin from "../../src/main";
import { LinkResolutionHook } from "../../src/link-resolution-hook";
import { SourceLinkController } from "../../src/source-link-controller";
import { DEFAULT_SETTINGS, normalizeTephraMode } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { obsidianFirstLinkpathDest, seedPaths, sourcesVaultPaths } from "../sources-vault";

type Resolver = (linkpath: string, sourcePath: string) => TFile | null;

function buildApp(extra: string[] = []): App {
	const app = new App();
	seedPaths(app, [...sourcesVaultPaths(), ...extra]);
	// Make the unpatched resolver a faithful Obsidian: it is the function the hook must delegate to.
	app.metadataCache.getFirstLinkpathDest = obsidianFirstLinkpathDest(app) as MetadataCache["getFirstLinkpathDest"];
	return app;
}

const resolverOf = (app: App): Resolver => (l, s) => app.metadataCache.getFirstLinkpathDest(l, s);
const quietWarn = () => vi.fn();

beforeEach(() => Notice.reset());
afterEach(() => vi.restoreAllMocks());

describe("install and uninstall", () => {
	it("install replaces the resolver; uninstall restores the original function exactly (own property)", () => {
		const app = buildApp();
		const original = app.metadataCache.getFirstLinkpathDest;
		const hook = new LinkResolutionHook(app, quietWarn());
		expect(hook.install()).toBe("installed");
		expect(hook.isInstalled()).toBe(true);
		expect(app.metadataCache.getFirstLinkpathDest).not.toBe(original);
		hook.uninstall();
		expect(hook.isInstalled()).toBe(false);
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(Object.prototype.hasOwnProperty.call(app.metadataCache, "getFirstLinkpathDest")).toBe(true);
	});

	it("restores a prototype method by removing the own property, so the original is the prototype's", () => {
		const app = new App();
		seedPaths(app, sourcesVaultPaths());
		const proto = MetadataCache.prototype.getFirstLinkpathDest;
		expect(Object.prototype.hasOwnProperty.call(app.metadataCache, "getFirstLinkpathDest")).toBe(false);
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		expect(Object.prototype.hasOwnProperty.call(app.metadataCache, "getFirstLinkpathDest")).toBe(true);
		hook.uninstall();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(proto);
		expect(Object.prototype.hasOwnProperty.call(app.metadataCache, "getFirstLinkpathDest")).toBe(false);
	});

	it("also restores workspace.openLinkText and a leaf prototype's openLinkText, by identity", () => {
		const app = buildApp();
		const protoOpen = vi.fn(async () => {});
		class FakeLeaf {
			openLinkText = undefined as never;
		}
		(FakeLeaf.prototype as unknown as { openLinkText: unknown }).openLinkText = protoOpen;
		const leaf = new FakeLeaf();
		const workspace = app.workspace as unknown as Record<string, unknown>;
		const wsOpen = vi.fn(async () => {});
		workspace.openLinkText = wsOpen;
		workspace.iterateAllLeaves = (cb: (l: object) => void) => cb(Object.create(FakeLeaf.prototype));
		void leaf;
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		expect(workspace.openLinkText).not.toBe(wsOpen);
		expect(FakeLeaf.prototype.openLinkText).not.toBe(protoOpen);
		hook.uninstall();
		expect(workspace.openLinkText).toBe(wsOpen);
		expect(FakeLeaf.prototype.openLinkText).toBe(protoOpen);
	});

	it("install is idempotent and uninstall without install is a no-op", () => {
		const app = buildApp();
		const original = app.metadataCache.getFirstLinkpathDest;
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.uninstall();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(hook.install()).toBe("installed");
		const patched = app.metadataCache.getFirstLinkpathDest;
		expect(hook.install()).toBe("already-installed");
		expect(app.metadataCache.getFirstLinkpathDest).toBe(patched);
		hook.uninstall();
		hook.uninstall();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
	});

	it("a leaf that only appears after install gets its guard on the next install() call", () => {
		const app = buildApp();
		const protoOpen = vi.fn(async () => {});
		const proto = { openLinkText: protoOpen };
		const workspace = app.workspace as unknown as Record<string, unknown>;
		workspace.openLinkText = vi.fn(async () => {});
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install(); // no iterateAllLeaves yet
		expect(proto.openLinkText).toBe(protoOpen);
		workspace.iterateAllLeaves = (cb: (l: object) => void) => cb(Object.create(proto));
		expect(hook.install()).toBe("already-installed");
		expect(proto.openLinkText).not.toBe(protoOpen);
		hook.uninstall();
		expect(proto.openLinkText).toBe(protoOpen);
	});

	it("if another patch wrapped on top of ours, uninstall does not clobber it and ours becomes a pass-through", () => {
		const app = buildApp();
		const original = app.metadataCache.getFirstLinkpathDest;
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		const ours = app.metadataCache.getFirstLinkpathDest;
		const theirs = vi.fn((l: string, s: string) => ours.call(app.metadataCache, l, s)) as unknown as MetadataCache["getFirstLinkpathDest"];
		app.metadataCache.getFirstLinkpathDest = theirs;
		hook.uninstall();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(theirs);
		// ours now delegates to the original, so `@` links are no longer special.
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md")).toBe(original("@whoop:Workout Plan", "Weekly Review.md"));
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md")).toBeNull();
	});
});

describe("the hooked resolver", () => {
	it("resolves @ links through Obsidian's own getFirstLinkpathDest, returning real TFiles", () => {
		const app = buildApp();
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		const file = app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md");
		expect(file).toBe(app.vault.getAbstractFileByPath("Sources/whoop/Workout Plan.md"));
		expect(app.metadataCache.getFirstLinkpathDest("@tephra:crates/tephrad/src/registry.rs", "Weekly Review.md")).toBe(
			app.vault.getAbstractFileByPath("Sources/tephra/crates/tephrad/src/registry.rs")
		);
		// from a file in another source too, and with an empty source path
		expect(app.metadataCache.getFirstLinkpathDest("@notes:Leg Day", "Sources/whoop/Workout Plan.md")).toBe(app.vault.getAbstractFileByPath("Leg Day.md"));
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Leg Day", "")).toBe(app.vault.getAbstractFileByPath("Sources/whoop/Leg Day.md"));
	});

	it("broken and malformed @ links resolve to null and never throw", () => {
		const app = buildApp();
		new LinkResolutionHook(app, quietWarn()).install();
		for (const link of ["@whoop:Nope", "@nosuch:x", "@:x", "@whoop:", "@who op:x", "@a*:x", "@whoop:sub/../x", "@wh😀:x", "@whoop:a\u0000b"]) {
			expect(() => app.metadataCache.getFirstLinkpathDest(link, "Weekly Review.md"), link).not.toThrow();
			expect(app.metadataCache.getFirstLinkpathDest(link, "Weekly Review.md"), link).toBeNull();
		}
		expect(app.metadataCache.getFirstLinkpathDest("", "")).toBeNull(); // an empty link
	});

	it("an own-source plain link inside Sources/whoop/ opens the whoop copy, not the vault-root one", () => {
		const app = buildApp();
		new LinkResolutionHook(app, quietWarn()).install();
		expect(app.metadataCache.getFirstLinkpathDest("Leg Day", "Sources/whoop/Workout Plan.md")?.path).toBe("Sources/whoop/Leg Day.md");
		expect(app.metadataCache.getFirstLinkpathDest("Leg Day", "Weekly Review.md")?.path).toBe("Leg Day.md");
	});

	it("delegates to the original for plain vault links and for `@` links with no colon (F9)", () => {
		const app = buildApp(["@home.md"]);
		const original = vi.fn(obsidianFirstLinkpathDest(app));
		app.metadataCache.getFirstLinkpathDest = original as MetadataCache["getFirstLinkpathDest"];
		new LinkResolutionHook(app, quietWarn()).install();
		for (const link of ["Leg Day", "README", "Weekly Review", "@home", "Missing", ""]) {
			original.mockClear();
			const got = app.metadataCache.getFirstLinkpathDest(link, "Weekly Review.md");
			expect(original, link).toHaveBeenCalledWith(link, "Weekly Review.md");
			expect(got, link).toBe(obsidianFirstLinkpathDest(app)(link, "Weekly Review.md"));
		}
		expect(app.metadataCache.getFirstLinkpathDest("@home", "Weekly Review.md")?.path).toBe("@home.md");
	});

	it("does not call the original for an @ link at all", () => {
		const app = buildApp();
		const original = vi.fn(obsidianFirstLinkpathDest(app));
		app.metadataCache.getFirstLinkpathDest = original as MetadataCache["getFirstLinkpathDest"];
		new LinkResolutionHook(app, quietWarn()).install();
		app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md");
		expect(original).not.toHaveBeenCalled();
	});

	it("non-string arguments go straight to the original", () => {
		const app = buildApp();
		const original = vi.fn(() => null);
		app.metadataCache.getFirstLinkpathDest = original as unknown as MetadataCache["getFirstLinkpathDest"];
		new LinkResolutionHook(app, quietWarn()).install();
		expect(() => (app.metadataCache.getFirstLinkpathDest as (a: unknown, b: unknown) => unknown)(undefined, undefined)).not.toThrow();
		expect(original).toHaveBeenCalledWith(undefined, undefined);
	});

	it("an internal failure falls back to the original and logs once", () => {
		const app = buildApp();
		const leg = app.vault.getAbstractFileByPath("Leg Day.md") as TFile;
		const original = vi.fn(() => leg); // a stand-in that does not read the vault we are about to break
		app.metadataCache.getFirstLinkpathDest = original as unknown as MetadataCache["getFirstLinkpathDest"];
		const warn = vi.fn();
		const hook = new LinkResolutionHook(app, warn);
		hook.install();
		vi.spyOn(app.vault, "getFiles").mockImplementation(() => {
			throw new Error("boom");
		});
		expect(app.metadataCache.getFirstLinkpathDest("Leg Day", "Sources/whoop/Workout Plan.md")).toBe(leg);
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Leg Day", "Weekly Review.md")).toBe(leg); // failed `@` resolution also delegates
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("rebuilds its lookup table after the vault changes (invalidate), and never returns a deleted file", async () => {
		const app = buildApp();
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		const get = resolverOf(app);
		expect(get("@whoop:New One", "Weekly Review.md")).toBeNull();
		await app.vault.create("Sources/whoop/New One.md", "");
		hook.invalidate();
		expect(get("@whoop:New One", "Weekly Review.md")?.path).toBe("Sources/whoop/New One.md");
		// A stale table (no invalidate) must still never hand back a file that is gone.
		await app.vault.delete(app.vault.getAbstractFileByPath("Sources/whoop/New One.md")!);
		expect(get("@whoop:New One", "Weekly Review.md")).toBeNull();
	});
});

describe("missing or changed internals: the guard leaves Obsidian alone, logs once, and picks the fallback", () => {
	const breakers: Array<[string, (app: App) => void]> = [
		["getFirstLinkpathDest missing", (app) => void ((app.metadataCache as unknown as Record<string, unknown>).getFirstLinkpathDest = undefined)],
		["getFirstLinkpathDest not a function", (app) => void ((app.metadataCache as unknown as Record<string, unknown>).getFirstLinkpathDest = 42)],
		["resolvedLinks missing", (app) => void ((app.metadataCache as unknown as Record<string, unknown>).resolvedLinks = undefined)],
		["unresolvedLinks null", (app) => void ((app.metadataCache as unknown as Record<string, unknown>).unresolvedLinks = null)],
		["vault.getFiles missing", (app) => void ((app.vault as unknown as Record<string, unknown>).getFiles = undefined)],
	];

	it.each(breakers)("%s", (_name, breakIt) => {
		const app = buildApp();
		const open = vi.fn(async () => {});
		(app.workspace as unknown as Record<string, unknown>).openLinkText = open;
		breakIt(app);
		const before = { ...app.metadataCache } as Record<string, unknown>;
		const warn = vi.fn();
		const hook = new LinkResolutionHook(app, warn);
		expect(hook.install()).toBe("unsupported");
		expect(hook.install()).toBe("unsupported");
		expect(hook.isInstalled()).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1); // once, not per attempt
		expect({ ...app.metadataCache }).toEqual(before);
		expect((app.workspace as unknown as Record<string, unknown>).openLinkText).toBe(open); // nothing else was touched
	});

	it("a failure halfway through install is rolled back", () => {
		const app = buildApp();
		const original = app.metadataCache.getFirstLinkpathDest;
		Object.defineProperty(app.workspace, "openLinkText", { value: () => {}, writable: false, configurable: false });
		const warn = vi.fn();
		const hook = new LinkResolutionHook(app, warn);
		expect(hook.install()).toBe("unsupported");
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("the controller then reports the fallback", () => {
		const app = buildApp();
		(app.metadataCache as unknown as Record<string, unknown>).resolvedLinks = undefined;
		const warn = vi.fn();
		const controller = new SourceLinkController(app, () => ({ tephraMode: true, tephraLinkFallback: false }), undefined, warn);
		controller.sync();
		expect(controller.getMode()).toBe("fallback");
		expect(controller.isFallbackActive()).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("tephraMode toggling through the controller", () => {
	function setup(initial: Partial<AtlasSettings> = {}) {
		const app = buildApp();
		const settings = { tephraMode: false, tephraLinkFallback: false, ...initial };
		const changes: string[] = [];
		const controller = new SourceLinkController(app, () => settings, () => changes.push(controller.getMode()), quietWarn());
		return { app, settings, controller, changes, original: app.metadataCache.getFirstLinkpathDest };
	}

	it("with tephraMode false nothing is patched and no vault listener is registered", () => {
		const { app, controller, original } = setup();
		const on = vi.spyOn(app.vault, "on");
		const workspaceOpen = (app.workspace as unknown as Record<string, unknown>).openLinkText;
		controller.sync();
		expect(controller.getMode()).toBe("off");
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect((app.workspace as unknown as Record<string, unknown>).openLinkText).toBe(workspaceOpen);
		expect(on).not.toHaveBeenCalled();
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md")).toBeNull();
		expect(controller.resolveFile("@whoop:Workout Plan", "Weekly Review.md")).toBeNull();
	});

	it("turning it on installs, turning it off uninstalls and drops the listeners", () => {
		const { app, settings, controller, changes, original } = setup();
		settings.tephraMode = true;
		controller.sync();
		expect(controller.getMode()).toBe("hook");
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md")?.path).toBe("Sources/whoop/Workout Plan.md");
		settings.tephraMode = false;
		controller.sync();
		expect(controller.getMode()).toBe("off");
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(app.metadataCache.getFirstLinkpathDest("@whoop:Workout Plan", "Weekly Review.md")).toBeNull();
		expect(changes).toEqual(["hook", "off"]);
		// the listeners are gone: creating a file after turn-off reaches nothing
		const off = vi.spyOn(app.vault, "offref");
		settings.tephraMode = true;
		controller.sync();
		settings.tephraMode = false;
		controller.sync();
		expect(off).toHaveBeenCalledTimes(3);
	});

	it("sync() is idempotent: repeated calls change nothing and notify once", () => {
		const { app, settings, controller, changes } = setup({ tephraMode: true });
		controller.sync();
		const patched = app.metadataCache.getFirstLinkpathDest;
		controller.sync();
		controller.sync();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(patched);
		expect(changes).toEqual(["hook"]);
		void settings;
	});

	it("vault create, delete and rename invalidate the lookup table", async () => {
		const { app, controller } = setup({ tephraMode: true });
		controller.sync();
		const get = resolverOf(app);
		expect(get("@whoop:Fresh", "Weekly Review.md")).toBeNull();
		await app.vault.create("Sources/whoop/Fresh.md", "");
		expect(get("@whoop:Fresh", "Weekly Review.md")?.path).toBe("Sources/whoop/Fresh.md");
		await app.vault.rename(app.vault.getAbstractFileByPath("Sources/whoop/Fresh.md")!, "Sources/whoop/Renamed.md");
		expect(get("@whoop:Fresh", "Weekly Review.md")).toBeNull();
		expect(get("@whoop:Renamed", "Weekly Review.md")?.path).toBe("Sources/whoop/Renamed.md");
		await app.vault.delete(app.vault.getAbstractFileByPath("Sources/whoop/Renamed.md")!);
		expect(get("@whoop:Renamed", "Weekly Review.md")).toBeNull();
	});

	it("tephraLinkFallback forces the fallback and leaves Obsidian unpatched", () => {
		const { app, controller, original } = setup({ tephraMode: true, tephraLinkFallback: true });
		controller.sync();
		expect(controller.getMode()).toBe("fallback");
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(controller.resolveFile("@whoop:Workout Plan", "Weekly Review.md")?.path).toBe("Sources/whoop/Workout Plan.md");
	});

	it("dispose() removes the patch without touching settings", () => {
		const { app, settings, controller, original } = setup({ tephraMode: true });
		controller.sync();
		controller.dispose();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(settings.tephraMode).toBe(true);
		expect(controller.getMode()).toBe("off");
	});
});

describe("no writes, no network, no new files (F2, F3, offline)", () => {
	it("resolving, noticing and uninstalling never create, modify or delete anything, and never use the network", async () => {
		const app = buildApp();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const filesBefore = app.vault.getFiles().map((f) => f.path);
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		for (const link of ["@whoop:Workout Plan", "@whoop:Nope", "@nosuch:x", "Leg Day", "@:x", "@home"]) {
			app.metadataCache.getFirstLinkpathDest(link, "Weekly Review.md");
			hook.noticeIfBrokenSourceLink(link);
		}
		hook.uninstall();
		expect(app.vault.calls).toEqual([]); // no create, modify, process, delete, rename
		expect(app.vault.getFiles().map((f) => f.path)).toEqual(filesBefore);
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("the sources never import a network or write API", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		for (const f of ["source-links.ts", "link-resolution-hook.ts", "source-link-controller.ts", "source-link-fallback.ts"]) {
			const text = readFileSync(join(__dirname, "../../src", f), "utf8");
			expect(text, f).not.toMatch(/requestUrl|\bfetch\(|XMLHttpRequest|vault\.(modify|process|create|delete|trash|rename)|fileManager\.|adapter\.write|saveData/);
		}
	});
});

describe("performance: 5,000 links across 3 sources", () => {
	it("stays far under a second here (the 50 ms budget is measured in the container)", () => {
		const app = new App();
		const paths: string[] = [];
		for (const source of ["whoop", "tephra", "drive"]) for (let i = 0; i < 600; i++) paths.push(`Sources/${source}/dir${i % 20}/File ${i}.md`);
		for (let i = 0; i < 600; i++) paths.push(`Notes/n${i % 10}/Note ${i}.md`);
		paths.push("Weekly Review.md");
		seedPaths(app, paths);
		app.metadataCache.getFirstLinkpathDest = obsidianFirstLinkpathDest(app) as MetadataCache["getFirstLinkpathDest"];
		const hook = new LinkResolutionHook(app, quietWarn());
		hook.install();
		const sources = ["whoop", "tephra", "drive"];
		const t0 = performance.now();
		let resolved = 0;
		for (let i = 0; i < 5000; i++) {
			const link = i % 4 === 0 ? `@${sources[i % 3]}:File ${i % 600}` : i % 4 === 1 ? `File ${i % 600}` : `@${sources[i % 3]}:dir${i % 20}/File ${i % 600}`;
			const from = i % 4 === 1 ? `Sources/${sources[i % 3]}/dir0/File 0.md` : "Weekly Review.md";
			if (app.metadataCache.getFirstLinkpathDest(link, from)) resolved++;
		}
		const elapsed = performance.now() - t0;
		console.info(`[perf] 5,000 hooked resolves over 3 sources (1,800 source files + 600 notes): ${elapsed.toFixed(1)} ms, ${resolved} resolved`);
		expect(resolved).toBeGreaterThan(3000);
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("tephraMode setting and the plugin lifecycle", () => {
	const makePlugin = () => Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const loadFromData = (plugin: AtlasPlugin, data: unknown) => (plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(data);

	it("DEFAULT_SETTINGS.tephraMode is the boolean false", () => {
		expect(DEFAULT_SETTINGS.tephraMode).toBe(false);
		expect(DEFAULT_SETTINGS.tephraLinkFallback).toBe(false);
	});

	it.each([
		[true, true],
		[false, false],
		[undefined, false],
		[null, false],
		["true", false],
		[1, false],
		[{}, false],
	])("normalizeTephraMode(%j) is %s: only a real true turns it on", (raw, expected) => {
		expect(normalizeTephraMode(raw)).toBe(expected);
	});

	it("an old data.json (no tephraMode) loads as off; an explicit true is kept; non-booleans are off", () => {
		const old = makePlugin();
		loadFromData(old, { settings: { poolFolder: "_pool" } });
		expect((old.settings as AtlasSettings).tephraMode).toBe(false);
		const on = makePlugin();
		loadFromData(on, { settings: { poolFolder: "_pool", tephraMode: true } });
		expect((on.settings as AtlasSettings).tephraMode).toBe(true);
		const bad = makePlugin();
		loadFromData(bad, { settings: { poolFolder: "_pool", tephraMode: "true", tephraLinkFallback: 1 } });
		expect((bad.settings as AtlasSettings).tephraMode).toBe(false);
		expect((bad.settings as AtlasSettings).tephraLinkFallback).toBe(false);
	});

	it("setTephraMode installs and removes the hook, and saves", async () => {
		const app = buildApp();
		const plugin = makePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS };
		plugin.app = app as never;
		plugin.sourceLinks = new SourceLinkController(app, () => plugin.settings as AtlasSettings, undefined, quietWarn());
		plugin.flushSave = vi.fn(async () => {});
		const original = app.metadataCache.getFirstLinkpathDest;
		await plugin.setTephraMode(true);
		expect(app.metadataCache.getFirstLinkpathDest).not.toBe(original);
		expect((plugin.settings as AtlasSettings).tephraMode).toBe(true);
		await plugin.setTephraMode(false);
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(plugin.flushSave).toHaveBeenCalledTimes(2);
	});

	it("E8: onunload removes the patch by identity and changes no file or setting", () => {
		const app = buildApp();
		const plugin = makePlugin();
		const settings = { ...DEFAULT_SETTINGS, tephraMode: true };
		const original = app.metadataCache.getFirstLinkpathDest;
		plugin.settings = settings;
		plugin.app = app as never;
		plugin.sourceLinks = new SourceLinkController(app, () => plugin.settings as AtlasSettings, undefined, quietWarn());
		plugin.sourceLinks.sync();
		expect(app.metadataCache.getFirstLinkpathDest).not.toBe(original);
		plugin.outsideFolderWatchers = { closeAll: vi.fn() } as never;
		plugin.folderLiveRefresh = { cancelAll: vi.fn() } as never;
		plugin.linkSuggest = undefined as never;
		const saveData = vi.fn();
		plugin.saveData = saveData;
		plugin.onunload();
		expect(app.metadataCache.getFirstLinkpathDest).toBe(original);
		expect(plugin.settings).toEqual({ ...DEFAULT_SETTINGS, tephraMode: true }); // setting untouched
		expect(saveData).not.toHaveBeenCalled();
		expect(app.vault.calls).toEqual([]);
	});

	it("unloading a plugin that never turned Tephra mode on is safe", () => {
		const plugin = makePlugin();
		plugin.app = new App() as never;
		plugin.outsideFolderWatchers = { closeAll: vi.fn() } as never;
		plugin.folderLiveRefresh = { cancelAll: vi.fn() } as never;
		plugin.linkSuggest = undefined as never;
		expect(() => plugin.onunload()).not.toThrow(); // sourceLinks undefined (load never finished)
	});
});
