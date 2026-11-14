import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../mocks/obsidian";
import { DEFAULT_SETTINGS, showsInSearch, type AtlasSettings } from "../../src/settings";
import { SourcesFolder } from "../../src/sources-folder";
import { SourceDeleteClassifier } from "../../src/source-delete-classifier";
import { nodeSourcesFs, existsOnDisk } from "../../src/sources-fs";
import { vaultExcludeConfig } from "../../src/source-excludes";
import { SourceActions, type SourceActionsConnection } from "../../src/source-actions";
import type { TephraCallResult, TephraSource } from "../../src/tephra-client";
import type { TephraSnapshot } from "../../src/tephra-connection";

/**
 * PR-5 G5/E4: Remove source through the real `SourceActions` and the real `SourcesFolder` over real symlinks in
 * a temp dir. Tephra is a scripted stand-in (its `source.unregister` reply and the list it would then return).
 */

let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "atlas-remove-source-"))));
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true }); // only the temp dir this test made
	vi.restoreAllMocks();
});

const hash = (dir: string): Record<string, string> => {
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
};
const isLink = (path: string) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};
const exists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

function setup() {
	const vault = join(tmp, "vault");
	mkdirSync(vault, { recursive: true });
	const app = new App();
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: true, tephraLinks: {}, tephraExcludes: {}, tephraSourceSettings: {} };
	const notices: string[] = [];
	const unlinks: string[] = [];
	const countingFs = { ...nodeSourcesFs, unlink: (path: string) => (unlinks.push(path), nodeSourcesFs.unlink(path)) } as typeof nodeSourcesFs;
	const sourcesFolder = new SourcesFolder({
		fs: countingFs,
		getVaultPath: () => vault,
		isMobile: () => false,
		records: {
			getLinks: () => settings.tephraLinks,
			setLinks: (next) => void (settings.tephraLinks = next),
			getExcludes: () => settings.tephraExcludes,
			setExcludes: (next) => void (settings.tephraExcludes = next),
			save: async () => {},
		},
		excludeConfig: () => vaultExcludeConfig(app.vault as never),
		showsInSearch: (name) => showsInSearch(settings, name),
		classifier: new SourceDeleteClassifier({ getLinkTargets: () => settings.tephraLinks, targetExists: existsOnDisk }),
		notify: (message) => void notices.push(message),
	});
	const tephra = { sources: [{ name: "notes", path: vault, status: "online" }] as TephraSource[], unregisterReply: null as TephraCallResult | null };
	const calls: { method: string; params: unknown }[] = [];
	let checks = 0;
	const connection: SourceActionsConnection = {
		getSnapshot: () => ({ state: "online", checked: true, sources: tephra.sources, error: null }) as TephraSnapshot,
		call: async (method, params) => {
			calls.push({ method, params });
			if (method !== "source.unregister") return { ok: true, result: null };
			const reply = tephra.unregisterReply ?? { ok: true as const, result: null };
			if (reply.ok) tephra.sources = tephra.sources.filter((s) => s.name !== (params as { name: string }).name);
			return reply;
		},
		requestCheck: () => void checks++,
	};
	let confirmed: { message: string; label: string; run: () => void } | null = null;
	const actions = new SourceActions({
		app: app as never,
		getConnection: () => connection,
		pickFolder: async () => null,
		getVaultPath: () => vault,
		fs: nodeSourcesFs,
		realpath: async (p) => p,
		sourcesFolder,
		confirm: (message, label, run) => void (confirmed = { message, label, run }),
		notify: (message) => void notices.push(message),
	});
	const addSource = (name: string): string => {
		const root = join(tmp, "src", name);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "README.md"), `# ${name}`);
		writeFileSync(join(root, "data.csv"), "a,b\n1,2\n");
		tephra.sources.push({ name, path: root, status: "online" });
		return root;
	};
	sourcesFolder.start(); // the toggle is on
	const syncAll = async () => {
		await sourcesFolder.sync(tephra.sources);
		await sourcesFolder.whenIdle();
	};
	/** Click Remove, then confirm in the dialog (if one is open), and let the unregister finish. */
	const remove = async (name: string, confirm = true) => {
		confirmed = null;
		actions.removeSource(name);
		if (confirm) {
			(confirmed as { run: () => void } | null)?.run();
			// the unregister is a few awaited steps (call, then the folder sync): wait for the folder code to go idle
			await vi.waitFor(async () => {
				await sourcesFolder.whenIdle();
				expect(calls.some((c) => c.method === "source.unregister") || confirmed === null).toBe(true);
			});
			await new Promise((r) => setTimeout(r, 20));
			await sourcesFolder.whenIdle();
		}
	};
	return { vault, settings, notices, unlinks, tephra, calls, checks: () => checks, sourcesFolder, addSource, syncAll, remove, confirmation: () => confirmed };
}

