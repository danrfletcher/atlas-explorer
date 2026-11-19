import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodeFs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Notice } from "../mocks/obsidian";
import AtlasPlugin from "../../src/main";
import { ExternalMoveDetector } from "../../src/external-move";
import { TephraRenameForwarder } from "../../src/tephra-rename-forwarder";
import { TephraRenameQueue, type QueueStorage } from "../../src/tephra-rename-queue";
import { DEFAULT_SETTINGS, showsInSearch, type AtlasSettings } from "../../src/settings";
import { SourceRenamer, type SourceRenameConnection } from "../../src/source-rename";
import { SourceDeleteClassifier } from "../../src/source-delete-classifier";
import { vaultExcludeConfig } from "../../src/source-excludes";
import { SourcesFolder } from "../../src/sources-folder";
import { existsOnDisk, nodeSourcesFs } from "../../src/sources-fs";
import type { SourcesFs } from "../../src/sources-links";
import type { TephraCallResult, TephraSource } from "../../src/tephra-client";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import type { UnitRef, View, ViewNode } from "../../src/types";
import { button, flush, inputEl, messageEl, modals, type as typeInto } from "../helpers";
import { obsidianFirstLinkpathDest, seedPaths } from "../sources-vault";
import { LinkResolutionHook } from "../../src/link-resolution-hook";
import { captureRenameTabs, type RenameTabLeaf, type RenameTabsDeps } from "../../src/source-rename-tabs";

/**
 * PR-11 (G4): Rename source, through the real `SourceRenamer`, the real `SourcesFolder` over a real temp folder, the
 * real `ViewsManager`/`UnitIndex` and `AtlasPlugin.remapSourcePaths`, and the real name dialog. Stand-ins: Tephra (a
 * connection whose `source.rename` answers what the test says) and Obsidian (the shared mock). The fixture vault is
 * `tests/fixtures/graduation-vault` plus `Sources/whoop/…` units placed in two views, with statuses.
 */

const NOTES: TephraSource = { name: "notes", path: "/vault", status: "online" };
const file = (path: string): UnitRef => ({ kind: "file", path });

function graduationVaultPaths(): string[] {
	const root = join(__dirname, "..", "fixtures", "graduation-vault");
	const out: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
			else out.push(`${prefix}${entry.name}`);
		}
	};
	walk(root, "");
	return out;
}

const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });

/** Two views holding `Sources/whoop/…` units, a `Sources/whoopee/…` one that must not move, and statuses on both kinds. */
function buildViews(): View[] {
	const folder: ViewNode = {
		id: "f1",
		type: "meta",
		label: "Plans",
		statusEnabled: true,
		statusSetId: "set-1",
		children: [unit("n1", file("Sources/whoop/Workout Plan.md"), { explicitStatusId: "doing" }), unit("n2", file("Sources/whoopee/Workout Plan.md"), { explicitStatusId: "done" })],
		folderSource: { location: "inside", path: "Sources/whoop/Plans", showFiles: true, showFolders: true, removedRefs: ["file:Sources/whoop/Plans/Old.md"] },
	};
	const api: ViewNode = {
		id: "f2",
		type: "meta",
		label: "API",
		children: [],
		apiItemState: { a1: { id: "a1", label: "Row", kind: "placeholder", noteRef: file("Sources/whoop/Leg Day.md") } as never },
	};
	const csv: ViewNode = { id: "f3", type: "meta", label: "CSV", children: [], csvSource: { path: "Sources/whoop/data.csv", mapping: { idField: "id", labelField: "name" }, mode: "append" } };
	const table: ViewNode = { id: "f4", type: "meta", label: "Table", children: [], markdownTableSource: { path: "Sources/whoop/Table.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "append" } };
	return [
		{ id: "v1", name: "Default", inboxMode: "view", root: [folder, api, csv, table, unit("n3", file("Weekly Review.md")), unit("n4", file("Sources-whoop.md"))] },
		{ id: "v2", name: "Other", inboxMode: "view", root: [unit("n5", file("Sources/whoop/Leg Day.md"), { explicitStatusId: "todo" })] },
	];
}

/** Real filesystem calls finish on the thread pool, so a zero-delay timeout isn't enough: wait for the condition, bounded. */
async function until(condition: () => boolean, what = "the condition"): Promise<void> {
	for (let i = 0; i < 1000 && !condition(); i++) await flush();
	if (!condition()) throw new Error(`timed out waiting for ${what}`);
}
const dialogOpen = () => until(() => document.querySelector(".atlas-name-input") !== null, "the name dialog");

type Behaviour = TephraCallResult | "timeout" | "network" | ((params: unknown) => TephraCallResult | Promise<TephraCallResult>);

describe("Rename source: order, atomicity, remap, swap and the fence", () => {
	let tmp: string;
	let created: Array<() => void> = [];
	beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "atlas-rename-"))));
	afterEach(() => {
		for (const stop of created) stop();
		created = [];
		rmSync(tmp, { recursive: true, force: true }); // only the temp dir this test made
		vi.restoreAllMocks();
		for (const modal of modals()) modal.closest(".modal-container")?.remove();
	});

	async function build(opts: { rename?: Behaviour; online?: boolean; breakSymlinkOnce?: boolean; sourceName?: string; prepareTabs?: () => Promise<void> } = {}) {
		const sourceName = opts.sourceName ?? "whoop";
		const vault = join(tmp, "vault");
		const target = join(tmp, "Whoop");
		mkdirSync(join(vault, "Sources"), { recursive: true });
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "Workout Plan.md"), "[[@whoop:Workout Plan]] plan\n");
		writeFileSync(join(target, "Leg Day.md"), "legs\n");
		const linkOf = (name: string) => join(vault, "Sources", name);
		symlinkSync(target, linkOf(sourceName), "dir");
		const bytesBefore = { plan: readFileSync(join(target, "Workout Plan.md")), legs: readFileSync(join(target, "Leg Day.md")) };

		const log: string[] = [];
		const settings: AtlasSettings = {
			...DEFAULT_SETTINGS,
			tephraEnabled: true,
			tephraLinks: { [sourceName]: target },
			tephraExcludes: { [sourceName]: [`Sources/${sourceName}/.git/`, `Sources/${sourceName}/target/`], tephra: ["Sources/tephra/.git/"] },
			tephraSourceSettings: { [sourceName]: { showInSearch: false } },
			noAutoPromoteFolders: [`Sources/${sourceName}/Plans`, "Projects", "Sources/whoopee/Plans"],
		};

		const app = new App();
		seedPaths(app, [...graduationVaultPaths(), "Sources/whoop/Workout Plan.md", "Sources/whoop/Leg Day.md", "Sources/whoopee/Workout Plan.md", "Sources-whoop.md"]);
		(app.vault as unknown as { setConfig: (k: string, v: unknown) => void }).setConfig("userIgnoreFilters", [...settings.tephraExcludes[sourceName], "Sources/tephra/.git/", "drafts/"]);
		const vaultApi = app.vault as unknown as Record<string, unknown>;
		const fileManager = app.fileManager as unknown as Record<string, unknown>;
		vaultApi.trash ??= async () => {};
		fileManager.renameFile ??= async () => {};
		const fence = {
			"vault.modify": vi.spyOn(vaultApi as { modify: () => Promise<void> }, "modify"),
			"vault.process": vi.spyOn((vaultApi.process ? vaultApi : Object.assign(vaultApi, { process: async () => "" })) as { process: () => Promise<string> }, "process"),
			"vault.delete": vi.spyOn(vaultApi as { delete: () => Promise<void> }, "delete"),
			"vault.trash": vi.spyOn(vaultApi as { trash: () => Promise<void> }, "trash"),
			"fileManager.renameFile": vi.spyOn(fileManager as { renameFile: () => Promise<void> }, "renameFile"),
			"fs.promises.rm": vi.spyOn(nodeFs.promises, "rm"),
			"fs.rmSync": vi.spyOn(nodeFs, "rmSync"),
			"fs.rm": vi.spyOn(nodeFs, "rm"),
		};

		const fsCalls: Array<{ method: string; path: string }> = [];
		let symlinkFailures = opts.breakSymlinkOnce ? 1 : 0;
		const recordingFs = Object.fromEntries(
			Object.entries(nodeSourcesFs).map(([method, fn]) => [
				method,
				(...args: unknown[]) => {
					const path = String(args[method === "symlink" ? 1 : 0]);
					fsCalls.push({ method, path });
					if (method === "symlink" || method === "unlink") log.push(`${method} ${path.replace(`${vault}/`, "")}`);
					if (method === "symlink" && symlinkFailures > 0) {
						symlinkFailures--;
						return Promise.reject(Object.assign(new Error("operation not permitted"), { code: "EPERM" }));
					}
					return (fn as (...a: unknown[]) => unknown)(...args);
				},
			])
		) as unknown as SourcesFs;

		const classifier = new SourceDeleteClassifier({ getLinkTargets: () => settings.tephraLinks, targetExists: existsOnDisk });
		// Also what the next load builds: the same disk and records, a fresh instance.
		const makeSourcesFolder = () => new SourcesFolder({
			fs: recordingFs,
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
			notify: () => {},
		});
		const sourcesFolder = makeSourcesFolder();
		sourcesFolder.start();
		created.push(() => sourcesFolder.dispose());

		const unitIndex = new UnitIndex(app, settings, [file(`Sources/${sourceName}/Leg Day.md`), file("Notes/Keep.md")], { v1: [file("Sources/whoop/Workout Plan.md")] }, [file("Sources/whoop/Leg Day.md")], [
			{ ref: { kind: "folder", path: "Sources/whoop/Plans" }, tag: "added" },
		]);
		const viewsManager = new ViewsManager(app, buildViews(), "v1", () => {});
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		// What `data.json` is sent, at the moment of each write: `flushSave`/`persistNow` are the real ones, over this stand-in `saveData`.
		const saves: Array<{ data: Record<string, unknown>; logLength: number }> = [];
		Object.assign(plugin, {
			settings,
			unitIndex,
			viewsManager,
			expandedModuleFolders: new Set(["Sources/whoop/Plans", "Mod/Inner", "Sources/whoopee/x"]),
			statusesManager: { getStatusSets: () => [], getColorPalette: () => ({}) },
			saveData: vi.fn(async (data: Record<string, unknown>) => void saves.push({ data: JSON.parse(JSON.stringify(data)), logLength: log.length })),
			persistDebounced: Object.assign(vi.fn(), { cancel: vi.fn(), run: vi.fn() }),
		});

		const listed: TephraSource[] = [NOTES, { name: sourceName, path: target, status: "online" }];
		const calls: Array<{ method: string; params: unknown }> = [];
		const checks: number[] = [];
		const snapshotState = () => ({ state: opts.online === false ? "offline" : "online", checked: true, sources: listed, error: null }) as never;
		const connection: SourceRenameConnection = {
			getSnapshot: snapshotState,
			requestCheck: () => void checks.push(calls.length),
			call: async (method, params) => {
				calls.push({ method, params });
				log.push(`rpc ${method} ${JSON.stringify(params)}`);
				// At the moment Tephra is asked, Atlas has changed nothing.
				expect(viewsManager.getView("v1")!.root[0].children[0].ref).toEqual(file("Sources/whoop/Workout Plan.md"));
				const behaviour = opts.rename ?? { ok: true, result: { name: "whoop", new_name: "gym", files_changed: 1, deferred: 0, status: "applied" } };
				if (behaviour === "timeout") return { ok: false, error: { kind: "timeout", message: "Tephra didn't answer in 5 s" } };
				if (behaviour === "network") return { ok: false, error: { kind: "network", message: "connect ECONNREFUSED" } };
				return typeof behaviour === "function" ? behaviour(params) : behaviour;
			},
		};

		const notices: string[] = [];
		const tabs: string[] = [];
		const afterRename: string[] = [];
		const renamer = new SourceRenamer({
			app: app as never,
			getConnection: () => connection,
			getVaultPath: () => vault,
			fs: recordingFs,
			swapSource: (o, n, root) => sourcesFolder.swapSource(o, n, root),
			remap: async (o, n) => {
				log.push("remap");
				await plugin.remapSourcePaths(o, n);
			},
			prepareTabs: async () => {
				log.push("flush tabs");
				await opts.prepareTabs?.();
				return () => void tabs.push("reopened");
			},
			afterRename: (o, n) => void (afterRename.push(`${o}>${n}`), log.push("re-render")),
			notify: (message) => void notices.push(message),
		});
		return { vault, target, linkOf, log, calls, checks, notices, tabs, afterRename, renamer, settings, unitIndex, viewsManager, plugin, app, fence, fsCalls, classifier, sourcesFolder, makeSourcesFolder, listed, bytesBefore, connection, saves };
	}
	type Rig = Awaited<ReturnType<typeof build>>;

	/** Drives the shipped `rename()` through the real name dialog: types `name`, confirms, resolves when it closes. */
	async function renameViaDialog(rig: Rig, name: string, oldName = "whoop"): Promise<void> {
		const flow = rig.renamer.rename(oldName);
		await dialogOpen();
		typeInto(name);
		button("Rename").click();
		await flow;
	}

	const targetBytes = (rig: Rig) => ({ plan: readFileSync(join(rig.target, "Workout Plan.md")), legs: readFileSync(join(rig.target, "Leg Day.md")) });
	const noFenceCall = (rig: Rig) => {
		for (const [name, spy] of Object.entries(rig.fence)) expect(spy, `${name} was called`).not.toHaveBeenCalled();
	};
	const stateOf = (rig: Rig) =>
		JSON.stringify({
			views: rig.viewsManager.getViews(),
			manual: rig.unitIndex.getManualPromotions(),
			dismissed: [rig.unitIndex.getDismissedByView(), rig.unitIndex.getDismissedGlobal(), rig.unitIndex.getAddedItems()],
			settings: [rig.settings.tephraLinks, rig.settings.tephraExcludes, rig.settings.tephraSourceSettings, rig.settings.noAutoPromoteFolders],
			expanded: [...(rig.plugin as unknown as { expandedModuleFolders: Set<string> }).expandedModuleFolders],
			excludes: (rig.app.vault as unknown as { getConfig: (k: string) => unknown }).getConfig("userIgnoreFilters"),
		});

	describe("the dialog (G4)", () => {
		it("opens as 'Rename source', prefilled with the current name, and the confirm button reads 'Rename'", async () => {
			const rig = await build();
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			expect(document.querySelector(".modal-title")!.textContent).toBe("Rename source");
			expect(inputEl().value).toBe("whoop");
			expect(button("Rename")).toBeTruthy();
			expect(button("Rename").disabled).toBe(false); // the unchanged current name is valid
			button("Cancel").click();
			await flow;
			expect(rig.calls).toEqual([]);
		});

		it("only one name dialog can be open: a second Rename while it is open opens nothing and sends nothing", async () => {
			const rig = await build();
			const first = rig.renamer.rename("whoop");
			await dialogOpen();
			await rig.renamer.rename("whoop");
			expect(modals().length).toBe(1);
			button("Cancel").click();
			await first;
			expect(rig.calls).toEqual([]);
		});

		it("typing tephra is red 'taken', 'a b' is red 'space', gym is valid; confirm is disabled while red", async () => {
			const rig = await build();
			rig.listed.push({ name: "tephra", path: "/t", status: "online" });
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("tephra");
			expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
			expect(messageEl().textContent).toBe("A source named tephra already exists");
			expect(button("Rename").disabled).toBe(true);
			typeInto("a b");
			expect(messageEl().textContent).toBe("A source name can't contain a space");
			expect(button("Rename").disabled).toBe(true);
			typeInto("gym");
			expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
			expect(button("Rename").disabled).toBe(false);
			button("Cancel").click();
			await flow;
			expect(rig.calls).toEqual([]);
		});

		it("confirming the unchanged current name closes the dialog and changes nothing: no RPC, no file events, no notice", async () => {
			const rig = await build();
			const before = stateOf(rig);
			await renameViaDialog(rig, "whoop");
			expect(modals().length).toBe(0);
			expect(rig.calls).toEqual([]);
			expect(rig.fsCalls.filter((c) => ["symlink", "unlink", "rename"].includes(c.method))).toEqual([]);
			expect(rig.notices).toEqual([]);
			expect(rig.log).toEqual([]);
			expect(stateOf(rig)).toBe(before);
		});

		it("a name already used by a Sources/<name> entry (a real folder, a note, a stray link) is refused with that reason and nothing changes", async () => {
			const rig = await build();
			mkdirSync(rig.linkOf("real-folder"));
			writeFileSync(rig.linkOf("stray-note.md"), "x");
			symlinkSync(rig.target, rig.linkOf("stray-link"), "dir");
			const before = stateOf(rig);
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			for (const name of ["real-folder", "stray-note.md", "stray-link"]) {
				typeInto(name);
				expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
				expect(messageEl().textContent).toBe(`Sources/${name} already exists in the vault`);
				expect(button("Rename").disabled).toBe(true);
			}
			button("Cancel").click();
			await flow;
			expect(rig.calls).toEqual([]);
			expect(stateOf(rig)).toBe(before);
		});

		it("an entry that appears while the dialog is open stops the request at confirm: no RPC, the reason shown, the dialog stays", async () => {
			const rig = await build();
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			mkdirSync(rig.linkOf("gym")); // appeared after the last keystroke
			button("Rename").click();
			await until(() => messageEl().textContent !== "", "the refusal");
			expect(rig.calls).toEqual([]);
			expect(messageEl().textContent).toBe("Sources/gym already exists in the vault");
			expect(modals().length).toBe(1);
			button("Cancel").click();
			await flow;
		});
	});

	describe("the order and the result (G4)", () => {
		it("Tephra's call, its acknowledgement, the Atlas remap, the link swap, the re-render: in that order, with one RPC", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(rig.log).toEqual([
				`rpc source.rename ${JSON.stringify({ name: "whoop", new_name: "gym" })}`,
				"flush tabs",
				"remap",
				"symlink Sources/gym",
				"unlink Sources/whoop",
				"re-render",
			]);
			expect(rig.calls).toHaveLength(1);
			expect(rig.afterRename).toEqual(["whoop>gym"]);
			expect(rig.tabs).toEqual(["reopened"]);
			expect(rig.notices).toEqual([]);
			expect(modals().length).toBe(0);
		});

		it("Sources/gym is a link to the same folder, Sources/whoop is gone, and the target's files are byte-identical", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(lstatSync(rig.linkOf("gym")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(rig.linkOf("gym"))).toBe(rig.target);
			expect(existsSync(rig.linkOf("whoop"))).toBe(false);
			expect(() => lstatSync(rig.linkOf("whoop"))).toThrow();
			expect(targetBytes(rig)).toEqual(rig.bytesBefore);
			expect(readdirSync(join(rig.vault, "Sources"))).toEqual(["gym"]);
			expect(rig.settings.tephraLinks).toEqual({ gym: rig.target });
		});

		it("the unlink is on the link only: no vault delete/trash, no fs.rm, no recursive removal, no content write, no rename call", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			noFenceCall(rig);
			expect(rig.fsCalls.filter((c) => c.method === "unlink")).toEqual([{ method: "unlink", path: rig.linkOf("whoop") }]);
			expect(rig.fsCalls.filter((c) => c.method === "rmdir" || c.method === "writeFile")).toEqual([]);
		});

		it("the swap's deletes under Sources/whoop are Atlas's own (expected), and a longer name's are not", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(rig.classifier.classify("Sources/whoop/Workout Plan.md")).toBe("expected");
			expect(rig.classifier.classify("Sources/whoop")).toBe("expected");
			expect(rig.classifier.classify("Sources/whoopee/Workout Plan.md")).toBe("real");
			expect(rig.classifier.classify("Notes/Keep.md")).toBe("real");
		});

		it("Tephra's answer is shown when it is partial: the user is told, and the rename still goes through", async () => {
			const rig = await build({ rename: { ok: true, result: { name: "whoop", new_name: "gym", files_changed: 3, deferred: 2, status: "partial" } } });
			await renameViaDialog(rig, "gym");
			expect(existsSync(rig.linkOf("gym"))).toBe(true);
			expect(rig.notices).toHaveLength(1);
			expect(rig.notices[0]).toContain("2 linking files still point at the old name");
			expect(rig.notices[0]).toContain("partial");
		});
	});

	describe("the swap's own file events (R3-4)", () => {
		/** The plugin's real vault-event handlers over the rig, with the real rename forwarder and queue (in-memory file) behind them. */
		function wireHandlers(rig: Rig) {
			const files = new Map<string, string>();
			const queueWrites: string[] = [];
			const storage: QueueStorage = {
				read: (path) => files.get(path) ?? null,
				write: (path, text) => void (queueWrites.push(path), files.set(path, text)),
				moveAside: () => {},
			};
			const sent: Array<{ method: string; params: unknown }> = [];
			const timers: number[] = [];
			const queue = new TephraRenameQueue({ storage, path: "queue.json", now: () => Date.now(), onCorrupt: () => {}, onWriteError: (error) => { throw error; } });
			const tephraRenames = new TephraRenameForwarder({
				queue,
				scheduler: { setTimeout: (_cb, ms) => void timers.push(ms), clearTimeout: () => {} },
				now: () => Date.now(),
				isActive: () => true,
				getConnection: () => ({ isOnline: () => true, call: async (method, params) => (sent.push({ method, params }), { ok: true as const, result: {} }) }),
				getVaultRoot: () => rig.vault,
				notify: () => {},
				log: () => {},
			});
			const graduation = { handleDelete: vi.fn(), handleRename: vi.fn(), handleModify: vi.fn() };
			const detector = new ExternalMoveDetector();
			const onDelete = vi.spyOn(detector, "onDelete");
			const matchCreate = vi.spyOn(detector, "matchCreate");
			const target = rig.plugin as unknown as Record<string, unknown> & { onVaultDeleteEvent: (f: unknown) => void; onVaultCreateEvent: (f: unknown) => void };
			Object.assign(target, {
				app: rig.app,
				sourceDeleteClassifier: rig.classifier,
				graduation,
				tephraRenames,
				externalMoveDetector: detector,
				folderLiveRefresh: { schedule: vi.fn() },
			});
			const renameEvent = vi.fn();
			target.onVaultRenameEvent = renameEvent;
			const unitDelete = vi.spyOn(rig.unitIndex, "onVaultDelete");
			const viewDelete = vi.spyOn(rig.viewsManager, "onVaultDelete");
			const emit = (name: "create" | "delete", entry: unknown) => (rig.app.vault as unknown as { emit: (n: string, e: unknown) => void }).emit(name, entry);
			// The way main.ts registers them: Obsidian's own vault events into the plugin's real handlers.
			rig.app.vault.on("delete", (entry: unknown) => target.onVaultDeleteEvent(entry));
			rig.app.vault.on("create", (entry: unknown) => target.onVaultCreateEvent(entry));
			return { graduation, detector, onDelete, matchCreate, renameEvent, unitDelete, viewDelete, sent, timers, queue, queueWrites, emit, target };
		}

		it("the deletes under Sources/whoop/ and the creates under Sources/gym/ never reach Tephra, PR-10's queue, graduation, the placeholders or the links notice", async () => {
			const rig = await build();
			const wired = wireHandlers(rig);
			await renameViaDialog(rig, "gym");
			const vault = rig.app.vault;
			Notice.reset();
			const before = stateOf(rig);
			const placeholder = () => rig.viewsManager.getViews()[0].root[1].apiItemState!.a1.noteRef;
			expect(placeholder()).toEqual(file("Sources/gym/Leg Day.md")); // remapped by the rename

			// What Obsidian then reports for the swap: the old link's files and folder go, the new link's appear.
			const gone = ["Sources/whoop/Workout Plan.md", "Sources/whoop/Leg Day.md", "Sources/whoop"].map((path) => vault.getAbstractFileByPath(path));
			expect(gone.every((entry) => entry !== null)).toBe(true);
			for (const entry of gone) wired.emit("delete", entry);
			vault.seedFolder("Sources/gym");
			for (const entry of [vault.getAbstractFileByPath("Sources/gym"), vault.seedFile("Sources/gym/Workout Plan.md"), vault.seedFile("Sources/gym/Leg Day.md")]) wired.emit("create", entry);

			// Both handlers ran for every event, and nothing downstream of them reacted.
			expect(rig.classifier.classify("Sources/whoop/Leg Day.md")).toBe("expected");
			expect(wired.sent).toEqual([]); // no link.rename_event, nothing forwarded to Tephra
			expect(wired.timers).toEqual([]); // no drain scheduled
			expect(wired.queueWrites).toEqual([]); // nothing written to the on-disk queue
			expect(wired.queue.size()).toBe(0);
			expect(wired.renameEvent).not.toHaveBeenCalled(); // no external-move pairing replayed as a rename
			expect(wired.onDelete).not.toHaveBeenCalled();
			expect(wired.graduation.handleDelete).not.toHaveBeenCalled(); // no graduation
			expect(wired.graduation.handleRename).not.toHaveBeenCalled();
			expect(wired.unitDelete).not.toHaveBeenCalled(); // no promotion loss
			expect(wired.viewDelete).not.toHaveBeenCalled(); // no placeholder noteRef clearing
			expect(placeholder()).toEqual(file("Sources/gym/Leg Day.md"));
			expect(stateOf(rig)).toBe(before);
			expect(Notice.instances.map((n) => n.message)).toEqual([]); // no "Links to this note weren't updated"
			expect(rig.notices).toEqual([]);
		});

		it("the same events through the same handlers with nothing expected DO react (the test sees what it guards)", async () => {
			const rig = await build();
			const wired = wireHandlers(rig);
			rig.classifier.clear();
			const entry = rig.app.vault.getAbstractFileByPath("Sources/whoopee/Workout Plan.md");
			wired.emit("delete", entry); // a real delete under a linked-source-looking path that is not whoop
			expect(wired.unitDelete).toHaveBeenCalledWith("Sources/whoopee/Workout Plan.md");
			expect(wired.graduation.handleDelete).toHaveBeenCalled();
			expect(wired.viewDelete).toHaveBeenCalledWith("Sources/whoopee/Workout Plan.md");
			expect(wired.onDelete).toHaveBeenCalled();
		});

		it("an announced rename (E6) is silent the same way", async () => {
			const rig = await build();
			const wired = wireHandlers(rig);
			rig.renamer.onRenamed("whoop", "gym");
			await rig.renamer.settled();
			const vault = rig.app.vault;
			for (const path of ["Sources/whoop/Workout Plan.md", "Sources/whoop/Leg Day.md", "Sources/whoop"]) wired.emit("delete", vault.getAbstractFileByPath(path));
			vault.seedFolder("Sources/gym");
			wired.emit("create", vault.seedFile("Sources/gym/Leg Day.md"));
			expect(wired.sent).toEqual([]);
			expect(wired.queueWrites).toEqual([]);
			expect(wired.graduation.handleDelete).not.toHaveBeenCalled();
			expect(wired.viewDelete).not.toHaveBeenCalled();
			expect(wired.renameEvent).not.toHaveBeenCalled();
			expect(rig.viewsManager.getViews()[0].root[1].apiItemState!.a1.noteRef).toEqual(file("Sources/gym/Leg Day.md"));
		});
	});

	describe("the remap of everything keyed by a vault path (R3-4)", () => {
		it("view refs, API item noteRefs and folder/csv/markdown-table source paths under Sources/whoop/ move; statuses, ids and positions stay", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			const [v1, v2] = rig.viewsManager.getViews();
			const folder = v1.root[0];
			expect(folder.children[0]).toMatchObject({ id: "n1", ref: file("Sources/gym/Workout Plan.md"), explicitStatusId: "doing" });
			expect(folder.children[1]).toMatchObject({ id: "n2", ref: file("Sources/whoopee/Workout Plan.md"), explicitStatusId: "done" }); // whoopee untouched
			expect(folder).toMatchObject({ statusEnabled: true, statusSetId: "set-1" });
			expect(folder.folderSource).toMatchObject({ path: "Sources/gym/Plans", removedRefs: ["file:Sources/gym/Plans/Old.md"] });
			expect(v1.root[1].apiItemState!.a1.noteRef).toEqual(file("Sources/gym/Leg Day.md"));
			expect(v1.root[2].csvSource!.path).toBe("Sources/gym/data.csv");
			expect(v1.root[3].markdownTableSource!.path).toBe("Sources/gym/Table.md");
			expect(v1.root[4].ref).toEqual(file("Weekly Review.md"));
			expect(v1.root[5].ref).toEqual(file("Sources-whoop.md")); // a vault note, not under the source
			expect(v2.root[0]).toMatchObject({ id: "n5", ref: file("Sources/gym/Leg Day.md"), explicitStatusId: "todo" }); // the second view too
			expect(JSON.stringify(v1)).not.toContain("Sources/whoop/");
		});

		it("every view is saved once for the whole remap", async () => {
			const persist = vi.fn();
			const rig = await build();
			(rig.viewsManager as unknown as { persist: () => void }).persist = persist;
			const changes: boolean[] = [];
			rig.viewsManager.onChange((persisted) => void changes.push(persisted));
			await renameViaDialog(rig, "gym");
			expect(changes.filter((persisted) => persisted)).toHaveLength(1);
		});

		it("manual promotions, dismissed and added paths, noAutoPromoteFolders and the Module Contents expansion move; others stay", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(rig.unitIndex.getManualPromotions()).toEqual([file("Sources/gym/Leg Day.md"), file("Notes/Keep.md")]);
			expect(rig.unitIndex.getDismissedByView()).toEqual({ v1: [file("Sources/gym/Workout Plan.md")] });
			expect(rig.unitIndex.getDismissedGlobal()).toEqual([file("Sources/gym/Leg Day.md")]);
			expect(rig.unitIndex.getAddedItems()).toEqual([{ ref: { kind: "folder", path: "Sources/gym/Plans" }, tag: "added" }]);
			expect(rig.settings.noAutoPromoteFolders).toEqual(["Sources/gym/Plans", "Projects", "Sources/whoopee/Plans"]);
			expect([...(rig.plugin as unknown as { expandedModuleFolders: Set<string> }).expandedModuleFolders].sort()).toEqual(["Mod/Inner", "Sources/gym/Plans", "Sources/whoopee/x"]);
			expect(rig.plugin.saveData).toHaveBeenCalled();
		});

		it("per-source settings and Excluded-files entries move: no Sources/whoop/ entry is left in userIgnoreFilters or data.json", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(rig.settings.tephraSourceSettings).toEqual({ gym: { showInSearch: false } });
			expect(rig.settings.tephraExcludes).toEqual({ gym: ["Sources/gym/.git/", "Sources/gym/target/"], tephra: ["Sources/tephra/.git/"] });
			const filters = (rig.app.vault as unknown as { getConfig: (k: string) => string[] }).getConfig("userIgnoreFilters");
			expect(filters).toEqual(["Sources/gym/.git/", "Sources/gym/target/", "Sources/tephra/.git/", "drafts/"]);
			expect(filters.some((entry) => entry.includes("Sources/whoop/"))).toBe(false);
		});
	});

	describe("a refusal or a failed call changes nothing in Atlas (R3-6)", () => {
		const unchanged = async (rig: Rig, before: string) => {
			expect(stateOf(rig)).toBe(before);
			expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
			expect(existsSync(rig.linkOf("gym"))).toBe(false);
			expect(targetBytes(rig)).toEqual(rig.bytesBefore);
			expect(rig.log.filter((line) => line === "remap" || line.startsWith("symlink") || line.startsWith("unlink") || line === "re-render")).toEqual([]);
			expect(rig.afterRename).toEqual([]);
			noFenceCall(rig);
		};

		it("Tephra refuses: its reason is shown word for word in the dialog and in a notice, the dialog stays open, nothing changes", async () => {
			const reason = 'the name "gym" is taken by the source "Gym"';
			const rig = await build({ rename: { ok: false, error: { kind: "rpc", message: `Tephra error: ${reason}` } } });
			const before = stateOf(rig);
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => messageEl().textContent !== "", "the refusal");
			expect(messageEl().textContent).toBe(reason);
			expect(modals().length).toBe(1);
			expect(rig.notices).toEqual([`Atlas: couldn't rename whoop: ${reason}`]);
			button("Cancel").click();
			await flow;
			await unchanged(rig, before);
			expect(rig.calls).toHaveLength(1);
		});

		it("a timeout: a notice, the dialog closes, the request is not sent again, a check is asked for, nothing changes", async () => {
			const rig = await build({ rename: "timeout" });
			const before = stateOf(rig);
			await renameViaDialog(rig, "gym");
			expect(rig.notices).toEqual(["Atlas: couldn't rename whoop: Tephra didn't answer in time"]);
			expect(rig.calls).toHaveLength(1);
			expect(rig.checks).toHaveLength(1);
			expect(modals().length).toBe(0);
			await unchanged(rig, before);
		});

		it("the connection is lost mid-call: a notice, the dialog stays with the reason, nothing changes", async () => {
			const rig = await build({ rename: "network" });
			const before = stateOf(rig);
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => messageEl().textContent !== "", "the refusal");
			expect(messageEl().textContent).toBe("Tephra isn't running");
			expect(rig.notices).toEqual(["Atlas: couldn't rename whoop: Tephra isn't running"]);
			button("Cancel").click();
			await flow;
			await unchanged(rig, before);
		});

		it.each([
			["a 4xx", { kind: "http", message: "Tephra answered 400" }],
			["a 5xx", { kind: "http", message: "Tephra answered 503" }],
			["a malformed answer", { kind: "non-json", message: "Tephra's answer wasn't JSON" }],
		] as const)("%s: the client's message is shown and nothing changes", async (_label, error) => {
			const rig = await build({ rename: { ok: false, error: { ...error } } });
			const before = stateOf(rig);
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => messageEl().textContent !== "", "the refusal");
			expect(rig.notices).toEqual([`Atlas: couldn't rename whoop: ${error.message}`]);
			button("Cancel").click();
			await flow;
			await unchanged(rig, before);
		});

		it("Tephra offline: nothing is sent, nothing is queued, no dialog opens", async () => {
			const rig = await build({ online: false });
			await rig.renamer.rename("whoop");
			expect(modals().length).toBe(0);
			expect(rig.calls).toEqual([]);
			expect(rig.notices).toEqual(["Atlas: Tephra isn't running."]);
			expect(rig.log).toEqual([]);
		});

		it("the vault's own section is never renamed from here", async () => {
			const rig = await build();
			await rig.renamer.rename("notes");
			expect(modals().length).toBe(0);
			expect(rig.calls).toEqual([]);
		});
	});

	describe("a link swap that fails after Tephra acknowledged (G2's reconcile finishes it)", () => {
		it("the remap is on disk before the swap runs, so a quit right after still keeps it (flushed, not left to the 500 ms debounce)", async () => {
			const rig = await build({ breakSymlinkOnce: true });
			await renameViaDialog(rig, "gym");
			const remapAt = rig.log.indexOf("remap");
			const swapAt = rig.log.findIndex((line) => line.startsWith("symlink"));
			const remapped = rig.saves.filter((save) => save.logLength > remapAt && save.logLength <= swapAt);
			expect(remapped.length).toBeGreaterThan(0); // a write landed between the remap and the swap
			const data = remapped[remapped.length - 1].data as { views: View[]; manualPromotions: UnitRef[]; settings: AtlasSettings; addedItems: unknown[]; dismissedGlobal: UnitRef[] };
			// That write already holds every remapped store; nothing waited on persistDebounced.
			expect(JSON.stringify(data.views)).not.toContain("Sources/whoop/");
			expect(data.views[0].root[0].children[0].ref).toEqual(file("Sources/gym/Workout Plan.md"));
			expect(data.manualPromotions).toEqual([file("Sources/gym/Leg Day.md"), file("Notes/Keep.md")]);
			expect(data.dismissedGlobal).toEqual([file("Sources/gym/Leg Day.md")]);
			expect(JSON.stringify(data.addedItems)).toContain("Sources/gym/Plans");
			expect(data.settings.noAutoPromoteFolders[0]).toBe("Sources/gym/Plans");
			expect(data.settings.tephraSourceSettings).toEqual({ gym: { showInSearch: false } });
			expect((rig.plugin as unknown as { persistDebounced: { cancel: unknown } }).persistDebounced.cancel).toHaveBeenCalled(); // the pending debounce is dropped by the flush
		});

		it("the same holds for a rename Tephra announced (E6) whose swap fails", async () => {
			const rig = await build({ breakSymlinkOnce: true });
			rig.renamer.onRenamed("whoop", "gym");
			await rig.renamer.settled();
			expect(existsSync(rig.linkOf("gym"))).toBe(false); // the swap failed
			const remapAt = rig.log.indexOf("remap");
			const swapAt = rig.log.findIndex((line) => line.startsWith("symlink"));
			const saved = rig.saves.find((save) => save.logLength > remapAt && save.logLength <= swapAt);
			expect(saved).toBeDefined();
			expect(JSON.stringify((saved!.data as { views: View[] }).views)).not.toContain("Sources/whoop/");
		});

		it("a failing write is logged and the swap still goes ahead (the in-memory remap is already done)", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const rig = await build();
			(rig.plugin.saveData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
			await renameViaDialog(rig, "gym");
			expect(error).toHaveBeenCalledWith(expect.stringContaining("couldn't save the remapped source paths"), expect.any(Error));
			expect(existsSync(rig.linkOf("gym"))).toBe(true);
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/gym/Workout Plan.md"));
		});

		it("Atlas keeps the remapped state and says so; Sources/whoop stays; the next sync creates Sources/gym and removes Sources/whoop", async () => {
			const rig = await build({ breakSymlinkOnce: true });
			await renameViaDialog(rig, "gym");
			expect(rig.notices).toHaveLength(1);
			expect(rig.notices[0]).toContain("whoop is now gym in Tephra");
			expect(rig.notices[0]).toContain("EPERM");
			expect(rig.tabs).toEqual([]); // tabs reopen only after a swap that worked
			expect(rig.afterRename).toEqual(["whoop>gym"]); // the Inbox is re-rendered anyway
			// The remapped state is kept.
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/gym/Workout Plan.md"));
			expect(rig.settings.noAutoPromoteFolders[0]).toBe("Sources/gym/Plans");
			// The disk is where it was, and Tephra's list wins at the next sync.
			expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
			expect(existsSync(rig.linkOf("gym"))).toBe(false);
			await rig.sourcesFolder.sync([NOTES, { name: "gym", path: rig.target, status: "online" }]);
			await rig.sourcesFolder.whenIdle();
			expect(readdirSync(join(rig.vault, "Sources"))).toEqual(["gym"]);
			expect(readlinkSync(rig.linkOf("gym"))).toBe(rig.target);
			expect(targetBytes(rig)).toEqual(rig.bytesBefore);
			noFenceCall(rig);
		});

		it("a real folder that took the new name in the meantime is never replaced: EEXIST, a notice, the old link stays", async () => {
			const rig = await build({
				rename: () => {
					mkdirSync(rig2.linkOf("gym")); // appears between the confirm-time check and the swap
					return { ok: true, result: { name: "whoop", new_name: "gym", files_changed: 0, deferred: 0, status: "applied" } };
				},
			});
			const rig2 = rig;
			await renameViaDialog(rig, "gym");
			expect(rig.notices[0]).toContain("EEXIST");
			expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
			expect(lstatSync(rig.linkOf("gym")).isDirectory()).toBe(true);
			expect(lstatSync(rig.linkOf("gym")).isSymbolicLink()).toBe(false);
			noFenceCall(rig);
		});
	});

	describe("one rename at a time", () => {
		it("a double-click on confirm sends exactly one RPC", async () => {
			let release: (value: TephraCallResult) => void = () => {};
			const rig = await build({ rename: () => new Promise<TephraCallResult>((resolve) => void (release = resolve)) });
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			button("Rename").click();
			inputEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await until(() => rig.calls.length >= 1, "the request");
			await flush();
			expect(rig.calls).toHaveLength(1);
			release({ ok: true, result: { name: "whoop", new_name: "gym", files_changed: 0, deferred: 0, status: "applied" } });
			await flow;
			expect(rig.calls).toHaveLength(1);
			expect(existsSync(rig.linkOf("gym"))).toBe(true);
		});

		it("a second Rename while the first is in flight is refused with 'Rename in progress' and sends nothing", async () => {
			let release: (value: TephraCallResult) => void = () => {};
			const rig = await build({ rename: () => new Promise<TephraCallResult>((resolve) => void (release = resolve)) });
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => rig.calls.length === 1, "the request");
			expect(rig.renamer.isBusy()).toBe(true);
			await rig.renamer.rename("whoop");
			expect(rig.notices).toEqual(["Atlas: Rename in progress."]);
			expect(rig.calls).toHaveLength(1);
			release({ ok: true, result: { name: "whoop", new_name: "gym", files_changed: 0, deferred: 0, status: "applied" } });
			await flow;
			expect(rig.renamer.isBusy()).toBe(false);
		});
	});

	describe("plugin unload in the middle of a rename (E8): nothing is rolled back, nothing is cleaned up, the next load reconciles", () => {
		const ACK: TephraCallResult = { ok: true, result: { name: "whoop", new_name: "gym", files_changed: 1, deferred: 0, status: "applied" } };

		/** The plugin's real `onunload`, over the rig's real renamer and sources folder. */
		function unload(rig: Rig): void {
			const plugin = rig.plugin as unknown as Record<string, unknown> & { onunload: () => void };
			Object.assign(plugin, { app: rig.app, sourceRenamer: rig.renamer, sourcesFolder: rig.sourcesFolder, folderLiveRefresh: { cancelAll: vi.fn() }, linkSuggest: undefined });
			plugin.onunload();
		}
		/** What a quit in the middle leaves on disk and in Tephra's calls: no swap, no removal, no second request. */
		function expectDiskUntouched(rig: Rig): void {
			expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
			expect(existsSync(rig.linkOf("gym"))).toBe(false);
			expect(rig.fsCalls.filter((c) => ["symlink", "unlink", "rmdir", "rename"].includes(c.method))).toEqual([]);
			expect(rig.calls).toHaveLength(1); // the one rename request; nothing asks Tephra to undo it
			expect(rig.notices).toEqual([]);
			expect(rig.afterRename).toEqual([]);
			expect(rig.tabs).toEqual([]);
			expect(targetBytes(rig)).toEqual(rig.bytesBefore);
			noFenceCall(rig);
		}
		/** The next load: a fresh sources folder over the same disk and records is given Tephra's list. */
		async function reconcile(rig: Rig): Promise<void> {
			const next = rig.makeSourcesFolder();
			next.start();
			created.push(() => next.dispose());
			await next.sync([NOTES, { name: "gym", path: rig.target, status: "online" }]);
			await next.whenIdle();
			expect(readdirSync(join(rig.vault, "Sources"))).toEqual(["gym"]);
			expect(readlinkSync(rig.linkOf("gym"))).toBe(rig.target);
			expect(targetBytes(rig)).toEqual(rig.bytesBefore);
		}

		it("unloaded while Tephra hasn't answered: when the answer comes nothing in Atlas changes and nothing is written; the next load makes Sources/gym and removes Sources/whoop", async () => {
			let release: (value: TephraCallResult) => void = () => {};
			const rig = await build({ rename: () => new Promise<TephraCallResult>((resolve) => void (release = resolve)) });
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => rig.calls.length === 1, "the request");
			const before = stateOf(rig);
			unload(rig);
			release(ACK);
			await flow;
			await rig.renamer.settled();
			expect(rig.log).toEqual([`rpc source.rename ${JSON.stringify({ name: "whoop", new_name: "gym" })}`]); // no tab flush, no remap, no swap, no re-render
			expect(rig.saves).toEqual([]); // a dead instance writes nothing to data.json
			expect(stateOf(rig)).toBe(before);
			// The old entries are still there, on the old path: they show missing once Sources/whoop goes, and are never deleted.
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/whoop/Workout Plan.md"));
			expect(rig.viewsManager.getViews()[0].root[0].children[0].explicitStatusId).toBe("doing");
			expectDiskUntouched(rig);
			await reconcile(rig);
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/whoop/Workout Plan.md")); // not deleted, not rewritten by the sync
		});

		it("unloaded while the open tabs are being saved: the remap and the swap don't start, and nothing is undone", async () => {
			let unloaded: Promise<void> | null = null;
			let rigRef: Rig | null = null;
			const rig = await build({
				prepareTabs: async () => {
					unload(rigRef!);
					unloaded = Promise.resolve();
				},
			});
			rigRef = rig;
			await renameViaDialog(rig, "gym");
			await unloaded;
			expect(rig.log).toEqual([`rpc source.rename ${JSON.stringify({ name: "whoop", new_name: "gym" })}`, "flush tabs"]);
			expect(rig.saves).toEqual([]);
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/whoop/Workout Plan.md"));
			expectDiskUntouched(rig);
			await reconcile(rig);
		});

		it("unloaded while the remap is being written: the write that started finishes with the remapped state, the swap doesn't start, the next load reconciles", async () => {
			const rig = await build();
			let finishWrite: () => void = () => {};
			const saveData = rig.plugin.saveData as ReturnType<typeof vi.fn>;
			const original = saveData.getMockImplementation()!;
			saveData.mockImplementationOnce(
				(data: Record<string, unknown>) =>
					new Promise<void>((resolve) => {
						unload(rig); // the quit arrives while the write is out
						finishWrite = () => void original(data).then(() => resolve());
					})
			);
			const flow = renameViaDialog(rig, "gym");
			await until(() => saveData.mock.calls.length === 1, "the remap's write");
			finishWrite();
			await flow;
			await rig.renamer.settled();
			expect(rig.log).toEqual([`rpc source.rename ${JSON.stringify({ name: "whoop", new_name: "gym" })}`, "flush tabs", "remap"]); // no symlink, no unlink, no re-render
			expect(rig.saves).toHaveLength(1);
			expect(JSON.stringify((rig.saves[0].data as { views: View[] }).views)).not.toContain("Sources/whoop/"); // the remap is on disk
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/gym/Workout Plan.md"));
			expectDiskUntouched(rig);
			await reconcile(rig);
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/gym/Workout Plan.md")); // the sync leaves the remapped refs alone
			expect(rig.viewsManager.getViews()[0].root[0].children[0].explicitStatusId).toBe("doing");
		});

		it("after the unload a rename Tephra announces, and a new Rename, do nothing (no dialog, no request, no remap)", async () => {
			const rig = await build();
			unload(rig);
			rig.renamer.onRenamed("whoop", "gym");
			await rig.renamer.settled();
			await rig.renamer.rename("whoop");
			expect(modals().length).toBe(0);
			expect(rig.calls).toEqual([]);
			expect(rig.log).toEqual([]);
			expect(rig.saves).toEqual([]);
			expect(rig.notices).toEqual([]);
			expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
		});

		it("a swap that did not run (the sources folder is not active) leaves the old link, so the tabs on it are not reopened at the new path", async () => {
			const rig = await build();
			rig.sourcesFolder.dispose(); // as the toggle being off or mobile: swapSource answers "skipped"
			await renameViaDialog(rig, "gym");
			expect(rig.log).toEqual([`rpc source.rename ${JSON.stringify({ name: "whoop", new_name: "gym" })}`, "flush tabs", "remap", "re-render"]);
			expect(rig.tabs).toEqual([]);
			expect(rig.notices).toEqual([]); // skipped is not a failure
			expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
		});
	});

	describe("a rename Tephra announces (E6)", () => {
		it("runs the same remap and swap with no request and no dialog", async () => {
			const rig = await build();
			rig.renamer.onRenamed("whoop", "gym");
			await rig.renamer.settled();
			expect(rig.calls).toEqual([]);
			expect(modals().length).toBe(0);
			expect(rig.log).toEqual(["flush tabs", "remap", "symlink Sources/gym", "unlink Sources/whoop", "re-render"]);
			expect(readdirSync(join(rig.vault, "Sources"))).toEqual(["gym"]);
			expect(rig.viewsManager.getViews()[1].root[0].ref).toEqual(file("Sources/gym/Leg Day.md"));
			expect(rig.settings.tephraSourceSettings).toEqual({ gym: { showInSearch: false } });
			noFenceCall(rig);
		});

		it("the push that follows Atlas's own rename is not run a second time, whether it arrives before the answer or after", async () => {
			let release: (value: TephraCallResult) => void = () => {};
			const rig = await build({ rename: () => new Promise<TephraCallResult>((resolve) => void (release = resolve)) });
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => rig.calls.length === 1, "the request");
			rig.renamer.onRenamed("whoop", "gym"); // the frame wins the race with the answer
			release({ ok: true, result: { name: "whoop", new_name: "gym", files_changed: 0, deferred: 0, status: "applied" } });
			await flow;
			rig.renamer.onRenamed("whoop", "gym"); // and a late repeat
			await rig.renamer.settled();
			expect(rig.log.filter((line) => line === "remap")).toHaveLength(1);
			expect(rig.log.filter((line) => line.startsWith("symlink"))).toHaveLength(1);
			expect(rig.afterRename).toEqual(["whoop>gym"]);
		});

		it("a frame for the vault's own name, or for no change, does nothing", async () => {
			const rig = await build();
			rig.renamer.onRenamed("notes", "gym");
			rig.renamer.onRenamed("whoop", "notes");
			rig.renamer.onRenamed("whoop", "whoop");
			await rig.renamer.settled();
			expect(rig.log).toEqual([]);
		});

		it("a rename announced while the user's own is waiting on Tephra runs after it", async () => {
			let release: (value: TephraCallResult) => void = () => {};
			const rig = await build({ rename: () => new Promise<TephraCallResult>((resolve) => void (release = resolve)) });
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("gym");
			button("Rename").click();
			await until(() => rig.calls.length === 1, "the request");
			rig.renamer.onRenamed("tephra", "tephra2"); // somebody else renamed another source
			release({ ok: true, result: { name: "whoop", new_name: "gym", files_changed: 0, deferred: 0, status: "applied" } });
			await flow;
			await rig.renamer.settled();
			const remaps = rig.log.filter((line) => line === "remap");
			expect(remaps).toHaveLength(2);
			expect(rig.log.indexOf("re-render")).toBeLessThan(rig.log.lastIndexOf("remap")); // the user's first
		});
	});

	describe("a source that is missing (E5)", () => {
		it("the new link points at the same missing folder, and view entries stay as they were (missing, not deleted)", async () => {
			const rig = await build();
			rmSync(rig.target, { recursive: true, force: true }); // the folder is gone: the link dangles
			rig.listed[1] = { ...rig.listed[1], status: "missing" };
			const strip = () => JSON.stringify(rig.viewsManager.getViews()).replace(/Sources\/(whoop|gym)\//g, "Sources/X/");
			const before = strip();
			await renameViaDialog(rig, "gym");
			expect(readlinkSync(rig.linkOf("gym"))).toBe(rig.target);
			expect(() => lstatSync(rig.linkOf("whoop"))).toThrow();
			expect(existsSync(rig.linkOf("gym"))).toBe(false); // dangling, still the same missing folder
			expect(strip()).toBe(before); // nothing deleted or demoted: only the prefix differs
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/gym/Workout Plan.md"));
			expect(rig.viewsManager.getViews()[0].root[0].children).toHaveLength(2);
			expect(rig.notices).toEqual([]);
		});
	});

	describe("a case-only rename (whoop -> Whoop)", () => {
		it("swaps through a temporary link name and never fails with EEXIST", async () => {
			const rig = await build({ rename: { ok: true, result: { name: "whoop", new_name: "Whoop", files_changed: 0, deferred: 0, status: "applied" } } });
			await renameViaDialog(rig, "Whoop");
			expect(rig.notices).toEqual([]);
			expect(readdirSync(join(rig.vault, "Sources"))).toEqual(["Whoop"]);
			expect(readlinkSync(rig.linkOf("Whoop"))).toBe(rig.target);
			expect(rig.fsCalls.some((c) => c.method === "symlink" && c.path.endsWith(".atlas-swap-Whoop"))).toBe(true);
			expect(rig.settings.tephraLinks).toEqual({ Whoop: rig.target });
			expect(rig.viewsManager.getViews()[0].root[0].children[0].ref).toEqual(file("Sources/Whoop/Workout Plan.md"));
			expect(targetBytes(rig)).toEqual(rig.bytesBefore);
		});

		it("the dialog does not refuse a source for matching itself", async () => {
			const rig = await build();
			const flow = rig.renamer.rename("whoop");
			await dialogOpen();
			typeInto("WHOOP");
			expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
			button("Cancel").click();
			await flow;
		});
	});

	describe("names with dots, underscores and length", () => {
		it("a name of 255+ bytes reaches Tephra (no local cap on rename, and the too-long lstat is not a failure) and Tephra's reason shows word for word", async () => {
			const reason = "\"" + "a".repeat(300) + "\" is not a valid source name: it is longer than 64 characters";
			for (const length of [255, 256, 300]) {
				const name = "a".repeat(length);
				const rig = await build({ rename: { ok: false, error: { kind: "rpc", message: `Tephra error: ${reason}` } } });
				const before = stateOf(rig);
				const flow = rig.renamer.rename("whoop");
				await dialogOpen();
				typeInto(name);
				expect(inputEl().classList.contains("atlas-name-invalid")).toBe(false); // not red from Atlas's own cap
				expect(button("Rename").disabled).toBe(false);
				button("Rename").click();
				await until(() => messageEl().textContent !== "", "Tephra's reason");
				expect(rig.calls).toEqual([{ method: "source.rename", params: { name: "whoop", new_name: name } }]); // it was sent
				expect(messageEl().textContent).toBe(reason);
				expect(messageEl().textContent).not.toContain("under 200 bytes");
				expect(rig.notices).toEqual([`Atlas: couldn't rename whoop: ${reason}`]);
				button("Cancel").click();
				await flow;
				expect(stateOf(rig)).toBe(before);
				expect(lstatSync(rig.linkOf("whoop")).isSymbolicLink()).toBe(true);
				for (const stop of created) stop();
				created = [];
				rmSync(tmp, { recursive: true, force: true });
				tmp = mkdtempSync(join(tmpdir(), "atlas-rename-"));
			}
		});

		it("my_src.v2 and a long name go through when Tephra accepts them", async () => {
			for (const name of ["my_src.v2", "a".repeat(120)]) {
				const rig = await build({ rename: { ok: true, result: { name: "whoop", new_name: name, files_changed: 0, deferred: 0, status: "applied" } } });
				await renameViaDialog(rig, name);
				expect(rig.calls).toEqual([{ method: "source.rename", params: { name: "whoop", new_name: name } }]);
				expect(readdirSync(join(rig.vault, "Sources"))).toEqual([name]);
				expect(rig.notices).toEqual([]);
				for (const stop of created) stop();
				created = [];
				rmSync(tmp, { recursive: true, force: true });
				tmp = mkdtempSync(join(tmpdir(), "atlas-rename-"));
			}
		});
	});

	describe("Checkpoint 4: the link Tephra rewrote still opens (the resolution a click goes through)", () => {
		it("[[@gym:Workout Plan]] in Weekly Review.md resolves to the TFile at Sources/gym/ once it is indexed; [[@whoop:…]] no longer does", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(existsSync(rig.linkOf("gym"))).toBe(true);
			// What Obsidian indexes after the swap: the same files under the new link's name, none under the old.
			const after = new App();
			seedPaths(after, ["Weekly Review.md", "Leg Day.md", "Sources/gym/Workout Plan.md", "Sources/gym/Leg Day.md", "Sources/tephra/README.md"]);
			const hook = new LinkResolutionHook(after as never);
			const reference = obsidianFirstLinkpathDest(after as never);
			const opened = hook.resolveFile("@gym:Workout Plan", "Weekly Review.md", reference);
			expect(opened?.path).toBe("Sources/gym/Workout Plan.md");
			expect(opened).toBe(after.vault.getAbstractFileByPath("Sources/gym/Workout Plan.md")); // the very file a click opens
			expect(hook.resolveFile("@whoop:Workout Plan", "Weekly Review.md", reference)).toBeNull();
			// The same-source plain link inside the renamed source still resolves (F9).
			expect(hook.resolveFile("Leg Day", "Sources/gym/Workout Plan.md", reference)?.path).toBe("Sources/gym/Leg Day.md");
		});
	});

	describe("the fence", () => {
		it("F1: the remap reads no file and builds no index of the source: only Atlas's own stored paths are rewritten", async () => {
			const rig = await build();
			const rebuild = vi.spyOn(rig.unitIndex, "rebuild");
			const read = vi.spyOn(rig.app.vault as unknown as { read: () => Promise<string> }, "read");
			const cachedRead = vi.spyOn(rig.app.vault as unknown as { cachedRead: () => Promise<string> }, "cachedRead");
			const readdir = vi.spyOn(nodeFs.promises, "readdir");
			const readdirCallsBefore = readdir.mock.calls.length;
			await rig.plugin.remapSourcePaths("whoop", "gym");
			expect(rebuild).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
			expect(cachedRead).not.toHaveBeenCalled();
			expect(readdir.mock.calls.length).toBe(readdirCallsBefore);
		});

		it("F10: nothing but the path prefix changes in the views (ids, order, statuses, labels)", async () => {
			const rig = await build();
			const strip = (views: View[]) => JSON.stringify(views).replace(/Sources\/(whoop|gym)\//g, "Sources/X/");
			const before = strip(rig.viewsManager.getViews());
			await renameViaDialog(rig, "gym");
			expect(strip(rig.viewsManager.getViews())).toBe(before);
		});

		it("the plain same-source links inside the renamed source still resolve: the files under the target are unchanged, so [[Leg Day]] is untouched", async () => {
			const rig = await build();
			await renameViaDialog(rig, "gym");
			expect(readFileSync(join(rig.target, "Leg Day.md"), "utf8")).toBe("legs\n");
			expect(readFileSync(join(rig.linkOf("gym"), "Leg Day.md"), "utf8")).toBe("legs\n"); // reachable through the new name
		});
	});
});

