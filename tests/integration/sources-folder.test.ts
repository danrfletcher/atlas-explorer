import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App as ObsidianApp } from "obsidian";
import { App } from "../mocks/obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS, normalizeTephraExcludes, normalizeTephraLinks, showsInSearch, type AtlasSettings } from "../../src/settings";
import { SourcesFolder, type SourcesFolderDeps } from "../../src/sources-folder";
import { SourceDeleteClassifier } from "../../src/source-delete-classifier";
import { nodeSourcesFs, existsOnDisk } from "../../src/sources-fs";
import { vaultExcludeConfig } from "../../src/source-excludes";
import { setSourceExcluded } from "../../src/tephra-exclude";
import { TephraConnection, TEPHRA_CHECK_INTERVAL_MS, type ScheduleInterval } from "../../src/tephra-connection";
import { TephraController } from "../../src/tephra-controller";
import { TephraTeardownRegistry } from "../../src/tephra-teardown";
import type { TephraSource, TephraSourcesResult } from "../../src/tephra-client";
import { ExternalMoveDetector } from "../../src/external-move";
import { FolderLiveRefresh } from "../../src/folder-live-refresh";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import type { UnitRef } from "../../src/types";

/**
 * PR-3 integration: real symlinks in a temp dir, the real `SourcesFolder`, `TephraConnection`,
 * `TephraController` and `SourceDeleteClassifier`, a fake Tephra that answers `source.list` and pushes
 * `graph:changed` over the connection's push channel (`h.pushGraphChanged()`), and the mock vault
 * firing real delete events into the real `AtlasPlugin.onVaultDeleteEvent`.
 */

let tmp: string;
const cleanups: (() => void)[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "atlas-sources-"));
});
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
	rmSync(tmp, { recursive: true, force: true }); // only the temp dir this test made
	vi.restoreAllMocks();
});

function write(path: string, text = "x"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

/** Every file under `dir` (not following links) with its content hash: "byte-identical afterwards". */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string) => {
		for (const name of readdirSync(current).sort()) {
			const path = join(current, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile()) out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
		}
	};
	walk(dir);
	return out;
}

interface Options {
	/** A second plugin in the same temp dir needs its own vault folder. */
	dir?: string;
	mobile?: boolean;
	sourceSettings?: AtlasSettings["tephraSourceSettings"];
}

function build(opts: Options = {}) {
	const vault = join(tmp, opts.dir ?? "vault");
	mkdirSync(vault, { recursive: true });
	const app = new App();
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: false, tephraLinks: {}, tephraExcludes: {}, tephraSourceSettings: opts.sourceSettings ?? {} };
	const notices: string[] = [];
	const fsCalls: string[] = [];
	// A test can hold the next `readFile` of a path ending in `suffix` until it says go: that is how a sync is
	// kept mid-reconcile while the settings tab changes something.
	const gates: { suffix: string; arrive: () => void; wait: Promise<void> }[] = [];
	const countingFs = Object.fromEntries(
		Object.entries(nodeSourcesFs).map(([name, fn]) => [
			name,
			(...args: unknown[]) => {
				fsCalls.push(`${name} ${String(args[0])}`);
				const gate = name === "readFile" ? gates.find((g) => String(args[0]).endsWith(g.suffix)) : undefined;
				if (!gate) return (fn as (...a: unknown[]) => unknown)(...args);
				gates.splice(gates.indexOf(gate), 1);
				gate.arrive();
				return gate.wait.then(() => (fn as (...a: unknown[]) => unknown)(...args));
			},
		])
	) as unknown as SourcesFolderDeps["fs"];
	const holdNextRead = (suffix: string) => {
		let release = () => {};
		let arrive = () => {};
		const arrived = new Promise<void>((resolve) => (arrive = resolve));
		const wait = new Promise<void>((resolve) => (release = resolve));
		gates.push({ suffix, arrive, wait });
		return { arrived, release };
	};

	const tephra = { online: true, sources: [{ name: "notes", path: vault, status: "online" }] as TephraSource[] };
	// The push channel: the connection opens it through `openPush`, and `pushGraphChanged` is Tephra sending
	// a `graph:changed` notification down it (nothing here calls `requestCheck` for it).
	let pushed: ((text: string) => void) | null = null;
	const pushGraphChanged = () => {
		if (!pushed) throw new Error("the connection has not opened its push channel");
		pushed(JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: { source: "tephra" } }));
	};
	const client = {
		openPush: async (handlers: { onText: (text: string) => void; onClose: () => void }) => {
			pushed = handlers.onText;
			return { ok: true as const, handle: { close: () => void (pushed = null) } };
		},
		listSources: async (): Promise<TephraSourcesResult> => (tephra.online ? { ok: true, sources: tephra.sources.map((s) => ({ ...s })) } : { ok: false, error: { kind: "network", message: "down" } }),
		call: async () => ({ ok: true as const, result: null }),
	};
	let tick: (() => void) | null = null;
	const schedule: ScheduleInterval = (_ms, fn) => {
		tick = fn;
		return () => {
			tick = null;
		};
	};
	// A cooldown that ends on the next microtask: pushes in one burst still collapse, and no real timer is left.
	const instantTimeout = (_ms: number, fn: () => void) => {
		let live = true;
		queueMicrotask(() => live && fn());
		return () => void (live = false);
	};
	const connection = new TephraConnection(client as never, schedule, TEPHRA_CHECK_INTERVAL_MS, { scheduleTimeout: instantTimeout });

	const classifier = new SourceDeleteClassifier({ getLinkTargets: () => settings.tephraLinks, targetExists: existsOnDisk });
	let saves = 0;
	const sourcesFolder = new SourcesFolder({
		fs: countingFs,
		getVaultPath: () => vault,
		isMobile: () => opts.mobile ?? false,
		records: {
			getLinks: () => settings.tephraLinks,
			setLinks: (next) => {
				settings.tephraLinks = next;
			},
			getExcludes: () => settings.tephraExcludes,
			setExcludes: (next) => {
				settings.tephraExcludes = next;
			},
			save: async () => {
				saves++;
			},
		},
		excludeConfig: () => vaultExcludeConfig(app.vault as never),
		showsInSearch: (name) => showsInSearch(settings, name),
		classifier,
		notify: (message) => notices.push(message),
	});

	// What runs after a flip: a test swaps in the real `AtlasPlugin.onTephraToggled` to drive the production path.
	const hooks = {
		afterChange: (enabled: boolean): void => {
			if (enabled) sourcesFolder.start();
		},
	};
	// The same wiring `main.ts` does (see the wiring test below).
	const registry = new TephraTeardownRegistry();
	registry.register({ name: "Sources folder links", run: () => sourcesFolder.teardown() });
	const controller = new TephraController({
		getEnabled: () => settings.tephraEnabled,
		setEnabled: (enabled) => {
			settings.tephraEnabled = enabled;
		},
		save: async () => {},
		isMobile: () => opts.mobile ?? false,
		beforeEnable: async () => {
			const verdict = await sourcesFolder.checkCanEnable();
			if (!verdict.ok) notices.push(`refused: ${verdict.path}: ${verdict.reason}`);
			return verdict.ok;
		},
		createConnection: () => {
			connection.onCheck((snapshot) => {
				if (snapshot.state === "online") void sourcesFolder.sync(snapshot.sources);
			});
			return connection;
		},
		runTeardown: () => registry.run(),
		reportTeardownFailures: (failures) => notices.push(`teardown failed: ${failures.map((f) => f.name).join(",")}`),
		afterChange: (enabled) => hooks.afterChange(enabled),
	});

	const addSource = (name: string, files: Record<string, string> = { "README.md": "# readme" }): string => {
		const root = join(tmp, "src", name);
		for (const [rel, text] of Object.entries(files)) write(join(root, rel), text);
		if (Object.keys(files).length === 0) mkdirSync(root, { recursive: true });
		tephra.sources = [...tephra.sources.filter((s) => s.name !== name), { name, path: root, status: "online" }];
		return root;
	};
	const settle = async () => {
		await connection.check();
		await sourcesFolder.whenIdle();
	};
	const excludes = () => (app.vault.getConfig("userIgnoreFilters") as string[] | undefined) ?? [];
	const linkPath = (name: string) => join(vault, "Sources", name);
	return { vault, app, settings, notices, fsCalls, tephra, connection, controller, sourcesFolder, classifier, addSource, settle, excludes, linkPath, tick: () => tick?.(), registry, saves: () => saves, holdNextRead, hooks, pushGraphChanged };
}

