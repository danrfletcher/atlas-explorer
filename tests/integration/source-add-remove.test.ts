import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App as ObsidianApp } from "obsidian";
import { App } from "../mocks/obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { groupInboxSections, parseUnitList, sourceUnitsFromEntries } from "../../src/inbox-sections";
import { DEFAULT_SETTINGS, showsInSearch, type AtlasSettings } from "../../src/settings";
import { SourceActions } from "../../src/source-actions";
import { SourceDeleteClassifier } from "../../src/source-delete-classifier";
import { vaultExcludeConfig } from "../../src/source-excludes";
import { SourceFileIndex, describeUnresolved, resolveSourceLink } from "../../src/source-links";
import { SourcesFolder } from "../../src/sources-folder";
import { existsOnDisk, nodeSourcesFs, realPath } from "../../src/sources-fs";
import { TephraClient, type TephraRequestFn } from "../../src/tephra-client";
import { TephraConnection } from "../../src/tephra-connection";
import type { UnitRef } from "../../src/types";
import { startFakeTephra } from "../fixtures/fake-tephra-server.mjs";
import { button, flush, inputEl, key, modals } from "../helpers";
import { indexLikeObsidian, wirePluginVaultEvents } from "../sources-plugin-wiring";

/**
 * PR-5 (G3, G5, F2, F3, R3-4): Add source, then Remove source, then Add it again, end to end over real files.
 *
 * Real: the vault and the `Whoop/` folder (a temp dir), the `Sources/whoop` symlink, `TephraClient` talking
 * HTTP JSON-RPC to a stand-in daemon on a random port, `TephraConnection` (its 10 s timer is switched off, so
 * only `requestCheck()` can make a source appear or go), `SourcesFolder`, `SourceDeleteClassifier`,
 * `SourceActions` with the real name dialog, the real `AtlasPlugin` delete/create handlers, `ViewsManager`
 * and the explorer's own row resolution. Stand-ins: the Tephra daemon, Obsidian (the shared mock, kept in
 * step with the disk by `indexLikeObsidian`, which sends Obsidian's create/delete events and never calls the
 * vault's delete) and the folder picker.
 */

let tmp: string;
let closeDaemon: (() => Promise<void>) | null = null;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "atlas-add-remove-"))));
afterEach(async () => {
	if (modals().length) key("Escape");
	document.body.innerHTML = "";
	await closeDaemon?.();
	closeDaemon = null;
	rmSync(tmp, { recursive: true, force: true }); // only the temp dir this test made
	vi.restoreAllMocks();
});

/** Every regular file under `dir` (links not followed) with the hash of its bytes. */
const hashTree = (dir: string): Record<string, string> => {
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
const isLink = (path: string): boolean => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};
const exists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

