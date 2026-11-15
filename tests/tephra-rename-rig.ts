/** PR-10 (G11): the real plugin's vault-event handlers (`onVaultRenameEvent`, `onVaultCreateEvent`, `onVaultDeleteEvent`) wired
 * to a real `TephraRenameForwarder` over a real on-disk queue file, a real `TephraClient` and `TephraConnection` (the PR-9
 * online/offline state machine) talking HTTP to a stub JSON-RPC server on 127.0.0.1 behind a bearer token. Stand-ins: Obsidian
 * (the shared mock vault) and the daemon (`tests/fixtures/fake-tephra-server.mjs` with a `link.rename_event` method of this
 * rig's own: Tephra part 2 is not on Tephra's `dev` branch yet). Not a `*.test.ts` file, so vitest's glob skips it. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "obsidian";
import AtlasPlugin from "../src/main";
import { ExternalMoveDetector } from "../src/external-move";
import { FolderLiveRefresh } from "../src/folder-live-refresh";
import { GraduationController } from "../src/graduation";
import { DEFAULT_SETTINGS, type AtlasSettings } from "../src/settings";
import { SourceDeleteClassifier } from "../src/source-delete-classifier";
import { TephraClient, type TephraRequestFn } from "../src/tephra-client";
import { TephraConnection } from "../src/tephra-connection";
import { TephraRenameForwarder, TEPHRA_RENAME_METHOD } from "../src/tephra-rename-forwarder";
import { TEPHRA_RENAME_QUEUE_FILE, TephraRenameQueue } from "../src/tephra-rename-queue";
import { nodeQueueStorage } from "../src/tephra-rename-queue-fs";
import { UnitIndex } from "../src/unit-index";
import { ViewsManager } from "../src/views";
import { startFakeTephra } from "./fixtures/fake-tephra-server.mjs";

const TOKEN = "d".repeat(64);

export interface RenameRig {
	app: App;
	settings: AtlasSettings;
	plugin: AtlasPlugin & Record<string, unknown>;
	viewsManager: ViewsManager;
	forwarder: TephraRenameForwarder;
	connection: TephraConnection;
	graduation: GraduationController;
	/** The queue file Atlas writes, and its folder. */
	queuePath: string;
	dir: string;
	/** What is in the queue file now (null: no file). */
	queueOnDisk(): Array<{ oldPath: string; newPath: string }> | null;
	daemon: {
		/** Every `link.rename_event` that reached the stub (whatever it answered), in arrival order. */
		renames: Array<{ old_path: string; new_path: string; authorization: string }>;
		/** Every request of any method, with the bearer header it carried. */
		requests: Array<{ method: string; authorization: string }>;
		/** Replies to the next rename events, one each; empty means acknowledge. */
		replies: Array<{ result: unknown } | { error: { code: number; message: string } }>;
		/** Stopped: every request fails as a refused connection does. */
		down: boolean;
		/** When set, rename events wait on it before being answered. */
		gate: Promise<void> | null;
		/** Tephra dies after this many rename events have been answered (`down` turns true by itself). */
		downAfterRenames: number | null;
	};
	notices: string[];
	/** One finished Tephra check (as the 10 s timer or a focus does); a check that finds it online kicks the queue, as in `main.ts`. */
	check(): Promise<void>;
	/** Waits (bounded, polling) until `done()` holds, else throws with `what`. */
	until(done: () => boolean, what: string, ms?: number): Promise<void>;
	/** A restart: a new forwarder over the same queue file, wired into the same plugin object. */
	restart(): TephraRenameForwarder;
	/** Reads the file's text through the mock vault (no `calls` entry). */
	text(path: string): string | undefined;
	teardown(): Promise<void>;
}

export interface RenameRigOptions {
	enabled?: boolean;
	down?: boolean;
	files?: Record<string, string>;
	folders?: string[];
	/** A queue file's text to put in place before the first load (a corrupt one, say). */
	queueFile?: string;
	/** Real graduation timers (`FALLBACK_MS`); the default plugin object has a stub that records only. */
	realGraduation?: boolean;
}