type Harness = ReturnType<typeof build>;
const isLink = (path: string) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

async function turnOn(h: Harness): Promise<void> {
	await h.controller.setEnabled(true);
	await h.settle();
}

describe("G2: links, .gitignore and Excluded files with the toggle on", () => {
	it("creates a real symlink per top-level source, none for notes or a nested source", async () => {
		const h = build();
		const tephra = h.addSource("tephra", { "README.md": "#", ".gitignore": "target/\nnode_modules/\n*.log\n!keep.log\n# c\n", "target/debug/x.bin": "bin", "crates/inner/a.md": "a" });
		h.addSource("whoop");
		h.tephra.sources.push({ name: "inner", path: join(tephra, "crates/inner"), status: "online" });
		await turnOn(h);

		expect(readdirSync(join(h.vault, "Sources")).sort()).toEqual(["tephra", "whoop"]);
		for (const name of ["tephra", "whoop"]) {
			const stat = lstatSync(h.linkPath(name));
			expect(stat.isSymbolicLink()).toBe(true);
			expect(readlinkSync(h.linkPath(name))).toBe(h.tephra.sources.find((s) => s.name === name)!.path);
		}
		expect(readFileSync(join(h.linkPath("tephra"), "README.md"), "utf8")).toBe("#"); // the link really reaches the folder
		expect(h.settings.tephraLinks).toEqual({ tephra, whoop: join(tmp, "src", "whoop") });
	});

	it("writes the vault .gitignore line once, creates the file when missing, and never edits it again", async () => {
		const h = build();
		h.addSource("tephra");
		await turnOn(h);
		expect(readFileSync(join(h.vault, ".gitignore"), "utf8")).toBe("Sources/\n");
		await h.connection.check();
		h.tick();
		await h.settle();
		expect(readFileSync(join(h.vault, ".gitignore"), "utf8")).toBe("Sources/\n");
	});

	it("keeps the lines of an existing .gitignore, and adds a newline first when the last line has none", async () => {
		const h = build();
		writeFileSync(join(h.vault, ".gitignore"), ".obsidian/workspace.json\nnode_modules");
		h.addSource("tephra");
		await turnOn(h);
		expect(readFileSync(join(h.vault, ".gitignore"), "utf8")).toBe(".obsidian/workspace.json\nnode_modules\nSources/\n");
	});

	it("leaves a .gitignore that already ignores Sources untouched", async () => {
		const h = build();
		writeFileSync(join(h.vault, ".gitignore"), "a\n/Sources/\nb\n");
		h.addSource("tephra");
		await turnOn(h);
		expect(readFileSync(join(h.vault, ".gitignore"), "utf8")).toBe("a\n/Sources/\nb\n");
	});

	it("excludes each source's .git/ and .gitignore entries, never Sources/ itself, and keeps Dan's own", async () => {
		const h = build();
		h.app.vault.setConfig("userIgnoreFilters", ["Private/", "/\\.tmp$/"]);
		h.addSource("tephra", { ".gitignore": "target/\nnode_modules/\n*.log\n!keep.log\n", "README.md": "#" });
		await turnOn(h);
		const list = h.excludes();
		expect(list.slice(0, 2)).toEqual(["Private/", "/\\.tmp$/"]);
		expect(list).toContain("Sources/tephra/.git/");
		expect(list).toContain("Sources/tephra/target/");
		expect(list).toContain("Sources/tephra/node_modules/");
		expect(list.some((e) => e.startsWith("/") && e.endsWith("/") && e.includes("log"))).toBe(true);
		expect(list).not.toContain("Sources/");
		expect(list.some((e) => e.includes("keep.log"))).toBe(false); // the negation is skipped
		expect(h.sourcesFolder.getSkippedLines().tephra).toEqual([{ line: "!keep.log", reason: "negation" }]);
	});

	it("follows a .gitignore edit on the next graph:changed, and drops entries when the source goes", async () => {
		const h = build();
		const root = h.addSource("tephra", { ".gitignore": "target/\n" });
		await turnOn(h);
		expect(h.excludes()).toContain("Sources/tephra/target/");

		writeFileSync(join(root, ".gitignore"), "dist/\n");
		h.pushGraphChanged();
		await h.settle();
		expect(h.excludes()).toContain("Sources/tephra/dist/");
		expect(h.excludes()).not.toContain("Sources/tephra/target/");

		h.tephra.sources = h.tephra.sources.filter((s) => s.name !== "tephra");
		h.pushGraphChanged();
		await h.settle();
		expect(h.excludes()).toEqual([]);
		expect(h.settings.tephraExcludes).toEqual({});
		expect(existsSync(h.linkPath("tephra"))).toBe(false);
		expect(h.settings.tephraLinks).toEqual({});
	});

	it("the per-source Show in search toggle: off adds Sources/<name>/, on removes exactly that, Dan's entries stay", async () => {
		const h = build();
		h.app.vault.setConfig("userIgnoreFilters", ["Private/"]);
		h.addSource("whoop");
		await turnOn(h);

		// What the settings tab does: save the setting, then hand the change to the Sources folder.
		h.settings.tephraSourceSettings.whoop = { showInSearch: false };
		await h.sourcesFolder.resync();
		expect(h.excludes()).toContain("Sources/whoop/");
		expect(h.settings.tephraExcludes.whoop).toContain("Sources/whoop/");

		h.settings.tephraSourceSettings.whoop = { showInSearch: true };
		await h.sourcesFolder.resync();
		expect(h.excludes()).not.toContain("Sources/whoop/");
		expect(h.settings.tephraExcludes.whoop).not.toContain("Sources/whoop/");
		expect(h.excludes()).toContain("Private/");
		expect(h.excludes()).toContain("Sources/whoop/.git/");
	});

	it("R4: a toggle flipped while a sync is mid-reconcile can't leave an entry the record doesn't know about", async () => {
		const h = build({ sourceSettings: { alpha: { showInSearch: false } } });
		h.addSource("alpha");
		h.addSource("bravo");
		await turnOn(h);
		expect(h.excludes()).toContain("Sources/alpha/");

		// A sync has read alpha's setting (off) and is waiting on bravo's .gitignore when Dan turns alpha back on.
		const hold = h.holdNextRead("bravo/.gitignore");
		const running = h.sourcesFolder.sync(h.tephra.sources);
		await hold.arrived;
		h.settings.tephraSourceSettings.alpha = { showInSearch: true };
		const flipped = h.sourcesFolder.resync();
		hold.release();
		await Promise.all([running, flipped]);
		await h.sourcesFolder.whenIdle();

		expect(h.excludes()).not.toContain("Sources/alpha/");
		expect(h.settings.tephraExcludes.alpha ?? []).not.toContain("Sources/alpha/");
		expect(h.excludes()).toContain("Sources/alpha/.git/");

		// And the other way: on, then off while a sync is mid-reconcile.
		const hold2 = h.holdNextRead("bravo/.gitignore");
		const running2 = h.sourcesFolder.sync(h.tephra.sources);
		await hold2.arrived;
		h.settings.tephraSourceSettings.alpha = { showInSearch: false };
		const flipped2 = h.sourcesFolder.resync();
		hold2.release();
		await Promise.all([running2, flipped2]);
		await h.sourcesFolder.whenIdle();
		expect(h.excludes()).toContain("Sources/alpha/");
		expect(h.settings.tephraExcludes.alpha).toContain("Sources/alpha/");

		// Tracked, so turning the toggle off removes it with the rest of Atlas's own.
		await h.controller.setEnabled(false);
		expect(h.excludes()).toEqual([]);
	});

	it("R4: with the source's .gitignore unreadable (its drive unplugged), turning Show in search back on still drops Sources/<name>/", async () => {
		const h = build({ sourceSettings: { whoop: { showInSearch: false } } });
		const root = h.addSource("whoop", { ".gitignore": "target/\n" });
		await turnOn(h);
		expect(h.excludes()).toContain("Sources/whoop/");
		rmSync(root, { recursive: true, force: true }); // unplugged: the link dangles, the .gitignore can't be read
		h.settings.tephraSourceSettings.whoop = { showInSearch: true };
		await h.sourcesFolder.resync();
		expect(h.excludes()).not.toContain("Sources/whoop/");
		expect(h.excludes()).toContain("Sources/whoop/target/"); // what came from the .gitignore stays until it can be read again
	});

	it("a source with Show in search off from the start gets Sources/<name>/ with its link", async () => {
		const h = build({ sourceSettings: { whoop: { showInSearch: false } } });
		h.addSource("whoop");
		await turnOn(h);
		expect(h.excludes()).toContain("Sources/whoop/");
	});

	it("names with . - _ and a 100-character name all link", async () => {
		const h = build();
		const names = ["my.repo", "my-repo", "my_repo", "n".repeat(100)];
		for (const name of names) h.addSource(name);
		await turnOn(h);
		for (const name of names) expect(isLink(h.linkPath(name)), name).toBe(true);
		expect(h.notices).toEqual([]);
	});
});

