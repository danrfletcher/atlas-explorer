import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice, TFile } from "obsidian";
import { FALLBACK_MS, GraduationController, Scheduler, SETTLE_MS, TOAST_MS, classifyRename, isIdLikeName } from "../../src/graduation";
import { isNameTakenAtRoot } from "../../src/name-rules";
import { flush } from "../helpers";

const ID = "_pool/20260925143012-k3xq.md";
const CLASH = (n: string) => `A note or folder called '${n}' already exists at the vault root`;

class FakeScheduler implements Scheduler {
	now = 0;
	private next = 1;
	private timers = new Map<number, { at: number; cb: () => void }>();
	setTimeout(cb: () => void, ms: number): unknown {
		const id = this.next++;
		this.timers.set(id, { at: this.now + ms, cb });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}
	get size(): number {
		return this.timers.size;
	}
	async advance(ms: number): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.now = due[1].at;
			due[1].cb();
			await flush();
		}
		this.now = end;
		await flush();
	}
}

interface Rig {
	app: App;
	ctrl: GraduationController;
	scheduler: FakeScheduler;
	openDialog: ReturnType<typeof vi.fn>;
	afterMove: ReturnType<typeof vi.fn>;
	onHiddenMove: ReturnType<typeof vi.fn>;
	renameFile: ReturnType<typeof vi.spyOn>;
	pool: { value: string };
	resolved(): Promise<void>;
	/** A user's rename (outside Atlas's spy): the vault event fires the same way Obsidian's does. */
	userRename(file: TFile, newPath: string): Promise<void>;
	toasts(): string[];
}

/** R3-6: a stand-in for Tephra's rename acknowledgement. `ack()` is what the rename forwarder does when Tephra answers. */
interface FakeAcks {
	active: boolean;
	waits: Array<{ oldPath: string; newPath: string; cb: () => void; stopped: boolean }>;
	ack(oldPath: string, newPath: string): void;
}
const fakeAcks = (active: boolean): FakeAcks => {
	const acks: FakeAcks = {
		active,
		waits: [],
		ack(oldPath, newPath) {
			for (const wait of acks.waits) if (!wait.stopped && wait.oldPath === oldPath && wait.newPath === newPath) wait.cb();
		},
	};
	return acks;
};

function rig(seed: (app: App) => void = () => {}, acks?: FakeAcks): Rig {
	const app = new App();
	app.vault.seedFolder("_pool");
	seed(app);
	const scheduler = new FakeScheduler();
	const pool = { value: "_pool" };
	const openDialog = vi.fn<(o: unknown) => Promise<string | null>>();
	const afterMove = vi.fn();
	const onHiddenMove = vi.fn();
	const ctrl = new GraduationController({
		vault: app.vault,
		fileManager: app.fileManager,
		scheduler,
		getPoolFolder: () => pool.value,
		getExcludedFolders: () => ["_pool"],
		notify: (message, ms) => void new Notice(message, ms),
		afterMove,
		onHiddenMove,
		openDialog: openDialog as never,
		tephraAcks: acks && {
			isActive: () => acks.active,
			whenAcknowledged: (oldPath, newPath, cb) => {
				const wait = { oldPath, newPath, cb, stopped: false };
				acks.waits.push(wait);
				return () => {
					wait.stopped = true;
				};
			},
		},
	});
	app.vault.on("rename", (file: never, oldPath: string) => ctrl.handleRename(file, oldPath));
	app.vault.on("delete", (file: never) => ctrl.handleDelete(file));
	app.vault.on("modify", () => ctrl.handleModify());
	app.metadataCache.on("resolved", () => ctrl.handleResolved());
	const renameFile = vi.spyOn(app.fileManager, "renameFile");
	return {
		app,
		ctrl,
		scheduler,
		openDialog,
		afterMove,
		onHiddenMove,
		renameFile,
		pool,
		async resolved() {
			app.metadataCache.trigger("resolved");
			await scheduler.advance(SETTLE_MS);
		},
		userRename: (file, newPath) => app.vault.rename(file, newPath),
		toasts: () => Notice.instances.map((n) => n.message),
	};
}

const file = (r: Rig, path: string) => r.app.vault.getAbstractFileByPath(path) as TFile;
const exists = (r: Rig, path: string) => r.app.vault.getAbstractFileByPath(path) !== null;

beforeEach(() => Notice.reset());

describe("UT-1 isIdLikeName", () => {
	it.each(["20260925143012-k3xq", "20260925143012-K3XQ", "00000000000000-0000", "20260925143012-zzzz"])("%s is ID-like", (n) => {
		expect(isIdLikeName(n)).toBe(true);
	});
	it.each([
		"20260925143012-k3x",
		"20260925143012-k3xqq",
		"2026092514301-k3xq",
		"20260925143012_k3xq",
		"20260925143012-k3x!",
		"20260925143012-k3xq copy",
		" 20260925143012-k3xq",
		"x20260925143012-k3xq",
		"Untitled",
		"",
	])("%j is not ID-like", (n) => {
		expect(isIdLikeName(n)).toBe(false);
	});
});