async function build() {
	const vault = join(tmp, "vault");
	const whoop = join(tmp, "Documents", "Whoop");
	mkdirSync(vault, { recursive: true });
	mkdirSync(whoop, { recursive: true });
	writeFileSync(join(whoop, "Workout Plan.md"), "# Workout Plan\n\nSquats.\n");
	writeFileSync(join(whoop, "Leg Day.md"), "# Leg Day\n\nMore squats.\n");
	// The third note: it links into the source, and its text must survive both Add and Remove.
	writeFileSync(join(vault, "Journal.md"), "Today I followed [[@whoop:Workout Plan]] and skipped [[@whoop:Leg Day]].\n");

	// The stand-in daemon: it keeps its own list and changes it on register and unregister, like Tephra.
	const daemon = { sources: [{ name: "notes", path: vault, status: "online" }] as { name: string; path: string; status: string }[], log: [] as string[] };
	const tokenFile = join(tmp, "token");
	writeFileSync(tokenFile, "c".repeat(64));
	const fake = await startFakeTephra({
		port: 0,
		tokenFile,
		sources: (() => daemon.sources) as never,
		units: (() => Object.fromEntries(daemon.sources.filter((s) => s.name !== "notes").map((s) => [s.name, readdirSync(s.path).map((name) => ({ name, kind: "markdown" as const }))]))) as never,
		methods: {
			"source.register": (params: unknown) => {
				const { name, root } = params as { name: string; root: string };
				daemon.log.push(`rpc:source.register ${name}`);
				if (daemon.sources.some((s) => s.name === name)) return { error: { code: -32000, message: `source already registered: ${name}` } };
				daemon.sources = [...daemon.sources, { name, path: root, status: "online" }];
				return { result: { name, root } };
			},
			"source.unregister": (params: unknown) => {
				const { name } = params as { name: string };
				daemon.log.push(`rpc:source.unregister ${name}`);
				if (!daemon.sources.some((s) => s.name === name)) return { error: { code: -32001, message: `no source named ${name}` } };
				daemon.sources = daemon.sources.filter((s) => s.name !== name);
				return { result: null };
			},
		},
	});
	closeDaemon = fake.close;
	const request: TephraRequestFn = async ({ url, method, headers, body }) => {
		const response = await fetch(url, { method, headers, body });
		return { status: response.status, text: await response.text() } as Awaited<ReturnType<TephraRequestFn>>;
	};
	const client = new TephraClient({ request, tokenPath: () => tokenFile, url: `http://127.0.0.1:${fake.port}/rpc` });
	let intervalTicks = 0;
	// The 10 s check never fires here: a source can only appear or go because `requestCheck()` asked.
	const connection = new TephraConnection(client, () => () => void intervalTicks++);

	const app = new App();
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: true, tephraLinks: {}, tephraExcludes: {}, tephraSourceSettings: {} };
	const notices: string[] = [];
	const unlinks: string[] = [];
	const countingFs = { ...nodeSourcesFs, unlink: (path: string) => (daemon.log.push(`unlink ${path}`), unlinks.push(path), nodeSourcesFs.unlink(path)) } as typeof nodeSourcesFs;
	const classifier = new SourceDeleteClassifier({ getLinkTargets: () => settings.tephraLinks, targetExists: existsOnDisk });
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
		classifier,
		notify: (message) => void notices.push(message),
	});
	connection.onCheck((snapshot) => {
		if (snapshot.state === "online") void sourcesFolder.sync(snapshot.sources);
	});

	const wiring = wirePluginVaultEvents(app, settings, classifier);
	let confirmed: { message: string; label: string; run: () => void } | null = null;
	const actions = new SourceActions({
		app: app as never,
		getConnection: () => connection,
		pickFolder: async () => whoop,
		getVaultPath: () => vault,
		fs: nodeSourcesFs,
		realpath: realPath,
		sourcesFolder,
		confirm: (message, label, run) => void (confirmed = { message, label, run }),
		notify: (message) => void notices.push(message),
	});

	indexLikeObsidian(app, vault); // Obsidian opens the vault: Journal.md
	sourcesFolder.start(); // the toggle is on
	connection.start();
	await connection.check();
	await sourcesFolder.whenIdle();
	const vaultFileCount = () => app.vault.getFiles().length;

	/** "+" → "Add source…" → the real name dialog, Enter. Resolves when the dialog is gone. */
	const addWhoop = async () => {
		const flow = actions.addSource();
		await vi.waitFor(() => expect(modals().length, JSON.stringify(notices)).toBeGreaterThan(0));
		await flush();
		expect(inputEl().value).toBe("whoop"); // `Whoop` → `whoop`
		expect(button("Add").disabled).toBe(false);
		key("Enter");
		await flow;
		// Nothing here asks for a check, and the 10 s timer is off: the link is there only because the add itself
		// asked Tephra's connection for one (`requestCheck()`) right after the reply.
		await vi.waitFor(() => expect(isLink(join(vault, "Sources", "whoop"))).toBe(true));
		await sourcesFolder.whenIdle();
		return indexLikeObsidian(app, vault);
	};
	/** Right-click → Remove → the confirm → Confirm. Resolves once the link is gone and Obsidian has said so. */
	const removeWhoop = async () => {
		confirmed = null;
		actions.removeSource("whoop");
		const dialog = confirmed as { message: string; label: string; run: () => void } | null;
		expect(dialog).not.toBeNull();
		dialog!.run();
		await vi.waitFor(() => expect(daemon.log.some((l) => l.startsWith("unlink "))).toBe(true));
		// The section and the settings row go with the next `source.list`: only `requestCheck()` can have asked for it.
		await vi.waitFor(() => expect(connection.getSnapshot().sources.map((s) => s.name)).toEqual(["notes"]));
		await sourcesFolder.whenIdle();
		return { dialog: dialog!, events: indexLikeObsidian(app, vault) };
	};
	const sections = async () => {
		const snapshot = connection.getSnapshot();
		const units = [];
		for (const source of snapshot.sources.filter((s) => s.name !== "notes")) {
			const listed = await client.call("unit.list", { source: source.name });
			const parsed = listed.ok ? parseUnitList(listed.result) : null;
			if (parsed) units.push(...sourceUnitsFromEntries(source.name, parsed.entries));
		}
		return groupInboxSections({ enabled: true, sources: snapshot.sources, units }).map((s) => ({ name: s.name, paths: s.units.map((u) => u.path).sort() }));
	};
	const resolveRow = (ref: UnitRef) =>
		(AtlasExplorerView.prototype as unknown as { resolveRef: (r: UnitRef) => Promise<{ missing: boolean }> }).resolveRef.call(
			{ plugin: { app, settings: { ...DEFAULT_SETTINGS } }, unitsByRefKey: new Map() },
			ref
		);
	const linkOutcome = (linktext: string) => resolveSourceLink(new SourceFileIndex(() => app.vault.getFiles()), linktext);
	return { vault, whoop, app, settings, notices, unlinks, daemon, connection, sourcesFolder, classifier, wiring, addWhoop, removeWhoop, sections, resolveRow, linkOutcome, vaultFileCount, intervalTicks: () => intervalTicks, linkPath: join(vault, "Sources", "whoop") };
}