describe("toggle lifecycle", () => {
	it("on while Tephra is offline creates nothing; it links when the client comes online", async () => {
		const h = build();
		h.addSource("tephra");
		h.tephra.online = false;
		await turnOn(h);
		expect(existsSync(join(h.vault, "Sources"))).toBe(false);
		expect(existsSync(join(h.vault, ".gitignore"))).toBe(false);
		expect(h.fsCalls.filter((c) => c.startsWith("symlink") || c.startsWith("mkdir") || c.startsWith("appendFile"))).toEqual([]);

		h.tephra.online = true;
		h.tick(); // the 10 s check
		await h.settle();
		expect(isLink(h.linkPath("tephra"))).toBe(true);
	});

	it("off unlinks every link through lstat+unlink, removes the empty Sources/, removes only Atlas's excludes, keeps the .gitignore line, and every source file is byte-identical", async () => {
		const h = build();
		h.app.vault.setConfig("userIgnoreFilters", ["Private/"]);
		h.addSource("tephra", { ".gitignore": "target/\n", "README.md": "# t", "target/out.bin": "bin", ".git/HEAD": "ref" });
		h.addSource("whoop", { "Workout Plan.md": "plan" });
		await turnOn(h);
		const before = snapshot(join(tmp, "src"));
		expect(Object.keys(before).length).toBeGreaterThan(3);
		h.fsCalls.length = 0;

		await h.controller.setEnabled(false);

		expect(existsSync(join(h.vault, "Sources"))).toBe(false);
		expect(snapshot(join(tmp, "src"))).toEqual(before);
		expect(h.excludes()).toEqual(["Private/"]);
		expect(h.settings.tephraLinks).toEqual({});
		expect(h.settings.tephraExcludes).toEqual({});
		expect(readFileSync(join(h.vault, ".gitignore"), "utf8")).toBe("Sources/\n");
		expect(h.settings.tephraEnabled).toBe(false);
		// The only removals are unlink of a link (after lstat) and rmdir of the folder.
		const destructive = h.fsCalls.filter((c) => /^(unlink|rmdir|symlink|mkdir|appendFile) /.test(c));
		expect(destructive).toEqual([`unlink ${h.linkPath("tephra")}`, `unlink ${h.linkPath("whoop")}`, `rmdir ${join(h.vault, "Sources")}`]);
		for (const unlinkCall of h.fsCalls.filter((c) => c.startsWith("unlink "))) {
			const lstatIndex = h.fsCalls.indexOf(`lstat ${unlinkCall.slice(7)}`);
			expect(lstatIndex).toBeGreaterThanOrEqual(0);
			expect(lstatIndex).toBeLessThan(h.fsCalls.indexOf(unlinkCall));
		}
	});

	it("off leaves a Sources/ that holds something of the user's, and never removes a real folder named like a source", async () => {
		const h = build();
		h.addSource("tephra");
		await turnOn(h);
		write(join(h.vault, "Sources", "My notes.md"), "mine");
		await h.controller.setEnabled(false);
		expect(isLink(h.linkPath("tephra"))).toBe(false);
		expect(readFileSync(join(h.vault, "Sources", "My notes.md"), "utf8")).toBe("mine");
	});

	it("off does not follow or remove a record whose entry became a real folder", async () => {
		const h = build();
		h.addSource("tephra");
		await turnOn(h);
		unlinkSync(h.linkPath("tephra")); // Dan replaced the link by hand...
		write(join(h.linkPath("tephra"), "keep.md"), "mine"); // ...with a real folder
		await h.controller.setEnabled(false);
		expect(readFileSync(join(h.linkPath("tephra"), "keep.md"), "utf8")).toBe("mine");
		expect(h.settings.tephraLinks).toEqual({});
	});

	it("E8: unloading changes nothing: links, .gitignore line and Excluded entries stay, and nothing syncs afterwards", async () => {
		const h = build();
		h.addSource("tephra", { ".gitignore": "target/\n" });
		await turnOn(h);
		const excludesBefore = [...h.excludes()];
		const recordsBefore = JSON.stringify([h.settings.tephraLinks, h.settings.tephraExcludes]);

		h.sourcesFolder.dispose();
		h.controller.dispose();
		h.addSource("late"); // a source appearing after unload
		await h.connection.check().catch(() => {});
		await h.sourcesFolder.sync(h.tephra.sources);
		await h.sourcesFolder.whenIdle();

		expect(isLink(h.linkPath("tephra"))).toBe(true);
		expect(isLink(h.linkPath("late"))).toBe(false);
		expect(readFileSync(join(h.vault, ".gitignore"), "utf8")).toBe("Sources/\n");
		expect(h.excludes()).toEqual(excludesBefore);
		expect(JSON.stringify([h.settings.tephraLinks, h.settings.tephraExcludes])).toBe(recordsBefore);
		expect(h.settings.tephraEnabled).toBe(true);
	});

	it("turning it back on after off links again", async () => {
		const h = build();
		h.addSource("tephra");
		await turnOn(h);
		await h.controller.setEnabled(false);
		await turnOn(h);
		expect(isLink(h.linkPath("tephra"))).toBe(true);
	});

	it("mobile: no filesystem call at all, and no config write", async () => {
		const h = build({ mobile: true });
		h.addSource("tephra");
		await h.controller.setEnabled(true);
		await h.sourcesFolder.sync(h.tephra.sources);
		await h.sourcesFolder.teardown();
		expect(await h.sourcesFolder.checkCanEnable()).toEqual({ ok: true });
		expect(h.fsCalls).toEqual([]);
		expect(h.app.vault.getConfig("userIgnoreFilters")).toBeUndefined();
	});
});