describe("UT-2 classifyRename", () => {
	const G = { action: "graduate" };
	const ig = (reason: string) => ({ action: "ignore", reason });
	const rows: [string, string, string, boolean, string, unknown][] = [
		["AC-1 non-ID name", ID, "_pool/Quarry drone LiDAR.md", true, "_pool", G],
		["EC-1 ID-like", ID, "_pool/20260925150000-a1b2.md", true, "_pool", ig("id-like")],
		["EC-1 ID-like upper case", ID, "_pool/20260925150000-A1B2.md", true, "_pool", ig("id-like")],
		["EC-2 3 chars", ID, "_pool/20260925143012-k3x.md", true, "_pool", G],
		["EC-2 5 chars", ID, "_pool/20260925143012-k3xqq.md", true, "_pool", G],
		["EC-2 13 digits", ID, "_pool/2026092514301-k3xq.md", true, "_pool", G],
		["EC-2 underscore", ID, "_pool/20260925143012_k3xq.md", true, "_pool", G],
		["EC-2 bang", ID, "_pool/20260925143012-k3x!.md", true, "_pool", G],
		["EC-2 copy", ID, "_pool/20260925143012-k3xq copy.md", true, "_pool", G],
		["EC-2 prefix", ID, "_pool/x20260925143012-k3xq.md", true, "_pool", G],
		["EC-3 move to Archive", ID, "Archive/20260925143012-k3xq.md", true, "_pool", ig("moved")],
		["EC-4 root rename", "Loose.md", "Loose 2.md", true, "_pool", ig("outside-pool")],
		["EC-4 nested rename", "Recipes/Pasta.md", "Recipes/Pasta 2.md", true, "_pool", ig("outside-pool")],
		["EC-4 interface note", "Recipes/Recipes.md", "Recipes/Recipes 2.md", true, "_pool", ig("outside-pool")],
		["EC-4 prefix lookalike", "_pool-archive/Note.md", "_pool-archive/Note 2.md", true, "_pool", ig("outside-pool")],
		["EC-5 dropped into the pool", "Loose.md", "_pool/Loose.md", true, "_pool", ig("moved")],
		["EC-6 pdf", "_pool/scan.pdf", "_pool/scan 2.pdf", true, "_pool", ig("not-markdown")],
		["EC-6 txt", "_pool/data.txt", "_pool/data 2.txt", true, "_pool", ig("not-markdown")],
		["EC-6 canvas", "_pool/board.canvas", "_pool/board 2.canvas", true, "_pool", ig("not-markdown")],
		["EC-6 md to txt", "_pool/Note.md", "_pool/Note.txt", true, "_pool", ig("not-markdown")],
		["EC-6 txt to md", "_pool/Note.txt", "_pool/Note.md", true, "_pool", ig("not-markdown")],
		["EC-7 sub-folder file", "_pool/sub/20260101000000-aaaa.md", "_pool/sub/Idea.md", true, "_pool", ig("outside-pool")],
		["EC-7 up from sub", "_pool/sub/Idea.md", "_pool/Idea.md", true, "_pool", ig("moved")],
		["EC-7 down into sub", "_pool/Idea.md", "_pool/sub/Idea.md", true, "_pool", ig("moved")],
		["EC-7 sub-folder itself", "_pool/sub", "_pool/sub2", false, "_pool", ig("not-a-file")],
		["EC-8 pool folder itself", "_pool", "_pool2", false, "_pool", ig("not-a-file")],
		["EC-9 empty pool", "Loose.md", "Loose 2.md", true, "", ig("no-pool")],
		["EC-9 slash pool", "Loose.md", "Loose 2.md", true, "/", ig("no-pool")],
		["EC-9 dot pool", "Loose.md", "Loose 2.md", true, ".", ig("no-pool")],
		["EC-9 nested file, empty pool", "A/Loose.md", "A/Loose 2.md", true, "", ig("no-pool")],
		["EC-10 sync delivered move", ID, "Quarry drone LiDAR.md", true, "_pool", ig("moved")],
		["same name", "_pool/Untitled.md", "_pool/Untitled.md", true, "_pool", ig("same-name")],
		["EC-32 case-only", "_pool/Untitled.md", "_pool/UNTITLED.md", true, "_pool", G],
		["EC-32 ID upper-cased", ID, "_pool/20260925143012-K3XQ.md", true, "_pool", ig("id-like")],
		["nested pool setting", "Inbox/pool/Untitled.md", "Inbox/pool/Idea.md", true, "Inbox/pool", G],
	];
	it.each(rows)("%s", (_label, oldPath, newPath, isFile, pool, expected) => {
		expect(classifyRename(oldPath, newPath, isFile, pool)).toEqual(expected);
	});
});