export async function makeRenameRig(options: RenameRigOptions = {}): Promise<RenameRig> {
	const app = new App();
	const vault = app.vault as unknown as { seedFolder(path: string): unknown; seedFile(path: string): unknown; getAbstractFileByPath(path: string): unknown };
	const ensureFolder = (path: string) => {
		if (path === "" || vault.getAbstractFileByPath(path)) return;
		ensureFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
		vault.seedFolder(path);
	};
	ensureFolder("_pool");
	for (const folder of options.folders ?? []) ensureFolder(folder);
	for (const [path, content] of Object.entries(options.files ?? {})) {
		ensureFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
		vault.seedFile(path);
		(app.vault as unknown as { contents: Map<string, string> }).contents.set(path, content);
	}
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: options.enabled ?? true };
	const unitIndex = new UnitIndex(app as never, settings, []);
	unitIndex.rebuild();
	const viewsManager = new ViewsManager(app as never, [], "", () => {});

	const dir = mkdtempSync(join(tmpdir(), "atlas-rename-rig-"));
	const tokenFile = join(dir, "token");
	writeFileSync(tokenFile, TOKEN);
	const queuePath = join(dir, TEPHRA_RENAME_QUEUE_FILE);
	if (options.queueFile !== undefined) writeFileSync(queuePath, options.queueFile);

	const daemon: RenameRig["daemon"] = { renames: [], requests: [], replies: [], down: options.down ?? false, gate: null, downAfterRenames: null };
	const fake = await startFakeTephra({
		port: 0,
		tokenFile,
		sources: [{ name: "notes", path: "/home/user/Documents/Notes", status: "online" }],
		methods: {
			[TEPHRA_RENAME_METHOD]: () => daemon.replies.shift() ?? { result: { rewritten: 0 } },
		},
	});
	const request: TephraRequestFn = async ({ url, method, headers, body }) => {
		const parsed = JSON.parse(body) as { method: string; params?: { old_path: string; new_path: string } };
		if (daemon.down) throw new Error("connect ECONNREFUSED 127.0.0.1:4812"); // the client reads this as `network`
		const authorization = String((headers as Record<string, string>).Authorization ?? "");
		daemon.requests.push({ method: parsed.method, authorization });
		if (parsed.method === TEPHRA_RENAME_METHOD && daemon.gate) await daemon.gate;
		const response = await fetch(url.replace(":4812", `:${fake.port}`), { method, headers, body });
		const text = await response.text();
		if (parsed.method === TEPHRA_RENAME_METHOD && parsed.params) {
			daemon.renames.push({ old_path: parsed.params.old_path, new_path: parsed.params.new_path, authorization });
			if (daemon.downAfterRenames !== null && daemon.renames.length >= daemon.downAfterRenames) daemon.down = true;
		}
		return { status: response.status, text } as Awaited<ReturnType<TephraRequestFn>>;
	};
	const client = new TephraClient({ request, tokenPath: () => tokenFile, openSocket: async () => ({ kind: "error" }) });
	const connection = new TephraConnection(client);
	const notices: string[] = [];

	// Delays are scaled down so a retry pause or the coalescing wait doesn't make a test slow; order is unchanged.
	const scaled = { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, Math.min(ms, 3)), clearTimeout: (h: unknown) => clearTimeout(h as never) };
	const buildForwarder = () =>
		new TephraRenameForwarder({
			queue: new TephraRenameQueue({ storage: nodeQueueStorage, path: queuePath, now: () => Date.now(), onCorrupt: ({ reason }) => void notices.push(`corrupt queue: ${reason}`), onWriteError: (error) => { throw error; } }),
			scheduler: scaled,
			now: () => Date.now(),
			isActive: () => plugin.tephraActive(),
			getConnection: () => connection,
			notify: (message) => void notices.push(message),
			log: () => {},
		});
	let forwarder = buildForwarder();
	forwarder.load();

	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const externalMoveDetector = new ExternalMoveDetector();
	const graduation = new GraduationController({
		vault: app.vault as never,
		fileManager: app.fileManager as never,
		scheduler: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as never) },
		getPoolFolder: () => settings.poolFolder,
		getExcludedFolders: () => settings.excludedFolders,
		notify: () => {},
		afterMove: () => {},
		openDialog: async () => null,
		tephraAcks: {
			isActive: () => plugin.tephraActive(),
			whenAcknowledged: (o, n, cb) => plugin.tephraRenames.whenAcknowledged(o, n, cb),
		},
	});
	Object.assign(plugin, {
		app,
		settings,
		viewsManager,
		unitIndex,
		externalMoveDetector,
		folderLiveRefresh: new FolderLiveRefresh(() => {}),
		persistDebounced: Object.assign(() => {}, { cancel: () => {}, run: () => {} }),
		expandedModuleFolders: new Set<string>(),
		sourceDeleteClassifier: new SourceDeleteClassifier({ getLinkTargets: () => [], targetExists: () => true }),
		graduation: options.realGraduation ? graduation : { handleRename: () => {}, handleDelete: () => {}, handleModify: () => {} },
		tephraRenames: forwarder,
		saveSettings: async () => {},
	});
	app.vault.on("rename", (file: unknown, oldPath: string) => plugin.onVaultRenameEvent(file as never, oldPath));
	app.vault.on("create", (file: unknown) => plugin.onVaultCreateEvent(file as never));
	app.vault.on("delete", (file: unknown) => plugin.onVaultDeleteEvent(file as never));
	connection.onCheck((snapshot) => {
		if (snapshot.state === "online") (plugin.tephraRenames as TephraRenameForwarder).kick();
	});
	connection.start();
	await connection.check();

	const rig: RenameRig = {
		app,
		settings,
		plugin,
		viewsManager,
		get forwarder() {
			return forwarder;
		},
		connection,
		graduation,
		queuePath,
		dir,
		queueOnDisk: () => {
			try {
				return (JSON.parse(readFileSync(queuePath, "utf8")) as { entries: Array<{ oldPath: string; newPath: string }> }).entries;
			} catch {
				return null;
			}
		},
		daemon,
		notices,
		check: async () => {
			await connection.check();
		},
		until: async (done, what, ms = 3000) => {
			const end = Date.now() + ms;
			while (!done()) {
				if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
		},
		restart: () => {
			forwarder.dispose();
			forwarder = buildForwarder();
			(plugin as Record<string, unknown>).tephraRenames = forwarder;
			forwarder.load();
			return forwarder;
		},
		text: (path) => (app.vault as unknown as { contents: Map<string, string> }).contents.get(path),
		teardown: async () => {
			forwarder.dispose();
			graduation.dispose();
			externalMoveDetector.cancelAll();
			connection.stop();
			await fake.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return rig;
}