describe("E13: refusing to start over a Sources/ Atlas doesn't own", () => {
	it("a real Sources folder with a note: refused with a Notice naming the path, the toggle stays off, nothing moves", async () => {
		const h = build();
		write(join(h.vault, "Sources", "Reading list.md"), "mine");
		h.addSource("tephra");
		const before = snapshot(h.vault);
		await h.controller.setEnabled(true);
		expect(h.settings.tephraEnabled).toBe(false);
		expect(h.notices.join("\n")).toMatch(/refused: Sources: .*Reading list\.md/);
		expect(snapshot(h.vault)).toEqual(before);
		expect(readdirSync(join(h.vault, "Sources"))).toEqual(["Reading list.md"]);
		expect(existsSync(join(h.vault, ".gitignore"))).toBe(false);
		expect(h.excludes()).toEqual([]);
		expect(h.connection.isRunning()).toBe(false);
		expect(h.fsCalls.every((c) => /^(lstat|readdir) /.test(c))).toBe(true);
	});

	it("a file called Sources is refused; Sources.md is fine", async () => {
		const h = build();
		write(join(h.vault, "Sources"), "i am a file");
		h.addSource("tephra");
		await h.controller.setEnabled(true);
		expect(h.settings.tephraEnabled).toBe(false);
		expect(readFileSync(join(h.vault, "Sources"), "utf8")).toBe("i am a file");

		const ok = build({ dir: "vault-ok" });
		write(join(ok.vault, "Sources.md"), "note");
		ok.addSource("tephra");
		await turnOn(ok);
		expect(ok.settings.tephraEnabled).toBe(true);
		expect(isLink(ok.linkPath("tephra"))).toBe(true);
	});

	it("an empty Sources/ from a previous run, and a reload with links in place and recorded, are accepted", async () => {
		const h = build();
		mkdirSync(join(h.vault, "Sources"));
		h.addSource("tephra");
		await turnOn(h);
		expect(isLink(h.linkPath("tephra"))).toBe(true);

		// Reload: a fresh plugin with the same records and the links still on disk.
		const again = build({ dir: "vault-again" });
		again.settings.tephraLinks = { ...h.settings.tephraLinks };
		mkdirSync(join(again.vault, "Sources"), { recursive: true });
		symlinkSync(join(tmp, "src", "tephra"), join(again.vault, "Sources", "tephra"));
		expect(await again.sourcesFolder.checkCanEnable()).toEqual({ ok: true });
	});

	it("a link in Sources/ that Atlas didn't record is refused", async () => {
		const h = build();
		mkdirSync(join(h.vault, "Sources"));
		symlinkSync(tmp, join(h.vault, "Sources", "stray"));
		h.addSource("tephra");
		await h.controller.setEnabled(true);
		expect(h.settings.tephraEnabled).toBe(false);
	});
});