describe("PR-5 Add source → Remove source → Add it again, end to end", () => {
	it("G3/G5/F2/F3/R3-4: the section and link appear; Remove leaves every file and every view entry; the same source added again brings the entries back", async () => {
		const h = await build();
		const vaultApi = h.app.vault as unknown as { delete: unknown; trash?: unknown };
		const fileManager = h.app.fileManager as unknown as { trashFile?: unknown };
		// What Remove must never use (fence): the vault's delete, trash, the file manager's trash and any recursive rm.
		const spies = [vi.spyOn(vaultApi as { delete: () => Promise<void> }, "delete"), vi.fn(), vi.fn(), vi.spyOn(nodeFs.promises, "rm"), vi.spyOn(nodeFs.promises, "rmdir")];
		vaultApi.trash = spies[1];
		fileManager.trashFile = spies[2];
		const unitIndexDelete = vi.spyOn(h.wiring.unitIndex, "onVaultDelete");
		const moveDelete = vi.spyOn(h.wiring.externalMoveDetector, "onDelete");

		// Before: Tephra lists only the vault, and there is no Sources/ at all.
		expect(await h.sections()).toEqual([{ name: null, paths: [] }]);
		expect(exists(join(h.vault, "Sources"))).toBe(false);
		const journal = readFileSync(join(h.vault, "Journal.md"), "utf8");
		const vaultFilesBefore = h.vaultFileCount();
		expect(h.linkOutcome("@whoop:Workout Plan")).toMatchObject({ kind: "unresolved", reason: "not-found" });

		// ---- Add (GP2) ----
		const added = await h.addWhoop();
		expect(h.daemon.log.filter((l) => l.startsWith("rpc:source.register"))).toEqual(["rpc:source.register whoop"]); // one request
		expect(h.intervalTicks()).toBe(0); // …and the source showed up without waiting for the 10 s check
		expect(isLink(h.linkPath)).toBe(true);
		expect(readdirSync(join(h.vault, "Sources"))).toEqual(["whoop"]); // F2: the one link, nothing else made in the vault
		expect(added.created).toEqual(["Sources", "Sources/whoop", "Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md"]); // Obsidian's file tree
		expect(await h.sections()).toEqual([
			{ name: null, paths: [] },
			{ name: "whoop", paths: ["Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md"] },
		]);
		expect(h.settings.tephraLinks).toEqual({ whoop: h.whoop });
		expect(h.linkOutcome("@whoop:Workout Plan")).toMatchObject({ kind: "resolved" });
		expect(h.app.vault.calls).toEqual([]); // Atlas made no vault call: it never created a note or a TFile
		expect(h.notices).toEqual([]);

		// Dan arranges: a node for the note with a child and a status, and a placeholder row pointing at it.
		const planRef: UnitRef = { kind: "file", path: "Sources/whoop/Workout Plan.md" };
		const legRef: UnitRef = { kind: "file", path: "Sources/whoop/Leg Day.md" };
		const views = h.wiring.viewsManager;
		const view = views.getViews()[0];
		const plan = views.placeUnit(view.id, planRef, null)!;
		const leg = views.placeUnit(view.id, legRef, plan.id)!;
		views.getNode(view.id, plan.id)!.explicitStatusId = "in-progress";
		const holder = views.addMetaFolder(view.id, null, "Holder")!;
		const holderNode = views.getNode(view.id, holder.id)!;
		holderNode.apiItemState = { "1": { id: "1", label: "Workout Plan", kind: "placeholder", noteRef: planRef } as never };
		holderNode.apiItemOrder = ["1"];
		const viewsBefore = JSON.stringify(views.getViews());
		expect(await h.resolveRow(planRef)).toMatchObject({ missing: false });

		const sourceBefore = hashTree(h.whoop);
		const everyFileBefore = { ...hashTree(h.vault), ...sourceBefore }; // the vault's own files and the source's, byte for byte
		expect(Object.keys(everyFileBefore).some((p) => p.endsWith("Journal.md"))).toBe(true);

		// ---- Remove ----
		const removed = await h.removeWhoop();
		expect(removed.dialog.message).toBe("Remove source whoop? Its files on disk are not touched; links to it will show as broken.");
		expect(removed.dialog.label).toBe("Remove");
		// One unregister, and the link is unlinked after it (never before), through the filesystem's own unlink.
		expect(h.daemon.log.filter((l) => l.includes("source.unregister") || l.startsWith("unlink "))).toEqual(["rpc:source.unregister whoop", `unlink ${h.linkPath}`]);
		expect(h.intervalTicks()).toBe(0);
		expect(exists(h.linkPath)).toBe(false);
		expect(exists(h.whoop)).toBe(true); // the folder itself is still there…
		expect(hashTree(h.whoop)).toEqual(sourceBefore); // …and so is every file in it, byte for byte
		expect({ ...hashTree(h.vault), ...hashTree(h.whoop) }).toEqual(everyFileBefore); // F3: no file's content changed, the link note included
		expect(readFileSync(join(h.vault, "Journal.md"), "utf8")).toBe(journal);
		expect(await h.sections()).toEqual([{ name: null, paths: [] }]); // the [whoop] section is gone
		expect(h.connection.getSnapshot().sources.map((s) => s.name)).toEqual(["notes"]); // and its row in the Tephra settings list
		expect(h.settings.tephraLinks).toEqual({}); // PR-3's per-source clean-up ran: its record…
		expect(h.settings.tephraExcludes).not.toHaveProperty("whoop"); // …and its Excluded files entries
		expect(h.notices).toEqual([]);
		// Obsidian then reported the deletes under Sources/whoop/ (children first, then the folder)…
		expect(removed.events.deleted).toEqual(["Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md", "Sources/whoop"]);
		// …and none of them reached the handlers that react to a user deleting a note.
		expect(h.wiring.graduationDeletes).toEqual([]);
		expect(unitIndexDelete.mock.calls.filter(([path]) => path.startsWith("Sources/"))).toEqual([]);
		expect(moveDelete).not.toHaveBeenCalled();
		expect(h.wiring.renames).toEqual([]);
		expect(JSON.stringify(views.getViews())).toBe(viewsBefore); // nodes, children, statuses and the placeholder's noteRef: all still in the data
		expect(views.getNode(view.id, leg.id)).not.toBeNull();
		expect(views.getNode(view.id, plan.id)!.explicitStatusId).toBe("in-progress");
		expect(holderNode.apiItemState!["1"].noteRef).toEqual(planRef);
		expect(await h.resolveRow(planRef)).toMatchObject({ missing: true }); // greyed as missing, not deleted
		expect(await h.resolveRow(legRef)).toMatchObject({ missing: true });
		// The links in other notes stay in the text and are unresolved; clicking one gives PR-1's notice and makes no note.
		const unresolved = h.linkOutcome("@whoop:Workout Plan");
		expect(unresolved).toMatchObject({ kind: "unresolved", reason: "not-found" });
		expect(describeUnresolved(unresolved as Extract<typeof unresolved, { kind: "unresolved" }>, "@whoop:Workout Plan")).toBe("No file Workout Plan in whoop");
		expect(h.vaultFileCount()).toBe(vaultFilesBefore); // Journal.md only
		// The fence: not one call to a vault delete, a trash, or a recursive removal.
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(h.app.vault.calls).toEqual([]);

		// ---- Add the same name and folder again ----
		const again = await h.addWhoop();
		expect(isLink(h.linkPath)).toBe(true);
		expect(again.created).toEqual(["Sources/whoop", "Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md"]);
		expect(await h.resolveRow(planRef)).toMatchObject({ missing: false }); // the entries come back…
		expect(await h.resolveRow(legRef)).toMatchObject({ missing: false });
		expect(JSON.stringify(views.getViews())).toBe(viewsBefore); // …with nothing changed in the data
		expect(h.linkOutcome("@whoop:Workout Plan")).toMatchObject({ kind: "resolved" });
		expect(h.wiring.graduationDeletes).toEqual([]);
		expect(h.wiring.renames).toEqual([]); // the returning files are not read as a move
		expect(hashTree(h.whoop)).toEqual(sourceBefore);
		expect(readFileSync(join(h.vault, "Journal.md"), "utf8")).toBe(journal);
		expect(h.daemon.log.filter((l) => l.startsWith("rpc:source.register"))).toEqual(["rpc:source.register whoop", "rpc:source.register whoop"]); // one per Add
		expect(h.daemon.log.filter((l) => l.startsWith("rpc:source.unregister"))).toHaveLength(1);
		expect(h.notices).toEqual([]);
	});

	it("a real delete in a source that is still linked is not swallowed: only what Atlas unlinked is expected", async () => {
		const h = await build();
		await h.addWhoop();
		const ref: UnitRef = { kind: "file", path: "Sources/whoop/Leg Day.md" };
		const holder = h.wiring.viewsManager.addMetaFolder(h.wiring.viewsManager.getViews()[0].id, null, "Holder")!;
		const holderNode = h.wiring.viewsManager.getNode(h.wiring.viewsManager.getViews()[0].id, holder.id)!;
		holderNode.apiItemState = { "1": { id: "1", label: "Leg Day", kind: "placeholder", noteRef: ref } as never };
		holderNode.apiItemOrder = ["1"];

		rmSync(join(h.whoop, "Leg Day.md")); // Dan deletes the note in the source; the link is still there
		const events = indexLikeObsidian(h.app, h.vault);

		expect(events.deleted).toEqual(["Sources/whoop/Leg Day.md"]);
		expect(h.wiring.graduationDeletes).toEqual(["Sources/whoop/Leg Day.md"]); // an ordinary delete: every handler ran
		expect(holderNode.apiItemState!["1"].noteRef).toBeUndefined();
	});
});