describe("Remove source (G5)", () => {
	it("asks first: the confirm says the files stay, and nothing is sent until it is confirmed", async () => {
		const h = setup();
		h.addSource("whoop");
		await h.syncAll();
		await h.remove("whoop", false);
		expect(h.confirmation()!.message).toBe("Remove source whoop? Its files on disk are not touched; links to it will show as broken.");
		expect(h.confirmation()!.label).toBe("Remove");
		expect(h.calls).toEqual([]);
		expect(isLink(join(h.vault, "Sources", "whoop"))).toBe(true);
	});

	it("the vault source is never removed from here: no confirm, no request", async () => {
		const h = setup();
		await h.remove("notes", false);
		expect(h.confirmation()).toBeNull();
		expect(h.calls).toEqual([]);
	});

	it("confirming sends one source.unregister {name}, asks for a check, and unlinks Sources/<name> with the folder code's own unlink: the source's files are byte-identical", async () => {
		const h = setup();
		const root = h.addSource("whoop");
		h.addSource("tephra");
		await h.syncAll();
		const before = hash(root);
		expect(isLink(join(h.vault, "Sources", "whoop"))).toBe(true);

		await h.remove("whoop");

		expect(h.calls).toEqual([{ method: "source.unregister", params: { name: "whoop" } }]);
		expect(h.checks()).toBe(1);
		expect(exists(join(h.vault, "Sources", "whoop"))).toBe(false);
		expect(h.unlinks).toEqual([join(h.vault, "Sources", "whoop")]); // the one link and nothing else
		expect(isLink(join(h.vault, "Sources", "tephra"))).toBe(true); // a sibling is untouched
		expect(hash(root)).toEqual(before); // the files behind the link are untouched
		expect(h.settings.tephraLinks).not.toHaveProperty("whoop"); // its record went with it
		expect(h.settings.tephraLinks).toHaveProperty("tephra");
		expect(h.notices).toEqual([]);
	});

	it("Excluded files entries made for the source are cleaned up with it", async () => {
		const h = setup();
		h.addSource("whoop");
		await h.syncAll();
		expect(Object.keys(h.settings.tephraExcludes)).toContain("whoop");
		await h.remove("whoop");
		expect(h.settings.tephraExcludes).not.toHaveProperty("whoop");
	});

	it("Tephra refusing the unregister: a notice with its reason, and the link and records stay as they were", async () => {
		const h = setup();
		h.addSource("whoop");
		await h.syncAll();
		h.tephra.unregisterReply = { ok: false, error: { kind: "rpc", message: "Tephra error: source is busy", code: -32000 } };
		await h.remove("whoop");
		expect(h.notices).toEqual(["Atlas: couldn't remove whoop: source is busy"]);
		expect(isLink(join(h.vault, "Sources", "whoop"))).toBe(true);
		expect(h.tephra.sources.map((s) => s.name)).toContain("whoop");
		expect(h.checks()).toBe(0);
	});

	it("Tephra unreachable: it says Tephra isn't running and changes nothing", async () => {
		const h = setup();
		h.addSource("whoop");
		await h.syncAll();
		h.tephra.unregisterReply = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };
		await h.remove("whoop");
		expect(h.notices).toEqual(["Atlas: couldn't remove whoop: Tephra isn't running"]);
		expect(isLink(join(h.vault, "Sources", "whoop"))).toBe(true);
	});

	it("a source already removed with tephractl ('no source named') counts as done: no error, and the link is cleaned up", async () => {
		const h = setup();
		h.addSource("whoop");
		await h.syncAll();
		h.tephra.unregisterReply = { ok: false, error: { kind: "rpc", message: "Tephra error: no source named whoop", code: -32001 } };
		h.tephra.sources = h.tephra.sources.filter((s) => s.name !== "whoop"); // Tephra no longer lists it
		await h.remove("whoop");
		expect(h.notices).toEqual([]);
		expect(exists(join(h.vault, "Sources", "whoop"))).toBe(false);
	});

	it("two confirms for the same source in a row send one request", async () => {
		const h = setup();
		h.addSource("whoop");
		await h.syncAll();
		const first = h.confirmation();
		h.remove("whoop", false);
		const a = h.confirmation()!;
		a.run();
		a.run();
		await vi.waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 30));
		expect(first).toBeNull();
		expect(h.calls.filter((c) => c.method === "source.unregister")).toHaveLength(1);
	});

	it("a real folder (not a link) at Sources/<name> is left exactly as it is, with a notice", async () => {
		const h = setup();
		h.addSource("whoop");
		const real = join(h.vault, "Sources", "whoop");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "mine.md"), "my own words");
		const before = hash(join(h.vault, "Sources"));
		await h.remove("whoop");
		expect(hash(join(h.vault, "Sources"))).toEqual(before);
		expect(h.unlinks).toEqual([]);
		expect(h.notices.join("\n")).toMatch(/Sources\/whoop is a real folder, not a link, so Atlas left it alone/);
	});

	it("a link Atlas didn't make (not in its records) is left alone, with a notice", async () => {
		const h = setup();
		const root = h.addSource("whoop");
		mkdirSync(join(h.vault, "Sources"), { recursive: true });
		symlinkSync(root, join(h.vault, "Sources", "whoop")); // the user's own link: no record of it
		await h.remove("whoop");
		expect(isLink(join(h.vault, "Sources", "whoop"))).toBe(true);
		expect(h.unlinks).toEqual([]);
		expect(h.notices.join("\n")).toMatch(/link Atlas didn't make/);
	});

	it("nothing at Sources/<name> (never linked, or already gone): still a success, nothing deleted", async () => {
		const h = setup();
		h.addSource("whoop"); // never synced: no link
		await h.remove("whoop");
		expect(h.notices).toEqual([]);
		expect(h.unlinks).toEqual([]);
		expect(h.calls).toHaveLength(1);
	});

	it("a name that could climb out of Sources/ never reaches the filesystem", async () => {
		const h = setup();
		const outside = join(tmp, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "keep.md"), "keep");
		const outcome = await h.sourcesFolder.removeSource("../outside", []);
		expect(outcome).toBe("skipped");
		expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("keep");
		expect(h.unlinks).toEqual([]);
	});
});