describe("E2 / E6 / sync serialisation", () => {
	it("E2: a real entry named like a source skips only that link, with a Notice, and leaves the entry alone", async () => {
		const h = build();
		await turnOn(h); // Sources/ is Atlas's from here
		write(join(h.vault, "Sources", "whoop", "mine.md"), "mine");
		h.addSource("tephra");
		h.addSource("whoop");
		h.pushGraphChanged();
		await h.settle();
		expect(isLink(h.linkPath("tephra"))).toBe(true);
		expect(isLink(h.linkPath("whoop"))).toBe(false);
		expect(readFileSync(join(h.linkPath("whoop"), "mine.md"), "utf8")).toBe("mine");
		expect(h.notices.filter((n) => n.includes("whoop"))).toHaveLength(1);
		h.tick();
		await h.settle();
		expect(h.notices.filter((n) => n.includes("whoop"))).toHaveLength(1); // not repeated every 10 s
	});

	it("E6: a graph:changed push alone (no check asked for by the test, no 10 s tick, no focus) creates and removes the link", async () => {
		const h = build();
		h.addSource("tephra");
		await turnOn(h);

		h.addSource("recipes");
		h.pushGraphChanged(); // a graph:changed arriving over the push channel; nothing else triggers a check here
		await vi.waitFor(() => expect(isLink(h.linkPath("recipes"))).toBe(true));

		h.tephra.sources = h.tephra.sources.filter((s) => s.name !== "recipes");
		h.pushGraphChanged();
		await vi.waitFor(() => expect(isLink(h.linkPath("recipes"))).toBe(false));
		expect(h.settings.tephraLinks.recipes).toBeUndefined();
	});

	it("E6/C5: a graph:changed push alone brings a .gitignore edit into Excluded files", async () => {
		const h = build();
		const root = h.addSource("tephra", { ".gitignore": "target/\n" });
		await turnOn(h);
		writeFileSync(join(root, ".gitignore"), "dist/\n");
		h.pushGraphChanged();
		await vi.waitFor(() => expect(h.excludes()).toContain("Sources/tephra/dist/"));
		expect(h.excludes()).not.toContain("Sources/tephra/target/");
	});

	// E6 is met in two bounds (see TASKS.md, "Atlas-22 PR-3: E6"). Atlas's half: a `graph:changed` push is
	// followed at once (within 5 s). What Tephra dev b04c1cf does: `source.register` / `source.unregister`
	// broadcast no `graph:changed`, so a `tephractl` add/remove is caught by the next 10 s check (within 12 s)
	// or on focus. This test pins both with a fake client; it does not claim real Tephra sends a push.
	it("E6: a source add/remove is followed on a push, and with no push (what real Tephra does today) on the 10 s check", async () => {
		const h = build();
		h.addSource("tephra");
		await turnOn(h);

		h.addSource("recipes");
		h.pushGraphChanged();
		await h.settle();
		expect(isLink(h.linkPath("recipes"))).toBe(true);

		h.tephra.sources = h.tephra.sources.filter((s) => s.name !== "recipes");
		h.pushGraphChanged();
		await h.settle();
		expect(isLink(h.linkPath("recipes"))).toBe(false);

		// No push at all (what real Tephra sends for register/unregister): the link waits for the 10 s tick.
		// (`h.settle()` runs a check itself, so only wait for already-queued work here.)
		h.addSource("later");
		await h.sourcesFolder.whenIdle();
		expect(isLink(h.linkPath("later"))).toBe(false);
		h.tick();
		await h.settle();
		expect(isLink(h.linkPath("later"))).toBe(true);

		h.tephra.sources = h.tephra.sources.filter((s) => s.name !== "later");
		await h.sourcesFolder.whenIdle();
		expect(isLink(h.linkPath("later"))).toBe(true);
		h.tick();
		await h.settle();
		expect(isLink(h.linkPath("later"))).toBe(false);
	});

	it("two triggers at once (toggle on + graph:changed + the 10 s tick) make one link and no EEXIST", async () => {
		const h = build();
		h.addSource("tephra");
		h.addSource("whoop");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await h.controller.setEnabled(true);
		const sources = h.tephra.sources;
		await Promise.all([h.sourcesFolder.sync(sources), h.sourcesFolder.sync(sources), h.connection.check(), h.sourcesFolder.sync(sources)]);
		h.pushGraphChanged();
		h.tick();
		await h.settle();
		expect(errors).not.toHaveBeenCalled();
		expect(h.notices).toEqual([]);
		expect(readdirSync(join(h.vault, "Sources")).sort()).toEqual(["tephra", "whoop"]);
		expect(h.fsCalls.filter((c) => c.startsWith("symlink ")).length).toBe(2);
	});

	it("a changed root replaces the link; a stale link with no source goes; a link Dan deleted comes back", async () => {
		const h = build();
		h.addSource("a");
		h.addSource("b");
		await turnOn(h);

		const newRoot = join(tmp, "src", "a-moved");
		mkdirSync(newRoot, { recursive: true });
		h.tephra.sources = h.tephra.sources.map((s) => (s.name === "a" ? { ...s, path: newRoot } : s));
		unlinkSync(h.linkPath("b")); // Dan deleted it by hand
		h.pushGraphChanged();
		await h.settle();
		expect(readlinkSync(h.linkPath("a"))).toBe(newRoot);
		expect(readlinkSync(h.linkPath("b"))).toBe(join(tmp, "src", "b"));

		h.tephra.sources = h.tephra.sources.filter((s) => s.name !== "a");
		h.pushGraphChanged();
		await h.settle();
		expect(existsSync(h.linkPath("a"))).toBe(false);
		expect(isLink(h.linkPath("b"))).toBe(true);
	});

	it("never creates a link outside Sources/ for a hostile source name", async () => {
		const h = build();
		const root = h.addSource("ok");
		h.tephra.sources.push({ name: "../escape", path: root, status: "online" }, { name: "a/b", path: root, status: "online" });
		await turnOn(h);
		expect(readdirSync(join(h.vault, "Sources"))).toEqual(["ok"]);
		expect(existsSync(join(h.vault, "escape"))).toBe(false);
	});

	it("a hand-edited tephraLinks record can't unlink anything outside Sources/", async () => {
		const h = build();
		write(join(h.vault, "precious.md"), "keep");
		h.settings.tephraLinks = normalizeTephraLinks({ "../precious.md": "/x", ok: "/x" });
		expect(h.settings.tephraLinks).toEqual({ ok: "/x" });
		expect(normalizeTephraLinks({ a: "relative", b: 3, "__proto__": "/x" })).toEqual({});
		expect(normalizeTephraExcludes({ a: ["x", 3, ""], "a/b": ["y"], c: "no" })).toEqual({ a: ["x"] });
		h.sourcesFolder.start();
		await h.sourcesFolder.teardown();
		expect(readFileSync(join(h.vault, "precious.md"), "utf8")).toBe("keep");
	});
});

