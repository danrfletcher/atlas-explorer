import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS, type AtlasSettings } from "../../src/settings";
import { SourceLinkController } from "../../src/source-link-controller";
import { TephraConnection, type TephraConnectionClient } from "../../src/tephra-connection";
import { TephraController, type TephraControllerDeps } from "../../src/tephra-controller";
import { TephraTeardownRegistry, registerTephraTeardown, runTephraTeardown, tephraTeardown } from "../../src/tephra-teardown";

beforeEach(() => {
	vi.useFakeTimers();
	tephraTeardown.clear();
});
afterEach(() => {
	vi.useRealTimers();
	tephraTeardown.clear();
});

describe("TephraTeardownRegistry", () => {
	it("runs steps in registration order, each finishing before the next starts", async () => {
		const log: string[] = [];
		const registry = new TephraTeardownRegistry();
		registry.register({
			name: "slow first",
			run: async () => {
				log.push("first:start");
				await Promise.resolve();
				await Promise.resolve();
				log.push("first:end");
			},
		});
		registry.register({ name: "second", run: () => void log.push("second") });
		registry.register({ name: "third", run: async () => void log.push("third") });
		expect(registry.names()).toEqual(["slow first", "second", "third"]);
		expect(await registry.run()).toEqual([]);
		expect(log).toEqual(["first:start", "first:end", "second", "third"]);
	});

	it("a throwing or rejecting step is reported and every later step still runs", async () => {
		const log: string[] = [];
		const registry = new TephraTeardownRegistry();
		const boom = new Error("boom");
		registry.register({ name: "a", run: () => void log.push("a") });
		registry.register({
			name: "b",
			run: () => {
				throw boom;
			},
		});
		registry.register({ name: "c", run: () => Promise.reject(new Error("later")) });
		registry.register({ name: "d", run: () => void log.push("d") });
		const failures = await registry.run();
		expect(log).toEqual(["a", "d"]);
		expect(failures.map((f) => f.name)).toEqual(["b", "c"]);
		expect(failures[0].error).toBe(boom);
	});

	it("steps stay registered after a run, and register() returns an unregister function", async () => {
		const registry = new TephraTeardownRegistry();
		const run = vi.fn();
		const remove = registry.register({ name: "x", run });
		await registry.run();
		await registry.run();
		expect(run).toHaveBeenCalledTimes(2);
		remove();
		await registry.run();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("with no steps registered, a run finishes cleanly", async () => {
		expect(await new TephraTeardownRegistry().run()).toEqual([]);
	});

	it("registerTephraTeardown / runTephraTeardown use the plugin-wide registry", async () => {
		const run = vi.fn();
		registerTephraTeardown({ name: "global", run });
		expect(tephraTeardown.names()).toEqual(["global"]);
		await runTephraTeardown();
		expect(run).toHaveBeenCalledTimes(1);
	});
});

/** A controller wired to fakes, with every side effect written to one ordered log. */
function harness(initial: { enabled: boolean; mobile?: boolean }) {
	const log: string[] = [];
	const settings = { tephraEnabled: initial.enabled };
	const rpcMethods: string[] = [];
	const client: TephraConnectionClient = {
		listSources: async () => {
			rpcMethods.push("source.list");
			return { ok: true, sources: [] };
		},
		call: async (method) => {
			rpcMethods.push(method);
			return { ok: true, result: null };
		},
	};
	const connections: TephraConnection[] = [];
	const deps: TephraControllerDeps = {
		getEnabled: () => settings.tephraEnabled,
		setEnabled: (enabled) => {
			settings.tephraEnabled = enabled;
			log.push(`setting:${enabled}`);
		},
		save: async () => void log.push(`save:${settings.tephraEnabled}`),
		isMobile: () => initial.mobile ?? false,
		createConnection: () => {
			const connection = new TephraConnection(client);
			const stop = connection.stop.bind(connection);
			connection.stop = () => {
				log.push("connection:stop");
				stop();
			};
			connections.push(connection);
			return connection;
		},
		reportTeardownFailures: (failures) => log.push(`reported:${failures.map((f) => f.name).join(",")}`),
		afterChange: (enabled) => log.push(`after:${enabled}`),
	};
	const controller = new TephraController(deps);
	return { controller, settings, log, rpcMethods, connections, deps };
}

describe("TephraController: the toggle's off path", () => {
	it("runs every registered step in order, then saves false, then stops the client — and never unregisters a source", async () => {
		const h = harness({ enabled: true });
		const order: string[] = [];
		registerTephraTeardown({ name: "one", run: () => void h.log.push("step:one") });
		registerTephraTeardown({ name: "two", run: async () => void h.log.push("step:two") });
		registerTephraTeardown({ name: "three", run: () => void order.push("three") });
		h.controller.startIfEnabled();
		await vi.advanceTimersByTimeAsync(0);
		h.log.length = 0;
		const connection = h.controller.getConnection()!;

		await h.controller.setEnabled(false);

		expect(h.log).toEqual(["step:one", "step:two", "setting:false", "save:false", "connection:stop", "after:false"]);
		expect(order).toEqual(["three"]);
		expect(h.settings.tephraEnabled).toBe(false);
		expect(connection.getSnapshot().state).toBe("off");
		expect(h.controller.getConnection()).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		expect(h.rpcMethods.every((m) => m === "source.list")).toBe(true); // no source.unregister, nothing else
		expect(h.rpcMethods).not.toContain("source.unregister");
	});

	it("with no steps registered, turning off still finishes cleanly", async () => {
		const h = harness({ enabled: true });
		h.controller.startIfEnabled();
		await h.controller.setEnabled(false);
		expect(h.settings.tephraEnabled).toBe(false);
		expect(h.log).toContain("save:false");
		expect(h.controller.getConnection()).toBeNull();
	});

	it("a throwing step is reported, the rest still run, and the toggle still goes off", async () => {
		const h = harness({ enabled: true });
		const after = vi.fn();
		registerTephraTeardown({
			name: "broken",
			run: () => {
				throw new Error("nope");
			},
		});
		registerTephraTeardown({ name: "after", run: after });
		h.controller.startIfEnabled();
		await h.controller.setEnabled(false);
		expect(after).toHaveBeenCalledTimes(1);
		expect(h.log).toContain("reported:broken");
		expect(h.settings.tephraEnabled).toBe(false);
		expect(h.log).toContain("save:false");
		expect(h.log).toContain("connection:stop");
	});

	it("turning on runs no teardown step", async () => {
		const h = harness({ enabled: false });
		const step = vi.fn();
		registerTephraTeardown({ name: "s", run: step });
		await h.controller.setEnabled(true);
		expect(step).not.toHaveBeenCalled();
		expect(h.settings.tephraEnabled).toBe(true);
		expect(h.log).toEqual(["setting:true", "save:true", "after:true"]);
		expect(h.controller.getConnection()?.isRunning()).toBe(true);
	});
});

describe("TephraController: the toggle is off or on mobile", () => {
	it("with the toggle off nothing is built: no connection, no timer, no RPC call", async () => {
		const h = harness({ enabled: false });
		h.controller.startIfEnabled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.connections).toHaveLength(0);
		expect(h.controller.getConnection()).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		expect(h.rpcMethods).toEqual([]);
	});

	it("on mobile a saved `true` builds nothing, and setEnabled does nothing", async () => {
		const h = harness({ enabled: true, mobile: true });
		h.controller.startIfEnabled();
		await h.controller.setEnabled(true);
		await h.controller.setEnabled(false);
		expect(h.connections).toHaveLength(0);
		expect(h.log).toEqual([]);
		expect(h.settings.tephraEnabled).toBe(true); // the synced value is left alone
		expect(vi.getTimerCount()).toBe(0);
	});

	it("with the toggle on, startIfEnabled builds one connection that checks right away", async () => {
		const h = harness({ enabled: true });
		h.controller.startIfEnabled();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.connections).toHaveLength(1);
		expect(h.rpcMethods).toEqual(["source.list"]);
		expect(vi.getTimerCount()).toBe(1);
	});
});