describe("open tabs on the renamed source", () => {
	const NEW = "Sources/gym/Workout Plan.md";
	function leaf(path: string, log: string[], save = true): RenameTabLeaf & { states: unknown[] } {
		const states: unknown[] = [];
		return {
			states,
			view: save ? { save: async () => void log.push(`save ${path}`) } : null,
			getViewState: () => ({ type: "markdown", state: { file: path, mode: "source" } }),
			setViewState: async (state) => void states.push(state),
		};
	}

	it("flushes every tab on Sources/<old>/… before the swap, and reopens it at Sources/<new>/… once the new path is indexed", async () => {
		const log: string[] = [];
		const open = leaf("Sources/whoop/Workout Plan.md", log);
		const other = leaf("Weekly Review.md", log);
		const sibling = leaf("Sources/whoopee/Workout Plan.md", log);
		const indexed = new Set<string>();
		let created: () => void = () => {};
		const deps: RenameTabsDeps = {
			iterateLeaves: (visit) => [open, other, sibling].forEach(visit),
			isIndexed: (path) => indexed.has(path),
			whenIndexed: () => new Promise<void>((resolve) => void (created = resolve)),
			openLeaf: () => leaf("", log),
		};
		const reopen = await captureRenameTabs(deps, "whoop", "gym");
		expect(log).toEqual(["save Sources/whoop/Workout Plan.md"]); // only the tab on the source, saved first
		reopen();
		await flush();
		expect(open.states).toEqual([]); // not before Obsidian has the new file
		indexed.add(NEW);
		created();
		await flush();
		expect(open.states).toEqual([{ type: "markdown", state: { file: NEW, mode: "source" } }]);
		expect(other.states).toEqual([]);
		expect(sibling.states).toEqual([]);
	});

	it("a tab Obsidian closed when the file vanished is reopened in a new tab; one whose new file never appears is left alone", async () => {
		const log: string[] = [];
		const closed = leaf("Sources/whoop/Workout Plan.md", log);
		const missing = leaf("Sources/whoop/Gone.md", log);
		const fresh = leaf("", log);
		let live = [closed, missing];
		const deps: RenameTabsDeps = {
			iterateLeaves: (visit) => live.forEach(visit),
			isIndexed: (path) => path === NEW,
			whenIndexed: async () => {
				live = []; // both leaves were closed by Obsidian when the files were deleted
			},
			openLeaf: () => fresh,
		};
		const reopen = await captureRenameTabs(deps, "whoop", "gym");
		reopen();
		await flush();
		expect(fresh.states).toEqual([{ type: "markdown", state: { file: NEW, mode: "source" } }]);
		expect(closed.states).toEqual([]);
		expect(missing.states).toEqual([]);
	});

	it("a save that fails is logged and does not stop the rename; with no tab on the source there is nothing to reopen", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const bad: RenameTabLeaf = {
			view: { save: async () => Promise.reject(new Error("disk full")) },
			getViewState: () => ({ type: "markdown", state: { file: "Sources/whoop/a.md" } }),
			setViewState: async () => {},
		};
		const deps: RenameTabsDeps = { iterateLeaves: (visit) => visit(bad), isIndexed: () => false, whenIndexed: async () => {}, openLeaf: () => bad };
		await expect(captureRenameTabs(deps, "whoop", "gym")).resolves.toBeTypeOf("function");
		expect(error).toHaveBeenCalled();
		const none = await captureRenameTabs({ ...deps, iterateLeaves: () => {} }, "whoop", "gym");
		expect(none()).toBeUndefined();
		error.mockRestore();
	});
});