describe("R3-4: deletes that Atlas or a missing source caused, through the real plugin handler", () => {
	function plugin(h: Harness, files: string[]) {
		const p = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		const app = h.app;
		for (const f of files) {
			const parts = f.split("/");
			for (let i = 1; i < parts.length; i++) if (!app.vault.getAbstractFileByPath(parts.slice(0, i).join("/"))) app.vault.seedFolder(parts.slice(0, i).join("/"));
			app.vault.seedFile(f);
		}
		const viewsManager = new ViewsManager(app as unknown as ObsidianApp, [], "", () => {});
		const unitIndex = new UnitIndex(app as unknown as ObsidianApp, h.settings, []);
		const graduationDeletes: string[] = [];
		const renames: string[] = [];
		Object.assign(p, {
			app,
			settings: h.settings,
			viewsManager,
			unitIndex,
			sourceDeleteClassifier: h.classifier,
			graduation: { handleDelete: (f: { path: string }) => graduationDeletes.push(f.path) },
			externalMoveDetector: new ExternalMoveDetector(),
			folderLiveRefresh: new FolderLiveRefresh(() => {}),
			persistDebounced: Object.assign(() => {}, { cancel: () => {}, run: () => {} }),
		});
		(p as unknown as { onVaultRenameEvent: (f: unknown, old: string) => void }).onVaultRenameEvent = (_f, old) => void renames.push(old);
		app.vault.on("delete", (file: unknown) => p.onVaultDeleteEvent(file as never));
		app.vault.on("create", (file: unknown) => p.onVaultCreateEvent(file as never));
		return { p, viewsManager, unitIndex, graduationDeletes, renames };
	}

	/** A view node whose item points at `path`; `noteRef` is what a real delete clears. */
	function placeItem(vm: ViewsManager, path: string) {
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Holder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "Workout Plan", kind: "placeholder", noteRef: { kind: "file", path } } as never };
		node.apiItemOrder = ["1"];
		return { view, node, noteRef: () => vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef };
	}

	it("toggle off: the unlinks' deletes are expected, so views keep their refs and a same-named vault file is not a move", async () => {
		const h = build();
		h.addSource("whoop", { "Workout Plan.md": "plan" });
		await turnOn(h);
		const ctx = plugin(h, ["Sources/whoop/Workout Plan.md", "Notes/Other.md"]);
		const placed = placeItem(ctx.viewsManager, "Sources/whoop/Workout Plan.md");
		const viewsBefore = JSON.stringify(ctx.viewsManager.getViews());

		await h.controller.setEnabled(false);
		// Obsidian reports the deletes after the setting has already gone off.
		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Sources/whoop/Workout Plan.md")!);
		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Sources/whoop")!, true);

		expect(placed.noteRef()).toEqual({ kind: "file", path: "Sources/whoop/Workout Plan.md" });
		expect(JSON.stringify(ctx.viewsManager.getViews())).toBe(viewsBefore);
		expect(ctx.graduationDeletes).toEqual([]);

		h.app.vault.seedFolder("Notes2");
		await h.app.vault.create("Notes2/Workout Plan.md", "x"); // same name, soon after
		expect(ctx.renames).toEqual([]); // not treated as a move
	});

	it("a source whose folder was deleted is missing: its deletes bypass every handler, and its view entry survives", async () => {
		const h = build();
		const root = h.addSource("whoop", { "Workout Plan.md": "plan" });
		await turnOn(h);
		const ctx = plugin(h, ["Sources/whoop/Workout Plan.md"]);
		const placed = placeItem(ctx.viewsManager, "Sources/whoop/Workout Plan.md");

		rmSync(root, { recursive: true, force: true }); // drive unplugged: the link now dangles
		expect(isLink(h.linkPath("whoop"))).toBe(true);
		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Sources/whoop/Workout Plan.md")!);

		expect(placed.noteRef()).toEqual({ kind: "file", path: "Sources/whoop/Workout Plan.md" });
		expect(ctx.graduationDeletes).toEqual([]);
		expect(isLink(h.linkPath("whoop"))).toBe(true); // the dangling link is kept

		// The folder returns: the link works again with no change on Atlas's side.
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "Workout Plan.md"), "plan");
		h.pushGraphChanged();
		await h.settle();
		expect(readFileSync(join(h.linkPath("whoop"), "Workout Plan.md"), "utf8")).toBe("plan");
		expect(h.settings.tephraLinks).toEqual({ whoop: root });
	});

	it("a real delete inside a linked, present source is a normal delete; Sources/whoopx is not Sources/whoop", async () => {
		const h = build();
		h.addSource("whoop", { "Leg Day.md": "x" });
		h.addSource("whoopx", { "Leg Day.md": "x" });
		await turnOn(h);
		const ctx = plugin(h, ["Sources/whoop/Leg Day.md", "Sources/whoopx/Leg Day.md"]);
		const a = placeItem(ctx.viewsManager, "Sources/whoop/Leg Day.md");
		const b = placeItem(ctx.viewsManager, "Sources/whoopx/Leg Day.md");

		h.classifier.expectPrefix("Sources/whoop"); // Atlas is unlinking whoop...
		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Sources/whoopx/Leg Day.md")!); // ...Dan deletes in whoopx
		expect(b.noteRef()).toBeUndefined(); // real delete: noteRef cleared as always
		expect(ctx.graduationDeletes).toEqual(["Sources/whoopx/Leg Day.md"]);

		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Sources/whoop/Leg Day.md")!);
		expect(a.noteRef()).toEqual({ kind: "file", path: "Sources/whoop/Leg Day.md" }); // expected: untouched
	});

	it("a vault file outside Sources/ deleted as usual still clears its noteRef (F10)", async () => {
		const h = build();
		await turnOn(h);
		const ctx = plugin(h, ["Notes/Idea.md"]);
		const placed = placeItem(ctx.viewsManager, "Notes/Idea.md");
		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Notes/Idea.md")!);
		expect(placed.noteRef()).toBeUndefined();
	});

	it("R3: turning Show in search off registers no expected delete: a note Dan deletes in that source right after is a real delete", async () => {
		const h = build();
		h.addSource("whoop", { "Workout Plan.md": "plan" });
		await turnOn(h);
		const ctx = plugin(h, ["Sources/whoop/Workout Plan.md"]);
		const placed = placeItem(ctx.viewsManager, "Sources/whoop/Workout Plan.md");

		h.settings.tephraSourceSettings.whoop = { showInSearch: false };
		await h.sourcesFolder.resync();
		expect(h.excludes()).toContain("Sources/whoop/");
		// Obsidian keeps an excluded file in the vault, so nothing was expected: this is Dan deleting the note.
		expect(h.classifier.classify("Sources/whoop/Workout Plan.md")).toBe("real");
		await h.app.vault.delete(h.app.vault.getAbstractFileByPath("Sources/whoop/Workout Plan.md")!);
		expect(placed.noteRef()).toBeUndefined(); // the normal delete handlers ran
		expect(ctx.graduationDeletes).toEqual(["Sources/whoop/Workout Plan.md"]);
	});

	it("R3: a .gitignore entry added later (a whole-folder pattern too) registers no expected delete either", async () => {
		const h = build();
		const root = h.addSource("whoop", { "Workout Plan.md": "plan", ".gitignore": "*.log\n" });
		await turnOn(h);
		writeFileSync(join(root, ".gitignore"), "*.log\n*\n".replace("*\n", "**/\n"));
		h.pushGraphChanged();
		await h.settle();
		expect(h.classifier.classify("Sources/whoop/Workout Plan.md")).toBe("real");
		expect(h.classifier.classify("Sources/whoop/sub/Leg Day.md")).toBe("real");
	});

	it("R2: flipping the toggle rebuilds the unit index through the controller, in both directions", async () => {
		const h = build();
		const ctx = plugin(h, ["Sources/Mine.md", "Notes/A.md"]); // a Sources/ that exists while the toggle is off
		const refreshed: number[] = [];
		Object.assign(ctx.p, {
			sourcesFolder: h.sourcesFolder,
			sourceLinks: { getMode: () => "live", sync: () => {} },
			// PR-8: the two collaborators `onTephraToggled` also drives (their own tests are in promotion-offline-parity and backlinks-tephra-section).
			tephraGraphSync: { unbind: () => {} },
			tephraBacklinks: { refresh: () => {} },
			refreshExplorerViews: () => void refreshed.push(1),
		});
		h.hooks.afterChange = (enabled) => ctx.p.onTephraToggled(enabled);
		const folderUnitPaths = () => ctx.unitIndex.getUnits().filter((u) => u.type === "folder-unit").map((u) => u.path).sort();

		ctx.unitIndex.rebuild();
		expect(folderUnitPaths()).toEqual(["Notes", "Sources"]); // off: an ordinary module

		await h.controller.setEnabled(true); // not a hand-called rebuild(): the controller's own afterChange
		expect(folderUnitPaths()).toEqual(["Notes"]);
		expect(refreshed).toHaveLength(1);

		await h.controller.setEnabled(false);
		expect(folderUnitPaths()).toEqual(["Notes", "Sources"]); // the leftover user folder is a module again
		expect(refreshed).toHaveLength(2);
	});

	it("a deleted file in the unit index stays a unit-less path: Sources never reaches promotions", async () => {
		const h = build();
		await turnOn(h);
		const ctx = plugin(h, ["Sources/whoop/a.md"]);
		ctx.unitIndex.rebuild();
		expect(ctx.unitIndex.getUnits().some((u) => u.path.startsWith("Sources"))).toBe(false);
	});
});

