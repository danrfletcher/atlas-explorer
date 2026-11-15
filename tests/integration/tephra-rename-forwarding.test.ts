import { afterEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { Platform, TFile, TFolder } from "obsidian";
import { makeRenameRig, type RenameRig } from "../tephra-rename-rig";
import { FALLBACK_MS } from "../../src/graduation";
import { TEPHRA_STALE_MESSAGE } from "../../src/tephra-rename-forwarder";
import { TEPHRA_RENAME_QUEUE_FILE } from "../../src/tephra-rename-queue";
import type { UnitRef, ViewNode } from "../../src/types";

// PR-10 (G11, E1, E7, R3-6): every vault rename reaches Tephra, in order, over the real client and the real online/offline
// state machine, through an on-disk queue. The daemon is a stub JSON-RPC server on 127.0.0.1 behind a bearer token; the vault
// is the Obsidian mock; `AtlasPlugin.onVaultRenameEvent` is the real handler. Waits poll with a bound, never a fixed sleep.

let rig: RenameRig | null = null;
afterEach(async () => {
	Platform.isMobile = false;
	await rig?.teardown();
	rig = null;
});

const TOKEN_HEADER = `Bearer ${"d".repeat(64)}`;
const WORKOUT = "Sources/notes/Workout Plan.md";
const TRAINING = "Sources/notes/Training Plan.md";
const WEEKLY = "Weekly Review.md";
const WEEKLY_TEXT = "Plan: [[@notes:Workout Plan]] and [text](Workout%20Plan.md) and [[Workout Plan]]\n";

const file = (r: RenameRig, path: string): TFile => r.app.vault.getAbstractFileByPath(path) as TFile;
const folder = (r: RenameRig, path: string): TFolder => r.app.vault.getAbstractFileByPath(path) as TFolder;
const sentPairs = (r: RenameRig) => r.daemon.renames.map((e) => [e.old_path, e.new_path]);
const flatNodes = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((node) => [node, ...flatNodes(node.children ?? [])]);
const storedRefs = (r: RenameRig): UnitRef[] =>
	flatNodes(r.viewsManager.getActiveView().root)
		.filter((n) => n.type === "unit")
		.map((n) => n.ref as UnitRef);

async function offline(r: RenameRig): Promise<void> {
	r.daemon.down = true;
	await r.check();
	expect(r.connection.isOnline()).toBe(false);
}
async function backOnline(r: RenameRig): Promise<void> {
	r.daemon.down = false;
	await r.check();
	expect(r.connection.isOnline()).toBe(true);
}
const writeCalls = (r: RenameRig) => (r.app.vault as unknown as { calls: string[] }).calls.filter((c) => c !== "rename" && c !== "read" && c !== "cachedRead");

describe("GP7: a rename reaches Tephra and nothing else is touched", () => {
	it("sends the exact old and new paths with the bearer token, then the queue is empty; views follow; no note is written; markdown links stay (F3, F5)", async () => {
		rig = await makeRenameRig({ files: { [WORKOUT]: "# plan\n", [WEEKLY]: WEEKLY_TEXT } });
		const r = rig;
		const view = r.viewsManager.getActiveView();
		expect(r.viewsManager.placeUnit(view.id, { kind: "file", path: WORKOUT }, null)).not.toBeNull();
		const callsBefore = (r.app.vault as unknown as { calls: string[] }).calls.length;

		await r.app.vault.rename(file(r, WORKOUT), TRAINING);
		await r.until(() => r.daemon.renames.length === 1, "the rename to reach Tephra");

		expect(r.daemon.renames[0]).toEqual({ old_path: WORKOUT, new_path: TRAINING, authorization: TOKEN_HEADER });
		await r.until(() => r.queueOnDisk()?.length === 0, "the acknowledged entry to leave the queue file");
		expect(storedRefs(r)).toEqual([{ kind: "file", path: TRAINING }]); // viewsManager.onVaultRename, as today
		// F3: Atlas wrote nothing; F5: the plain markdown link is exactly as it was
		expect(r.text(WEEKLY)).toBe(WEEKLY_TEXT);
		expect((r.app.vault as unknown as { calls: string[] }).calls.slice(callsBefore)).toEqual(["rename"]);
		expect(r.notices).toEqual([]);
	});

	it("F3: when Tephra answers with an error, Atlas rewrites no link and writes no note", async () => {
		rig = await makeRenameRig({ files: { [WORKOUT]: "x", [WEEKLY]: WEEKLY_TEXT } });
		const r = rig;
		r.daemon.replies.push({ error: { code: -32020, message: "refused: path is outside every source" } });
		await r.app.vault.rename(file(r, WORKOUT), TRAINING);
		await r.until(() => r.queueOnDisk()?.length === 0, "the refused entry to be dropped");
		expect(r.text(WEEKLY)).toBe(WEEKLY_TEXT);
		expect(writeCalls(r)).toEqual([]);
		expect(r.notices.some((n) => n.includes(WORKOUT))).toBe(true);
	});

	it("every rename event is sent, whatever the kind: a note, a folder, a move into another folder", async () => {
		rig = await makeRenameRig({ files: { "a.md": "", "Dir/b.md": "" }, folders: ["Dir", "Other"] });
		const r = rig;
		await r.app.vault.rename(file(r, "a.md"), "a2.md");
		await r.app.vault.rename(file(r, "Dir/b.md"), "Other/b.md");
		await r.app.vault.rename(folder(r, "Other"), "Other2");
		await r.until(() => r.daemon.renames.length === 3, "three renames");
		expect(sentPairs(r)).toEqual([["a.md", "a2.md"], ["Dir/b.md", "Other/b.md"], ["Other", "Other2"]]);
	});
});

describe("offline, back online, restarts (the queue on disk)", () => {
	it("offline: the rename is on disk before the handler returns and nothing is sent; online again: it is sent and removed only after the answer", async () => {
		rig = await makeRenameRig({ files: { "a.md": "" } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, "a.md"), "b.md"); // `emit` runs the handler synchronously
		expect(r.queueOnDisk()).toEqual([expect.objectContaining({ oldPath: "a.md", newPath: "b.md" })]); // already on disk, no await needed
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(r.daemon.renames).toEqual([]);
		expect(r.queueOnDisk()).toHaveLength(1);

		r.daemon.gate = new Promise(() => {}); // Tephra is back but has not answered yet
		r.daemon.down = false;
		await r.check();
		await r.until(() => r.daemon.requests.some((q) => q.method === "link.rename_event"), "the call to go out");
		expect(r.queueOnDisk()).toHaveLength(1); // sent, not acknowledged: still queued
	});

	it("an Obsidian restart while offline: the next load sends the queued renames first-in first-out once Tephra is up", async () => {
		rig = await makeRenameRig({ files: { "a.md": "", "b.md": "", "c.md": "" } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, "a.md"), "a2.md");
		await r.app.vault.rename(file(r, "b.md"), "b2.md");
		await r.app.vault.rename(file(r, "c.md"), "c2.md");
		r.restart(); // the plugin is gone and loaded again: only the file remains
		expect(r.forwarder.pending().map((e) => e.oldPath)).toEqual(["a.md", "b.md", "c.md"]);
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 3, "the queue to drain");
		expect(sentPairs(r)).toEqual([["a.md", "a2.md"], ["b.md", "b2.md"], ["c.md", "c2.md"]]);
		await r.until(() => r.queueOnDisk()?.length === 0, "an empty queue file");
	});

	it("A→B then B→C while offline are two ordered events", async () => {
		rig = await makeRenameRig({ files: { "A.md": "" } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, "A.md"), "B.md");
		await r.app.vault.rename(file(r, "B.md"), "C.md");
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 2, "both events");
		expect(sentPairs(r)).toEqual([["A.md", "B.md"], ["B.md", "C.md"]]);
	});

	it("E1: Tephra drops after acknowledging the first of three: the other two stay queued and are sent, in order, when it is back; the first is not sent again", async () => {
		rig = await makeRenameRig({ files: { "a.md": "", "b.md": "", "c.md": "" } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, "a.md"), "a2.md");
		await r.app.vault.rename(file(r, "b.md"), "b2.md");
		await r.app.vault.rename(file(r, "c.md"), "c2.md");
		r.daemon.downAfterRenames = 1;
		await backOnline(r);
		await r.until(() => r.daemon.down && r.queueOnDisk()?.length === 2, "the drop after the first acknowledgement");
		expect(r.queueOnDisk()!.map((e) => e.oldPath)).toEqual(["b.md", "c.md"]);
		await r.check();
		expect(r.connection.isOnline()).toBe(false);

		r.daemon.downAfterRenames = null;
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 3, "the rest of the queue");
		expect(sentPairs(r)).toEqual([["a.md", "a2.md"], ["b.md", "b2.md"], ["c.md", "c2.md"]]);
		await r.until(() => r.queueOnDisk()?.length === 0, "an empty queue");
	});

	it("a burst of 50 renames while offline: the file stays valid JSON with 50 entries in event order, and all 50 arrive in that order", async () => {
		rig = await makeRenameRig({ files: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`n${i}.md`, ""])) });
		const r = rig;
		await offline(r);
		for (let i = 0; i < 50; i++) await r.app.vault.rename(file(r, `n${i}.md`), `m${i}.md`);
		expect(r.queueOnDisk()!.map((e) => e.oldPath)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}.md`));
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 50, "all 50");
		expect(r.daemon.renames.map((e) => e.old_path)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}.md`));
		await r.until(() => r.queueOnDisk()?.length === 0, "an empty queue");
	});

	it("unicode, spaces, # ^ and [] survive the queue file and the wire byte for byte", async () => {
		const oldPath = "Café ☕/日本語 #1 ^2 [draft] — 🧪.md";
		const newPath = "Café ☕/ノート #1 ^2 [final] — 📓.md";
		rig = await makeRenameRig({ files: { [oldPath]: "" } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, oldPath), newPath);
		r.restart();
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 1, "the rename");
		expect(r.daemon.renames[0].old_path).toBe(oldPath);
		expect(r.daemon.renames[0].new_path).toBe(newPath);
	});

	it("turning the toggle off and on again keeps what was queued, and does not send what happened while it was off", async () => {
		rig = await makeRenameRig({ files: { "a.md": "", "b.md": "" } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, "a.md"), "a2.md");
		r.settings.tephraEnabled = false;
		await r.app.vault.rename(file(r, "b.md"), "b2.md"); // while off: not queued
		expect(r.queueOnDisk()).toEqual([expect.objectContaining({ oldPath: "a.md" })]);
		r.daemon.down = false;
		await r.check();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(r.daemon.renames).toEqual([]); // off: nothing leaves, even queued entries
		r.settings.tephraEnabled = true;
		await r.check();
		await r.until(() => r.daemon.renames.length === 1, "the entry queued before the toggle went off");
		expect(sentPairs(r)).toEqual([["a.md", "a2.md"]]); // b.md → b2.md is never sent
	});
});