describe("UT-3 isNameTakenAtRoot", () => {
	const root = [
		{ name: "Reading list.md", kind: "file" as const },
		{ name: "Recipes", kind: "folder" as const },
		{ name: "Diagram.png", kind: "file" as const },
		{ name: "Projects", kind: "folder" as const },
	];
	it("flags a note, a folder, and the case-insensitive variants", () => {
		expect(isNameTakenAtRoot("Reading list", root)).toBe(true);
		expect(isNameTakenAtRoot("reading LIST", root)).toBe(true);
		expect(isNameTakenAtRoot("recipes", root)).toBe(true);
	});
	it("does not flag other extensions, nested notes or free names", () => {
		expect(isNameTakenAtRoot("Diagram", root)).toBe(false);
		expect(isNameTakenAtRoot("Reading list 2", root)).toBe(false);
		// `Projects/Reading list.md` is not a root child, so it never appears in the root list.
		expect(isNameTakenAtRoot("Reading list", [{ name: "Projects", kind: "folder" }])).toBe(false);
	});
	it("the message keeps the typed casing", async () => {
		const r = rig((app) => app.vault.seedFile("Reading list.md"));
		const f = r.app.vault.seedFile("_pool/20260925143012-k3xq.md");
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, "_pool/reading LIST.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).toHaveBeenCalledTimes(1);
		expect(CLASH("reading LIST")).toBe("A note or folder called 'reading LIST' already exists at the vault root");
	});
});

describe("UT-4 pending record", () => {
	it("first event stores file and original path; a second keeps the original; graduation clears it", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/B.md");
		expect(r.ctrl.getPending(f)).toMatchObject({ file: f, originalPath: ID });
		await r.userRename(f, "_pool/C.md");
		expect(r.ctrl.getPending(f)).toMatchObject({ file: f, originalPath: ID });
		expect(r.ctrl.pendingCount()).toBe(1);
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.ctrl.getPending(f)).toBeUndefined();
	});

	it("an unrelated file gets its own record; delete clears one", async () => {
		const r = rig();
		const a = r.app.vault.seedFile(ID);
		const b = r.app.vault.seedFile("_pool/Untitled.md");
		await r.userRename(a, "_pool/A2.md");
		await r.userRename(b, "_pool/B2.md");
		expect(r.ctrl.pendingCount()).toBe(2);
		expect(r.ctrl.getPending(b)?.originalPath).toBe("_pool/Untitled.md");
		await r.app.vault.delete(a);
		expect(r.ctrl.getPending(a)).toBeUndefined();
		expect(r.ctrl.pendingCount()).toBe(1);
	});

	it("a Cancel restore clears it", async () => {
		const r = rig((app) => app.vault.seedFile("Reading list.md"));
		const f = r.app.vault.seedFile(ID);
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.ctrl.pendingCount()).toBe(0);
	});
});

describe("UT-5 revert memory", () => {
	it("swallows the matching event once, then not again", () => {
		const r = rig();
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		r.ctrl.noteOwnRevert("_pool/Untitled.md");
		expect(r.ctrl.handleRename(f, "_pool/Reading list.md")).toBe("swallowed");
		expect(r.ctrl.getOwnReverts().size).toBe(0);
		expect(r.ctrl.handleRename(f, "_pool/Reading list.md")).toBe("scheduled");
	});

	it("a failed revert also forgets the entry (EC-24)", async () => {
		const r = rig((app) => app.vault.seedFile("Reading list.md"));
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		await r.userRename(f, "_pool/Reading list.md");
		r.app.vault.seedFile("_pool/Untitled.md"); // the original path is taken while the dialog is open
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		r.openDialog.mockResolvedValue(null);
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.ctrl.getOwnReverts().size).toBe(0);
		expect(r.toasts().some((m) => m.startsWith("Atlas: couldn't put"))).toBe(true);
		expect(file(r, "_pool/Reading list.md")).toBe(f); // left where it is, not graduated
		expect(exists(r, "Reading list 2.md")).toBe(false);
		errors.mockRestore();
	});

	it("entries never survive dispose", () => {
		const r = rig();
		r.ctrl.noteOwnRevert("_pool/Untitled.md");
		r.ctrl.dispose();
		expect(r.ctrl.getOwnReverts().size).toBe(0);
	});
});