describe("wiring in main.ts (the pieces the harness above mirrors)", () => {
	const main = readFileSync(join(__dirname, "../../src/main.ts"), "utf8");
	const rel = (p: string): string => readFileSync(join(__dirname, "../..", p), "utf8");

	it("main.ts registers the teardown step, asks beforeEnable, feeds every check into sync, and asks for a check on focus", () => {
		expect(main).toMatch(/registerTephraTeardown\(\{ name: "Sources folder links", run: \(\) => this\.sourcesFolder\.teardown\(\) \}\)/);
		expect(main).toMatch(/beforeEnable: async \(\) => \{[\s\S]*checkCanEnable\(\)/);
		expect(main).toMatch(/connection\.onCheck\(\(snapshot\) => \{\s*if \(snapshot\.state === "online"\) void this\.sourcesFolder\.sync\(snapshot\.sources\)/);
		expect(main).toMatch(/registerDomEvent\(window, "focus", \(\) => this\.tephraConnection\?\.requestCheck\(\)\)/);
		expect(main).toMatch(/this\.sourcesFolder\?\.dispose\(\)/);
		// R1: the connection is built with a client that can open Tephra's push channel, and the toggle flip rebuilds the index.
		expect(main).toMatch(/new TephraClient\(\{ request: obsidianTephraRequest, openSocket: openNodeWebSocket, url \}\)/);
		// The scratch-port override goes through the loopback-only resolver, never straight from data.json to the client.
		expect(main).toMatch(/const url = resolveTephraRpcUrl\(this\.settings\.tephraUrl\)/);
		expect(main).toMatch(/afterChange: \(enabled\) => this\.onTephraToggled\(enabled\)/);
	});

	it("the delete handler classifies before any of the four handlers run, and the toggle-off path is the only caller of teardown", () => {
		const handler = main.slice(main.indexOf("onVaultDeleteEvent(file"));
		const classify = handler.indexOf("sourceDeleteClassifier.classify");
		for (const call of ["unitIndex.onVaultDelete(", "graduation.handleDelete(", "viewsManager.onVaultDelete(", "externalMoveDetector.onDelete("]) {
			expect(classify, call).toBeGreaterThan(-1);
			expect(handler.indexOf(call), call).toBeGreaterThan(classify);
		}
		const callers = ["main.ts", "settings.ts", "tephra-controller.ts", "sources-folder.ts"].filter((f) => /\.teardown\(\)/.test(rel(`src/${f}`)));
		expect(callers).toEqual(["main.ts"]); // only the registered step, which the controller's off path runs
	});

	it("F2/F3: no adapter patch, no synthetic TFile, and no vault delete/trash/recursive removal in the Sources code", () => {
		for (const file of ["sources-folder.ts", "sources-links.ts", "sources-fs.ts", "source-excludes.ts", "source-delete-classifier.ts", "vault-gitignore.ts", "sources-path.ts"]) {
			const text = rel(`src/${file}`).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n"); // whole-line comments may name what is forbidden
			expect(text, file).not.toMatch(/adapter\.|new TFile|vault\.delete|vault\.trash|trashFile|recursive|\brmSync\b|promises\.rm\b|\bfs\.rm\b|rename\(/);
		}
	});

	it("F3: the only files the Sources code writes are the .gitignore, and links/folders; Excluded files go through setConfig", () => {
		const writers = ["sources-folder.ts", "sources-links.ts", "source-excludes.ts", "vault-gitignore.ts"].flatMap((f) => (rel(`src/${f}`).match(/\.(appendFile|writeFile|symlink|mkdir)\(/g) ?? []).map((m) => `${f}:${m}`));
		expect(new Set(writers)).toEqual(new Set(["sources-folder.ts:.mkdir(", "sources-folder.ts:.symlink(", "vault-gitignore.ts:.appendFile("]));
	});
});
