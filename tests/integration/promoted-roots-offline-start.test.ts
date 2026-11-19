import { afterEach, describe, expect, it, vi } from "vitest";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS, type AtlasSettings } from "../../src/settings";
import { getPromotedRoots, setPromotedRoots } from "../../src/source-links";
import { makeSourcesRig, sectionEl, sectionRows, sectionTitles, type SourcesRig } from "../sources-explorer-fixture";

// PR-12 (R5): Obsidian starts with Tephra down. The promoted sources Tephra last listed are kept in
// `settings.tephraPromotedRoots`, read at load through the real `loadFromData` and seeded by the real
// `seedPromotedRoots`, so `[tephrad]` still has its section ("(Tephra offline)") and `@tephrad:` links still resolve.
// Real: `AtlasPlugin`'s own methods (on a bare instance, as the controller tests do), the settings normalizer, the
// explorer, `UnitIndex`, `SourceLinkController`'s resolver. The daemon is the fake Tephra server, down.

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
	setPromotedRoots([]);
});

type PluginInternals = { settings: AtlasSettings; loadFromData(data: unknown): void; seedPromotedRoots(active?: boolean): void; rememberPromotedRoots(roots: unknown): void; flushSave: () => Promise<void> };
function barePlugin(): PluginInternals {
	const plugin = Object.create(AtlasPlugin.prototype) as PluginInternals & Record<string, unknown>;
	plugin.flushSave = vi.fn(async () => {});
	return plugin;
}
const OFFLINE = "(Tephra offline)";
const SAVED = { tephrad: { vaultPath: "Sources/tephra/crates/tephrad", absRoot: "/home/user/Developer/Tephra/crates/tephrad" } };

describe("R5: the last known promoted roots", () => {
	it("are written to settings the moment Tephra lists them, saved at once, and read back at load (a round trip through data.json)", () => {
		const writer = barePlugin();
		writer.settings = { ...DEFAULT_SETTINGS, tephraEnabled: true, tephraPromotedRoots: {} };
		writer.rememberPromotedRoots([{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad", absRoot: "/home/user/Developer/Tephra/crates/tephrad" }]);
		expect(writer.settings.tephraPromotedRoots).toEqual(SAVED);
		expect(writer.flushSave).toHaveBeenCalledTimes(1);

		const onDisk = JSON.parse(JSON.stringify({ settings: writer.settings }));
		const reader = barePlugin();
		reader.loadFromData(onDisk);
		expect(reader.settings.tephraPromotedRoots).toEqual(SAVED);
		reader.seedPromotedRoots();
		expect(getPromotedRoots()).toEqual([{ name: "tephrad", ...SAVED.tephrad }]);
	});

	it("returning the folder to its parent (an empty list) clears the saved roots too", () => {
		const plugin = barePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS, tephraEnabled: true, tephraPromotedRoots: { ...SAVED } };
		plugin.rememberPromotedRoots([]);
		expect(plugin.settings.tephraPromotedRoots).toEqual({});
	});

	it("are not seeded with the Tephra toggle off (G16)", () => {
		const plugin = barePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS, tephraEnabled: false, tephraPromotedRoots: { ...SAVED } };
		plugin.seedPromotedRoots(false);
		expect(getPromotedRoots()).toEqual([]);
	});

	it.each([
		["a missing key", undefined, {}],
		["an array", [1], {}],
		["a string", "x", {}],
		["an entry that is not an object", { tephrad: 5 }, {}],
		["a relative absRoot", { tephrad: { vaultPath: "Sources/tephra/a", absRoot: "a" } }, {}],
		["a vaultPath with a .. segment", { tephrad: { vaultPath: "Sources/../x", absRoot: "/a" } }, {}],
		["an absolute vaultPath", { tephrad: { vaultPath: "/Sources/a", absRoot: "/a" } }, {}],
		["an empty vaultPath", { tephrad: { vaultPath: "", absRoot: "/a" } }, {}],
		["an unusable name", { "a/b": { vaultPath: "x/y", absRoot: "/a" } }, {}],
		["a good entry beside a bad one", { ...SAVED, bad: { vaultPath: 3, absRoot: "/a" } }, SAVED],
	])("a hand-edited data.json with %s loads without throwing and keeps only usable entries", (_label, raw, expected) => {
		const plugin = barePlugin();
		plugin.loadFromData({ settings: { tephraPromotedRoots: raw } });
		expect(plugin.settings.tephraPromotedRoots).toEqual(expected);
		expect(plugin.settings.tephraPromotedRoots).not.toBe(DEFAULT_SETTINGS.tephraPromotedRoots); // always a fresh object
	});

	it("start with Tephra down: [tephrad] has its section with '(Tephra offline)', and @tephrad: resolves", async () => {
		const plugin = barePlugin();
		plugin.loadFromData({ settings: { tephraEnabled: true, tephraPromotedRoots: { tephrad: { vaultPath: "Sources/tephra/crates/tephrad", absRoot: "/home/user/Developer/Tephra/crates/tephrad" } } } });
		plugin.seedPromotedRoots(true);

		// `promote` wires the real link controller and the roots sync, as `main.ts` does; Tephra stays down.
		rig = await makeSourcesRig({ down: true, promote: { vaultPath: "/vault" }, settings: { tephraLinks: { tephra: "/vault/Sources/tephra", whoop: "/vault/Sources/whoop" } } });
		expect(rig.connection.getSnapshot()).toMatchObject({ state: "offline", checked: true });
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[tephrad]", "[whoop]"]);
		expect(sectionEl(rig.h, "tephrad").querySelector(":scope > .atlas-section-header")!.textContent).toContain(OFFLINE);
		expect(sectionRows(sectionEl(rig.h, "tephrad"))).toEqual([]);
		// The resolver answers from the seeded roots, with Tephra still down (G9 offline).
		const sourceLinks = rig.plugin.sourceLinks as { resolveFile(text: string, from: string): { path: string } | null };
		expect(sourceLinks.resolveFile("@tephrad:src/registry.rs", "Weekly Review.md")?.path).toBe("Sources/tephra/crates/tephrad/src/registry.rs");
	});

	it("without the saved roots the same start shows no [tephrad] (what R5 fixed)", async () => {
		rig = await makeSourcesRig({ down: true, settings: { tephraLinks: { tephra: "/vault/Sources/tephra", whoop: "/vault/Sources/whoop" } } });
		expect(sectionTitles(rig.h)).toEqual(["Inbox", "[tephra]", "[whoop]"]);
	});
});