describe("UT-6 scheduling", () => {
	it("EC-13 nothing is renamed inside the event handler; the move waits for resolved", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Quarry drone LiDAR.md");
		expect(r.renameFile).toHaveBeenCalledTimes(0);
		await r.scheduler.advance(SETTLE_MS - 1);
		expect(r.renameFile).toHaveBeenCalledTimes(0); // no resolved yet
		r.app.metadataCache.trigger("resolved");
		await r.scheduler.advance(SETTLE_MS - 1);
		expect(r.renameFile).toHaveBeenCalledTimes(0); // still settling
		await r.scheduler.advance(1);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(exists(r, "Quarry drone LiDAR.md")).toBe(true);
	});

	it("EC-14 link rewrites (modify) and a later resolved push the move back", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		const linker = r.app.vault.seedFile("Linker-01.md");
		await r.userRename(f, "_pool/Quarry drone LiDAR.md");
		r.app.metadataCache.trigger("resolved"); // an early resolved, before the linkers are rewritten
		await r.scheduler.advance(SETTLE_MS - 10);
		await r.app.vault.modify(linker, "[[Quarry drone LiDAR]]");
		await r.scheduler.advance(SETTLE_MS - 10);
		expect(r.renameFile).toHaveBeenCalledTimes(0);
		r.app.metadataCache.trigger("resolved");
		await r.scheduler.advance(SETTLE_MS);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
	});

	it("EC-15 the fallback timer moves it with no resolved event", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Quarry drone LiDAR.md");
		await r.scheduler.advance(FALLBACK_MS - 1);
		expect(r.renameFile).toHaveBeenCalledTimes(0);
		await r.scheduler.advance(1);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(FALLBACK_MS).toBeLessThan(2000);
	});

	it("no run after dispose (EC-16 unload)", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Quarry drone LiDAR.md");
		r.ctrl.dispose();
		await r.scheduler.advance(FALLBACK_MS * 2);
		expect(r.renameFile).toHaveBeenCalledTimes(0);
		expect(exists(r, "_pool/Quarry drone LiDAR.md")).toBe(true);
	});

	it("EC-17 chained renames give one graduation, to the last name, with one toast", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/B.md");
		await r.userRename(f, "_pool/C.md");
		await r.resolved();
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(file(r, "C.md")).toBe(f);
		expect(r.toasts()).toEqual(["Moved 'C' out of the pool"]);
		expect(r.scheduler.size).toBe(0);
	});
});

describe("UT-7 preconditions are re-checked at run time", () => {
	const cases: [string, (r: Rig, f: TFile) => Promise<void> | void][] = [
		["deleted", (r, f) => r.app.vault.delete(f)],
		["moved out of the pool", async (r, f) => {
			r.app.vault.seedFolder("Archive");
			await r.app.vault.rename(f, "Archive/Quarry.md");
		}],
		["renamed back to an ID-like name", (r, f) => r.userRename(f, "_pool/20260925143012-k3xq.md")],
		["pool setting changed", (r) => {
			r.pool.value = "_other";
		}],
	];
	it.each(cases)("%s", async (_label, act) => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Quarry.md");
		await act(r, f);
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.renameFile).not.toHaveBeenCalled();
		expect(r.toasts()).toEqual([]);
		expect(r.openDialog).not.toHaveBeenCalled();
		expect(r.ctrl.pendingCount()).toBe(0);
	});
});

describe("UT-8 the graduation move", () => {
	it("calls fileManager.renameFile once (never vault.rename directly) and shows one toast", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		const vaultRename = vi.spyOn(r.app.vault, "rename");
		await r.userRename(f, "_pool/Quarry drone LiDAR.md");
		vaultRename.mockClear();
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(r.renameFile.mock.calls[0][1]).toBe("Quarry drone LiDAR.md");
		expect(vaultRename).toHaveBeenCalledTimes(1); // only reached through fileManager.renameFile
		expect(r.app.vault.calls.filter((c) => c === "fileManager.renameFile")).toHaveLength(1);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toBe("Moved 'Quarry drone LiDAR' out of the pool");
		expect(Notice.instances[0].duration).toBeGreaterThanOrEqual(3000);
		expect(Notice.instances[0].duration).toBeLessThanOrEqual(6000);
		expect(TOAST_MS).toBe(Notice.instances[0].duration);
		expect(r.afterMove).toHaveBeenCalledTimes(1);
		expect(exists(r, ID)).toBe(false);
	});

	it("EC-37 punctuation and emoji stay as typed", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Ideas (v2) 🚀.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.toasts()).toEqual(["Moved 'Ideas (v2) 🚀' out of the pool"]);
	});

	it("EC-32 a case-only rename graduates once, with no dialog", async () => {
		const r = rig();
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		await r.userRename(f, "_pool/UNTITLED.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "UNTITLED.md")).toBe(f);
		expect(r.openDialog).not.toHaveBeenCalled();
		expect(r.toasts()).toEqual(["Moved 'UNTITLED' out of the pool"]);
	});

	it("a move that throws reports an error and leaves the file where it is", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Quarry.md");
		r.renameFile.mockRejectedValueOnce(new Error("boom"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.toasts()).toEqual(["Atlas: couldn't move 'Quarry' out of the pool"]);
		expect(r.afterMove).not.toHaveBeenCalled();
		expect(exists(r, "_pool/Quarry.md")).toBe(true);
		errors.mockRestore();
	});
});