describe("TephraController: rapid toggling", () => {
	it("5 flips within 1 s end in the last state, with at most one live timer and no check in flight after off", async () => {
		const h = harness({ enabled: false });
		const results: Promise<void>[] = [];
		const values = [true, false, true, false, true];
		for (const value of values) {
			results.push(h.controller.setEnabled(value));
			await vi.advanceTimersByTimeAsync(150);
			expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
		}
		await Promise.all(results);
		expect(h.settings.tephraEnabled).toBe(true);
		expect(h.controller.getConnection()?.isRunning()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);

		await h.controller.setEnabled(false);
		expect(h.settings.tephraEnabled).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		for (const connection of h.connections) expect(connection.isChecking()).toBe(false);
	});

	it("flips made in one tick collapse to the last value, applied once", async () => {
		const h = harness({ enabled: false });
		const all = [h.controller.setEnabled(true), h.controller.setEnabled(false), h.controller.setEnabled(true), h.controller.setEnabled(false), h.controller.setEnabled(true)];
		await Promise.all(all);
		expect(h.settings.tephraEnabled).toBe(true);
		expect(h.log.filter((l) => l.startsWith("save:"))).toEqual(["save:true"]);
		expect(h.connections).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);
	});

	it("a flip that arrives while a change is being applied is applied after it, and the last one wins", async () => {
		const h = harness({ enabled: true });
		h.controller.startIfEnabled();
		const slow = { release: () => {} };
		registerTephraTeardown({ name: "slow", run: () => new Promise<void>((resolve) => (slow.release = resolve)) });
		const off = h.controller.setEnabled(false); // waits inside the slow step
		const on = h.controller.setEnabled(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.settings.tephraEnabled).toBe(true); // not yet turned off: the step is still running
		slow.release();
		await Promise.all([off, on]);
		expect(h.settings.tephraEnabled).toBe(true);
		expect(h.controller.getConnection()?.isRunning()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		expect(h.log.filter((l) => l.startsWith("save:"))).toEqual(["save:false", "save:true"]);
	});
});