describe("E7: 'file changed, try again'", () => {
	it("the offline rename is sent as recorded, the reply is followed (retried) with a Notice naming the file, nothing is rewritten, and later events still go in order", async () => {
		rig = await makeRenameRig({ files: { "a.md": "x", "c.md": "y", [WEEKLY]: WEEKLY_TEXT } });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, "a.md"), "b.md");
		await r.app.vault.rename(file(r, "b.md"), "b-edited.md"); // changed again before Tephra is back
		await r.app.vault.rename(file(r, "c.md"), "d.md");
		r.daemon.replies.push({ error: { code: -32010, message: `${TEPHRA_STALE_MESSAGE}: a.md` } });
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 4, "the stale entry to be retried and the rest sent");
		expect(sentPairs(r)).toEqual([["a.md", "b.md"], ["a.md", "b.md"], ["b.md", "b-edited.md"], ["c.md", "d.md"]]);
		expect(r.notices.filter((n) => n.includes("b.md"))).toHaveLength(1);
		expect(r.text(WEEKLY)).toBe(WEEKLY_TEXT);
		expect(writeCalls(r)).toEqual([]);
		await r.until(() => r.queueOnDisk()?.length === 0, "an empty queue");
	});
});

describe("external moves and folders", () => {
	it("a delete + create pair that src/external-move.ts reads as a move is replayed through onVaultRenameEvent and sent", async () => {
		rig = await makeRenameRig({ files: { "Inbox/Note.md": "n" }, folders: ["Inbox", "Projects"] });
		const r = rig;
		const vault = r.app.vault as unknown as { unlink(e: unknown): void; emit(n: string, ...a: unknown[]): void; seedFile(p: string): unknown };
		const gone = file(r, "Inbox/Note.md");
		vault.unlink(gone);
		vault.emit("delete", gone);
		const created = vault.seedFile("Projects/Note.md");
		vault.emit("create", created);
		await r.until(() => r.daemon.renames.length === 1, "the replayed rename");
		expect(sentPairs(r)).toEqual([["Inbox/Note.md", "Projects/Note.md"]]);
	});

	it("a plain create or a plain delete sends nothing", async () => {
		rig = await makeRenameRig({ files: { "x.md": "" } });
		const r = rig;
		const vault = r.app.vault as unknown as { unlink(e: unknown): void; emit(n: string, ...a: unknown[]): void; seedFile(p: string): unknown };
		vault.emit("create", vault.seedFile("fresh.md"));
		const gone = file(r, "x.md");
		vault.unlink(gone);
		vault.emit("delete", gone);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(r.daemon.renames).toEqual([]);
		expect(r.queueOnDisk() ?? []).toEqual([]);
	});

	it.each([
		["children reported after the folder", false],
		["children reported before the folder", true],
	])("a folder with 200 children renamed is one event, not 201 (%s)", async (_name, childrenFirst) => {
		const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`Old/c${i}.md`, ""]));
		rig = await makeRenameRig({ files, folders: ["Old"] });
		const r = rig;
		await offline(r);
		const old = folder(r, "Old");
		const children = Array.from({ length: 200 }, (_, i) => file(r, `Old/c${i}.md`));
		const emit = (e: unknown, oldPath: string) => (r.app.vault as unknown as { emit(n: string, ...a: unknown[]): void }).emit("rename", e, oldPath);
		if (childrenFirst) {
			// Obsidian may report a child before its folder: the child already lives at its new path
			children.forEach((child, i) => {
				(child as { path: string }).path = `New/c${i}.md`;
				emit(child, `Old/c${i}.md`);
			});
			(old as { path: string }).path = "New";
			emit(old, "Old");
		} else {
			(old as { path: string }).path = "New";
			emit(old, "Old");
			children.forEach((child, i) => {
				(child as { path: string }).path = `New/c${i}.md`;
				emit(child, `Old/c${i}.md`);
			});
		}
		expect(r.queueOnDisk()!.map((e) => [e.oldPath, e.newPath])).toEqual([["Old", "New"]]);
		await backOnline(r);
		await r.until(() => r.daemon.renames.length === 1, "the folder event");
		expect(sentPairs(r)).toEqual([["Old", "New"]]);
	});
});