describe("EC-1..EC-12 never graduates (controller level)", () => {
	async function untouched(r: Rig, act: () => Promise<void>) {
		await act();
		await r.scheduler.advance(FALLBACK_MS * 2);
		expect(r.renameFile).not.toHaveBeenCalled();
		expect(r.toasts()).toEqual([]);
		expect(r.openDialog).not.toHaveBeenCalled();
		expect(r.ctrl.pendingCount()).toBe(0);
	}

	it("EC-1 ID-like names", async () => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		await untouched(r, async () => {
			await r.userRename(f, "_pool/20260925150000-a1b2.md");
			await r.userRename(f, "_pool/20260925150000-A1B2.md");
		});
		expect(f.path).toBe("_pool/20260925150000-A1B2.md");
	});

	it("EC-3/EC-5/EC-12 moves and creates", async () => {
		const r = rig((app) => {
			app.vault.seedFolder("Archive");
			app.vault.seedFile("Loose.md");
		});
		const a = r.app.vault.seedFile(ID);
		const loose = file(r, "Loose.md");
		await untouched(r, async () => {
			await r.userRename(a, "Archive/20260925143012-k3xq.md");
			await r.userRename(loose, "_pool/Loose.md");
			await r.app.vault.create("_pool/Imported note.md", "");
		});
	});

	it("EC-4/EC-6/EC-7/EC-8 outside the pool, non-md, sub-folders, the pool folder", async () => {
		const r = rig((app) => {
			app.vault.seedFile("Loose.md");
			app.vault.seedFolder("Recipes");
			app.vault.seedFile("Recipes/Pasta.md");
			app.vault.seedFolder("_pool-archive");
			app.vault.seedFile("_pool-archive/Note.md");
			app.vault.seedFile("_pool/scan.pdf");
			app.vault.seedFile("_pool/Note.md");
			app.vault.seedFolder("_pool/sub");
			app.vault.seedFile("_pool/sub/20260101000000-aaaa.md");
		});
		await untouched(r, async () => {
			await r.userRename(file(r, "Loose.md"), "Loose 2.md");
			await r.userRename(file(r, "Recipes/Pasta.md"), "Recipes/Pasta 2.md");
			await r.userRename(file(r, "_pool-archive/Note.md"), "_pool-archive/Note 2.md");
			await r.userRename(file(r, "_pool/scan.pdf"), "_pool/scan 2.pdf");
			await r.userRename(file(r, "_pool/Note.md"), "_pool/Note.txt");
			await r.userRename(file(r, "_pool/Note.txt"), "_pool/Note.md");
			await r.userRename(file(r, "_pool/sub/20260101000000-aaaa.md"), "_pool/sub/Idea.md");
			await r.app.vault.rename(r.app.vault.getAbstractFileByPath("_pool/sub")!, "_pool/sub2");
			await r.app.vault.rename(r.app.vault.getAbstractFileByPath("_pool")!, "_pool2");
		});
	});

	it.each(["", "/", "."])("EC-9 pool setting %j", async (setting) => {
		const r = rig((app) => {
			app.vault.seedFile("Loose.md");
			app.vault.seedFolder("Recipes");
			app.vault.seedFile("Recipes/Pasta.md");
		});
		r.pool.value = setting;
		await untouched(r, async () => {
			await r.userRename(file(r, "Loose.md"), "Loose 2.md");
			await r.userRename(file(r, "Recipes/Pasta.md"), "Recipes/Pasta 2.md");
		});
	});

	it("EC-10 a sync-delivered finished move, and delete plus create, do nothing", async () => {
		const r = rig();
		const f = r.app.vault.seedFile("Quarry drone LiDAR.md");
		await untouched(r, async () => {
			expect(r.ctrl.handleRename(f, ID)).toBe("ignored");
			await r.app.vault.create("Fresh.md", "");
			await r.app.vault.delete(file(r, "Fresh.md"));
		});
	});
});