describe("E8: plugin unload runs no teardown step", () => {
	/** The same hand-assembled plugin `link-resolution-hook.test.ts` uses for its E8 case, with a real
	 * `TephraController` and connection added. */
	function pluginWithTephraOn() {
		const app = new App();
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: true };
		plugin.settings = settings;
		plugin.app = app as never;
		plugin.sourceLinks = new SourceLinkController(app, () => settings, undefined, () => {});
		const client: TephraConnectionClient = { listSources: async () => ({ ok: true, sources: [] }), call: async () => ({ ok: true, result: null }) };
		const save = vi.fn(async () => {});
		plugin.tephraController = new TephraController({
			getEnabled: () => settings.tephraEnabled,
			setEnabled: (enabled) => {
				settings.tephraEnabled = enabled;
			},
			save,
			isMobile: () => false,
			createConnection: () => new TephraConnection(client),
			reportTeardownFailures: () => {},
			afterChange: () => {},
		});
		plugin.outsideFolderWatchers = { closeAll: vi.fn() } as never;
		plugin.folderLiveRefresh = { cancelAll: vi.fn() } as never;
		plugin.linkSuggest = undefined as never;
		plugin.saveData = vi.fn();
		return { app, plugin, settings, save };
	}

	it("a registered spy step is never called; tephraEnabled and userIgnoreFilters stay; the timer is cleared", async () => {
		const { app, plugin, settings, save } = pluginWithTephraOn();
		const filters = ["Sources/whoop/", "my-own-entry/"];
		app.vault.config.userIgnoreFilters = [...filters];
		const spy = vi.fn();
		registerTephraTeardown({ name: "spy", run: spy });

		plugin.tephraController.startIfEnabled();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
		expect(plugin.tephraConnection).not.toBeNull();

		plugin.onunload();

		expect(spy).not.toHaveBeenCalled();
		expect(settings.tephraEnabled).toBe(true);
		expect(app.vault.config.userIgnoreFilters).toEqual(filters);
		expect(vi.getTimerCount()).toBe(0);
		expect(plugin.tephraConnection).toBeNull();
		expect(save).not.toHaveBeenCalled();
		expect(plugin.saveData).not.toHaveBeenCalled();
		expect(app.vault.calls).toEqual([]);
	});

	it("unloading while the toggle's save is still pending: when it resolves no connection or timer is built (R1)", async () => {
		const { plugin, settings, save } = pluginWithTephraOn();
		settings.tephraEnabled = false;
		const afterChange = vi.fn();
		const createConnection = vi.fn(() => new TephraConnection({ listSources: async () => ({ ok: true, sources: [] }), call: async () => ({ ok: true, result: null }) }));
		let release = () => {};
		save.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
		plugin.tephraController = new TephraController({
			getEnabled: () => settings.tephraEnabled,
			setEnabled: (enabled) => {
				settings.tephraEnabled = enabled;
			},
			save,
			isMobile: () => false,
			createConnection,
			reportTeardownFailures: () => {},
			afterChange,
		});

		const pending = plugin.tephraController.setEnabled(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(save).toHaveBeenCalledTimes(1);
		plugin.onunload();
		release();
		await pending;
		await vi.advanceTimersByTimeAsync(30_000);

		expect(createConnection).not.toHaveBeenCalled();
		expect(afterChange).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(plugin.tephraConnection).toBeNull();
	});

	it("a flip queued behind a pending change is dropped by an unload: no later connection, no teardown step (R1)", async () => {
		const { plugin, settings, save } = pluginWithTephraOn();
		settings.tephraEnabled = false;
		const spy = vi.fn();
		registerTephraTeardown({ name: "spy", run: spy });
		const createConnection = vi.fn(() => new TephraConnection({ listSources: async () => ({ ok: true, sources: [] }), call: async () => ({ ok: true, result: null }) }));
		let release = () => {};
		save.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
		plugin.tephraController = new TephraController({
			getEnabled: () => settings.tephraEnabled,
			setEnabled: (enabled) => {
				settings.tephraEnabled = enabled;
			},
			save,
			isMobile: () => false,
			createConnection,
			reportTeardownFailures: () => {},
			afterChange: () => {},
		});

		const on = plugin.tephraController.setEnabled(true);
		const off = plugin.tephraController.setEnabled(false); // queued behind the pending on
		await vi.advanceTimersByTimeAsync(0);
		plugin.onunload();
		release();
		await Promise.all([on, off]);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(spy).not.toHaveBeenCalled();
		expect(createConnection).not.toHaveBeenCalled();
		expect(save).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(plugin.tephraConnection).toBeNull();
	});

	it("setEnabled and startIfEnabled after an unload do nothing (R1)", async () => {
		const { plugin, settings, save } = pluginWithTephraOn();
		plugin.onunload();
		await plugin.tephraController.setEnabled(false);
		plugin.tephraController.startIfEnabled();
		await vi.advanceTimersByTimeAsync(0);
		expect(save).not.toHaveBeenCalled();
		expect(settings.tephraEnabled).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(plugin.tephraConnection).toBeNull();
	});

	it("after an unload, the next load (a fresh controller) connects again because the toggle is still on", async () => {
		const { plugin, settings } = pluginWithTephraOn();
		plugin.tephraController.startIfEnabled();
		plugin.onunload();
		expect(settings.tephraEnabled).toBe(true);
		const reload = pluginWithTephraOn();
		reload.plugin.tephraController.startIfEnabled();
		await vi.advanceTimersByTimeAsync(0);
		expect(reload.plugin.tephraConnection?.isRunning()).toBe(true);
		reload.plugin.onunload();
	});

	it("unloading a plugin whose controller was never built is safe", () => {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		plugin.app = new App() as never;
		plugin.outsideFolderWatchers = { closeAll: vi.fn() } as never;
		plugin.folderLiveRefresh = { cancelAll: vi.fn() } as never;
		plugin.linkSuggest = undefined as never;
		expect(() => plugin.onunload()).not.toThrow();
	});

	it("the only caller of runTephraTeardown in src is the controller's off path", async () => {
		const { readFileSync, readdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const dir = join(__dirname, "../../src");
		const users = readdirSync(dir)
			.filter((f) => f.endsWith(".ts") && f !== "tephra-teardown.ts")
			.filter((f) => /runTephraTeardown|tephraTeardown\.run|\.runTeardown/.test(readFileSync(join(dir, f), "utf8")));
		expect(users).toEqual(["tephra-controller.ts"]);
	});
});