describe("toggle off and mobile", () => {
	it("toggle off: no rename is queued or sent, and no queue file is even created", async () => {
		rig = await makeRenameRig({ enabled: false, files: { "a.md": "" } });
		const r = rig;
		await r.app.vault.rename(file(r, "a.md"), "b.md");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(r.daemon.renames).toEqual([]);
		expect(readdirSync(r.dir)).not.toContain(TEPHRA_RENAME_QUEUE_FILE);
	});

	it("mobile behaves as toggle off, whatever data.json says", async () => {
		Platform.isMobile = true;
		rig = await makeRenameRig({ enabled: true, files: { "a.md": "" } });
		const r = rig;
		await r.app.vault.rename(file(r, "a.md"), "b.md");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(r.daemon.renames).toEqual([]);
		expect(readdirSync(r.dir)).not.toContain(TEPHRA_RENAME_QUEUE_FILE);
	});
});

describe("a corrupt queue file at load", () => {
	it("is kept aside as .corrupt-<ts>, one Notice, an empty queue, and the plugin carries on", async () => {
		rig = await makeRenameRig({ queueFile: "{not json", files: { "a.md": "" } });
		const r = rig;
		expect(r.notices).toEqual(["corrupt queue: not valid JSON"]);
		const names = readdirSync(r.dir);
		expect(names.filter((n) => n.startsWith(`${TEPHRA_RENAME_QUEUE_FILE}.corrupt-`))).toHaveLength(1);
		expect(names).not.toContain(TEPHRA_RENAME_QUEUE_FILE);
		await r.app.vault.rename(file(r, "a.md"), "b.md");
		await r.until(() => r.daemon.renames.length === 1, "the new rename to be sent");
		expect(r.notices).toHaveLength(1);
	});
});