describe("UT-9 / AC-5..8 the clash dialog", () => {
	function clashRig() {
		return rig((app) => {
			app.vault.seedFile("Reading list.md");
			app.vault.seedFolder("Recipes");
			app.vault.seedFile("Diagram.png");
			app.vault.seedFolder("Projects");
			app.vault.seedFile("Projects/Reading list.md");
		});
	}

	it("opens once with the attempted name; Create renames straight to the chosen name (AC-7)", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile(ID);
		r.openDialog.mockResolvedValue("Reading list 2");
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).toHaveBeenCalledTimes(1);
		expect(r.openDialog.mock.calls[0][0]).toMatchObject({ initialValue: "Reading list", poolFolder: "_pool", excludedFolders: ["_pool"] });
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(r.renameFile.mock.calls[0][1]).toBe("Reading list 2.md");
		expect(file(r, "Reading list 2.md")).toBe(f);
		expect(exists(r, "_pool/Reading list.md")).toBe(false);
		expect(r.toasts()).toEqual(["Moved 'Reading list 2' out of the pool"]);
	});

	it("Cancel and dismiss both put the file back once, with no toast (AC-8)", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile(ID);
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(r.renameFile.mock.calls[0][1]).toBe(ID);
		expect(file(r, ID)).toBe(f);
		expect(r.toasts()).toEqual([]);
		expect(r.ctrl.pendingCount()).toBe(0);
	});

	it.each([
		["reading LIST", true],
		["recipes", true],
		["Reading list", true],
		["Diagram", false],
		["Zebra", false],
	])("AC-6 clash check for %s (root has Reading list.md, Recipes/, Diagram.png)", async (name, opens) => {
		const r = clashRig();
		const f = r.app.vault.seedFile(ID);
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, `_pool/${name}.md`);
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).toHaveBeenCalledTimes(opens ? 1 : 0);
		expect(file(r, opens ? ID : `${name}.md`)).toBe(f); // reverted to the ID name, or graduated
	});

	it("only the root counts: Projects/Reading list.md alone does not clash", async () => {
		const r = rig((app) => {
			app.vault.seedFolder("Projects");
			app.vault.seedFile("Projects/Reading list.md");
		});
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).not.toHaveBeenCalled();
		expect(file(r, "Reading list.md")).toBe(f);
	});

	it("EC-20/EC-22 Cancel restores a non-ID original; the revert does not graduate again", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "_pool/Untitled.md")).toBe(f);
		expect(r.renameFile).toHaveBeenCalledTimes(1); // Atlas's own: the revert
		expect(r.openDialog).toHaveBeenCalledTimes(1);
		expect(r.toasts()).toEqual([]);
		expect(r.ctrl.pendingCount()).toBe(0);
		expect(r.scheduler.size).toBe(0);
	});

	it("EC-23 the revert is forgotten: later renames graduate normally", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.ctrl.getOwnReverts().size).toBe(0);
		await r.userRename(f, "_pool/Notes.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "Notes.md")).toBe(f);

		const other = r.app.vault.seedFile("_pool/Other.md");
		await r.userRename(other, "_pool/Untitled.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "Untitled.md")).toBe(other);
	});

	it("EC-21 chained renames restore the very first name", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, "_pool/Draft.md");
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "_pool/Untitled.md")).toBe(f);

		const g = r.app.vault.seedFile("_pool/A.md");
		await r.userRename(g, "_pool/B.md");
		await r.userRename(g, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "_pool/A.md")).toBe(g);
	});

	it("EC-21 a further rename while the dialog is open still reverts to the first name", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile("_pool/Untitled.md");
		let close!: (v: string | null) => void;
		r.openDialog.mockReturnValue(new Promise((resolve) => (close = resolve)));
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		await r.userRename(f, "_pool/Reading list again.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).toHaveBeenCalledTimes(1);
		close(null);
		await flush();
		expect(file(r, "_pool/Untitled.md")).toBe(f);
	});

	it("EC-26 a chosen name that clashes by the time Create is pressed is refused by Obsidian and reported", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile(ID);
		r.openDialog.mockImplementation(async () => {
			r.app.vault.seedFile("Taken later.md");
			return "Taken later";
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "_pool/Reading list.md")).toBe(f);
		expect(r.toasts()).toEqual(["Atlas: couldn't move 'Taken later' out of the pool"]);
		errors.mockRestore();
	});

	it("EC-27 dialogs are queued one at a time, the second re-checked against the root as it is by then", async () => {
		const r = clashRig();
		const a = r.app.vault.seedFile(ID);
		const b = r.app.vault.seedFile("_pool/20260925150000-a1b2.md");
		const c = r.app.vault.seedFile("_pool/20260925160000-zz99.md");
		const closers: ((v: string | null) => void)[] = [];
		let open = 0;
		let maxOpen = 0;
		r.openDialog.mockImplementation(
			() =>
				new Promise((resolve) => {
					open++;
					maxOpen = Math.max(maxOpen, open);
					closers.push((v) => {
						open--;
						resolve(v);
					});
				})
		);
		await r.userRename(a, "_pool/Reading list.md");
		await r.userRename(b, "_pool/reading LIST.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).toHaveBeenCalledTimes(1);

		// A non-clashing graduation proceeds independently while a dialog is open.
		await r.userRename(c, "_pool/Fine.md");
		await r.scheduler.advance(FALLBACK_MS);
		expect(file(r, "Fine.md")).toBe(c);

		closers[0]("Reading list 2");
		await flush();
		await flush();
		expect(file(r, "Reading list 2.md")).toBe(a);
		expect(r.openDialog).toHaveBeenCalledTimes(2); // b's name still clashes with Reading list.md
		closers[1]("Reading list 3");
		await flush();
		expect(file(r, "Reading list 3.md")).toBe(b);
		expect(maxOpen).toBe(1);
	});

	it("EC-27 the queued name skips its dialog when it is free by then", async () => {
		const r = clashRig();
		const a = r.app.vault.seedFile(ID);
		const b = r.app.vault.seedFile("_pool/20260925150000-a1b2.md");
		let close!: (v: string | null) => void;
		r.openDialog.mockReturnValueOnce(new Promise((resolve) => (close = resolve)));
		await r.userRename(a, "_pool/Reading list.md");
		await r.userRename(b, "_pool/Reading list.md".replace("list", "List"));
		await r.scheduler.advance(FALLBACK_MS);
		await r.app.vault.delete(file(r, "Reading list.md")); // the clash goes away meanwhile
		close("Zed");
		await flush();
		await flush();
		expect(r.openDialog).toHaveBeenCalledTimes(1);
		expect(file(r, "Reading List.md")).toBe(b);
	});

	it.each([".ideas", "Ideas.", "Ideas ", "A#B", "A^B", "A[B", "A]B", "A|B", "CON", "_pool"])("EC-28 %j goes through the dialog", async (name) => {
		const r = rig();
		const f = r.app.vault.seedFile(ID);
		r.openDialog.mockResolvedValue(null);
		await r.userRename(f, `_pool/${name}.md`);
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.openDialog).toHaveBeenCalledTimes(1);
		expect(r.renameFile.mock.calls.at(-1)?.[1]).toBe(ID);
		expect(file(r, ID)).toBe(f);
	});

	describe("T1/T2 a leading-dot name (Obsidian drops the file from its index ~100 ms after the rename)", () => {
		/** What Obsidian does: the rename event, then, ~100 ms on, a `delete` event with the file still on disk. */
		async function renameToDot(r: Rig, f: TFile, name = ".ideas"): Promise<void> {
			await r.userRename(f, `_pool/${name}.md`);
			await r.scheduler.advance(100);
			await r.app.vault.delete(f);
		}

		it("opens the dialog at once instead of waiting for the link rewrite, and Cancel restores the old name", async () => {
			const r = rig();
			const f = r.app.vault.seedFile("_pool/Untitled.md");
			r.openDialog.mockResolvedValue(null);
			await r.userRename(f, "_pool/.ideas.md");
			await r.scheduler.advance(0);
			expect(r.openDialog).toHaveBeenCalledTimes(1);
			expect(r.openDialog.mock.calls[0][0]).toMatchObject({ initialValue: ".ideas" });
			await r.scheduler.advance(100);
			await r.app.vault.delete(f); // hidden from the index while the dialog is up (or already answered)
			await flush();
			expect(r.renameFile).toHaveBeenCalledTimes(1);
			expect(r.renameFile.mock.calls[0][1]).toBe("_pool/Untitled.md");
			expect(f.path).toBe("_pool/Untitled.md");
			expect(r.onHiddenMove).toHaveBeenCalledWith("_pool/.ideas.md", "_pool/Untitled.md");
			expect(r.toasts()).toEqual([]);
			expect(r.ctrl.pendingCount()).toBe(0);
			expect(r.scheduler.size).toBe(0);
		});

		it("the delete event does not drop the record while the dialog is open; Create moves it to the root", async () => {
			const r = rig();
			const f = r.app.vault.seedFile(ID);
			let close!: (v: string | null) => void;
			r.openDialog.mockReturnValue(new Promise((resolve) => (close = resolve)));
			await renameToDot(r, f);
			expect(r.openDialog).toHaveBeenCalledTimes(1);
			expect(r.ctrl.pendingCount()).toBe(1);
			close("Ideas");
			await flush();
			await flush();
			expect(r.renameFile.mock.calls.at(-1)?.[1]).toBe("Ideas.md");
			expect(f.path).toBe("Ideas.md");
			expect(r.onHiddenMove).toHaveBeenCalledWith("_pool/.ideas.md", "Ideas.md");
			expect(r.toasts()).toEqual(["Moved 'Ideas' out of the pool"]);
			expect(r.afterMove).toHaveBeenCalledTimes(1);
			expect(r.ctrl.pendingCount()).toBe(0);
		});

		it("Cancel after the delete event puts the file back to its first name", async () => {
			const r = rig();
			const f = r.app.vault.seedFile(ID);
			let close!: (v: string | null) => void;
			r.openDialog.mockReturnValue(new Promise((resolve) => (close = resolve)));
			await renameToDot(r, f);
			close(null);
			await flush();
			await flush();
			expect(f.path).toBe(ID);
			expect(r.onHiddenMove).toHaveBeenCalledWith("_pool/.ideas.md", ID);
			expect(r.toasts()).toEqual([]);
			expect(r.ctrl.pendingCount()).toBe(0);
			expect(r.ctrl.getOwnReverts().size).toBe(0);
		});

		it("a plain (non-hidden) failing name still waits for the link rewrite and never reports a hidden move", async () => {
			const r = rig();
			const f = r.app.vault.seedFile(ID);
			r.openDialog.mockResolvedValue(null);
			await r.userRename(f, "_pool/Ideas..md");
			await r.scheduler.advance(0);
			expect(r.openDialog).not.toHaveBeenCalled();
			await r.scheduler.advance(FALLBACK_MS);
			expect(r.openDialog).toHaveBeenCalledTimes(1);
			expect(r.onHiddenMove).not.toHaveBeenCalled();
		});

		it("a real delete of a non-hidden pending file still drops the record", async () => {
			const r = rig();
			const f = r.app.vault.seedFile(ID);
			await r.userRename(f, "_pool/Ideas.md");
			await r.app.vault.delete(f);
			expect(r.ctrl.pendingCount()).toBe(0);
			expect(r.scheduler.size).toBe(0);
		});
	});

	it("the dialog result after unload does not move or revert anything", async () => {
		const r = clashRig();
		const f = r.app.vault.seedFile(ID);
		let close!: (v: string | null) => void;
		r.openDialog.mockReturnValue(new Promise((resolve) => (close = resolve)));
		await r.userRename(f, "_pool/Reading list.md");
		await r.scheduler.advance(FALLBACK_MS);
		r.ctrl.dispose();
		close(null);
		await flush();
		expect(r.renameFile).not.toHaveBeenCalled();
	});
});