describe("R3-6: graduation waits for Tephra's acknowledgement while the toggle is on", () => {
	const ID = "_pool/20260925143012-k3xq.md";
	const exists = (r: RenameRig, path: string) => r.app.vault.getAbstractFileByPath(path) !== null;

	it("online: the move happens when Tephra acknowledges the pool rename (well before FALLBACK_MS), and both renames reach Tephra in order", async () => {
		rig = await makeRenameRig({ files: { [ID]: "text" }, realGraduation: true });
		const r = rig;
		let release!: () => void;
		r.daemon.gate = new Promise<void>((resolve) => (release = resolve));
		await r.app.vault.rename(file(r, ID), "_pool/Quarry drone.md");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(exists(r, "Quarry drone.md")).toBe(false); // unacknowledged: still in the pool
		const t0 = Date.now();
		r.daemon.gate = null;
		release();
		await r.until(() => exists(r, "Quarry drone.md"), "the graduation");
		expect(Date.now() - t0).toBeLessThan(FALLBACK_MS - 500);
		await r.until(() => r.daemon.renames.length === 2, "the graduation's own rename");
		expect(sentPairs(r)).toEqual([[ID, "_pool/Quarry drone.md"], ["_pool/Quarry drone.md", "Quarry drone.md"]]);
	});

	it("offline: it still graduates on FALLBACK_MS, and both renames are in the queue in order", async () => {
		rig = await makeRenameRig({ files: { [ID]: "text" }, realGraduation: true });
		const r = rig;
		await offline(r);
		await r.app.vault.rename(file(r, ID), "_pool/Quarry drone.md");
		await new Promise((resolve) => setTimeout(resolve, FALLBACK_MS / 3));
		expect(exists(r, "Quarry drone.md")).toBe(false);
		await r.until(() => exists(r, "Quarry drone.md"), "the fallback graduation", FALLBACK_MS * 2);
		expect(r.queueOnDisk()!.map((e) => [e.oldPath, e.newPath])).toEqual([[ID, "_pool/Quarry drone.md"], ["_pool/Quarry drone.md", "Quarry drone.md"]]);
		expect(r.daemon.renames).toEqual([]);
	});
});