describe("R3-6 graduation waits for Tephra's acknowledgement while the toggle is on", () => {
	const NEW = "_pool/Quarry drone LiDAR.md";

	it("online: the move happens on the acknowledgement of the triggering rename, not on resolved/modify, and before FALLBACK_MS", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, NEW);
		expect(acks.waits).toHaveLength(1);
		expect(acks.waits[0]).toMatchObject({ oldPath: ID, newPath: NEW });
		// Obsidian's own settle does nothing now: a `resolved` and a `modify` neither start nor move anything
		r.app.metadataCache.trigger("resolved");
		await r.scheduler.advance(SETTLE_MS * 3);
		expect(r.renameFile).not.toHaveBeenCalled();
		acks.ack(ID, NEW);
		await flush();
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(exists(r, "Quarry drone LiDAR.md")).toBe(true);
		expect(r.scheduler.size).toBe(0); // the fallback timer went with it
	});

	it("an acknowledgement of some other rename does not move it", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, NEW);
		acks.ack("_pool/other.md", "_pool/other2.md");
		await flush();
		expect(r.renameFile).not.toHaveBeenCalled();
	});

	it("offline or never acknowledged: graduates on FALLBACK_MS, and not a moment earlier", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, NEW);
		await r.scheduler.advance(FALLBACK_MS - 1);
		expect(r.renameFile).not.toHaveBeenCalled();
		await r.scheduler.advance(1);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(acks.waits[0].stopped).toBe(true); // a late acknowledgement can't start a second run
		acks.ack(ID, NEW);
		await flush();
		expect(r.renameFile).toHaveBeenCalledTimes(1);
	});

	it("the graduation's own move is a second rename, after the first (both reach the vault's rename event in order)", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const seen: Array<[string, string]> = [];
		r.app.vault.on("rename", (file: never, oldPath: string) => void seen.push([oldPath, (file as TFile).path]));
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, NEW);
		await r.scheduler.advance(FALLBACK_MS);
		expect(seen).toEqual([
			[ID, NEW],
			[NEW, "Quarry drone LiDAR.md"],
		]);
	});

	it("a chain of renames waits on the last one only; the first one's acknowledgement does not move it", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, "_pool/B.md");
		await r.userRename(f, "_pool/C.md");
		expect(acks.waits.map((w) => w.stopped)).toEqual([true, false]);
		acks.ack(ID, "_pool/B.md");
		await flush();
		expect(r.renameFile).not.toHaveBeenCalled();
		acks.ack("_pool/B.md", "_pool/C.md");
		await flush();
		expect(r.renameFile).toHaveBeenCalledTimes(1);
		expect(file(r, "C.md")).toBe(f);
	});

	it("the toggle going off while it waits: the fallback still moves it", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, NEW);
		acks.active = false;
		await r.scheduler.advance(FALLBACK_MS);
		expect(r.renameFile).toHaveBeenCalledTimes(1);
	});

	it("dispose cancels the wait", async () => {
		const acks = fakeAcks(true);
		const r = rig(undefined, acks);
		const f = r.app.vault.seedFile(ID);
		await r.userRename(f, NEW);
		r.ctrl.dispose();
		expect(acks.waits[0].stopped).toBe(true);
		await r.scheduler.advance(FALLBACK_MS * 2);
		expect(r.renameFile).not.toHaveBeenCalled();
	});

	it("toggle off (`tephraAcks` inactive or absent): exactly today's behaviour, settle on resolved, no wait registered", async () => {
		for (const acks of [undefined, fakeAcks(false)]) {
			Notice.reset();
			const r = rig(undefined, acks);
			const f = r.app.vault.seedFile(ID);
			await r.userRename(f, NEW);
			expect(acks?.waits ?? []).toHaveLength(0);
			r.app.metadataCache.trigger("resolved");
			await r.scheduler.advance(SETTLE_MS - 1);
			expect(r.renameFile).not.toHaveBeenCalled();
			await r.scheduler.advance(1);
			expect(r.renameFile).toHaveBeenCalledTimes(1);
		}
	});
});
