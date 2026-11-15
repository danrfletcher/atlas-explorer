import { describe, expect, it, vi } from "vitest";
import { TEPHRA_RENAME_QUEUE_FILE, TephraRenameQueue, type QueueStorage } from "../../src/tephra-rename-queue";

/** G11: the on-disk queue of renames Tephra hasn't acknowledged. An in-memory adapter stands in for the file system
 * (every `write` is recorded, so "written before the call returns" and "never interleaved" can be read off the log) and a
 * fake clock stands in for `Date.now`. */

const PATH = `/vault/.obsidian/plugins/atlas/${TEPHRA_RENAME_QUEUE_FILE}`;

class MemoryStorage implements QueueStorage {
	files = new Map<string, string>();
	/** Every write, in order, as the text written. */
	writes: string[] = [];
	moves: Array<[string, string]> = [];
	failReads = false;
	failWrites = false;
	failMoves = false;
	read(path: string): string | null {
		if (this.failReads) throw new Error("EACCES");
		return this.files.get(path) ?? null;
	}
	write(path: string, text: string): void {
		if (this.failWrites) throw new Error("ENOSPC");
		this.writes.push(text);
		this.files.set(path, text);
	}
	moveAside(from: string, to: string): void {
		if (this.failMoves) throw new Error("EPERM");
		this.moves.push([from, to]);
		const text = this.files.get(from);
		if (text !== undefined) {
			this.files.set(to, text);
			this.files.delete(from);
		}
	}
}

function make(storage = new MemoryStorage(), startAt = 1_000) {
	let time = startAt;
	const corrupt: Array<{ asidePath: string | null; reason: string }> = [];
	const writeErrors: unknown[] = [];
	const queue = new TephraRenameQueue({
		storage,
		path: PATH,
		now: () => time++,
		onCorrupt: (info) => void corrupt.push(info),
		onWriteError: (error) => void writeErrors.push(error),
	});
	return { queue, storage, corrupt, writeErrors };
}

/** What a restart sees: a new queue over the same files. */
const reopen = (storage: MemoryStorage) => {
	const next = make(storage, 50_000);
	next.queue.load();
	return next;
};

const onDisk = (storage: MemoryStorage) => JSON.parse(storage.files.get(PATH) ?? "null") as { version: number; entries: Array<{ oldPath: string; newPath: string }> } | null;
const pairs = (queue: TephraRenameQueue) => queue.entries().map((entry) => [entry.oldPath, entry.newPath]);

describe("order and removal", () => {
	it("first in, first out", () => {
		const { queue } = make();
		queue.load();
		queue.enqueue("a.md", "b.md");
		queue.enqueue("c.md", "d.md");
		queue.enqueue("e.md", "f.md");
		expect(pairs(queue)).toEqual([["a.md", "b.md"], ["c.md", "d.md"], ["e.md", "f.md"]]);
		expect(queue.first()).toMatchObject({ oldPath: "a.md", newPath: "b.md" });
	});

	it("an entry leaves only when it is removed (acknowledged): reading the head does not remove it", () => {
		const { queue, storage } = make();
		queue.load();
		const first = queue.enqueue("a.md", "b.md");
		queue.enqueue("c.md", "d.md");
		void queue.first();
		void queue.first();
		expect(queue.size()).toBe(2);
		expect(onDisk(storage)!.entries).toHaveLength(2);
		expect(queue.remove(first.seq)).toBe(true);
		expect(pairs(queue)).toEqual([["c.md", "d.md"]]);
		expect(onDisk(storage)!.entries.map((e) => e.oldPath)).toEqual(["c.md"]);
		expect(queue.remove(first.seq)).toBe(false); // a second acknowledgement of the same entry changes nothing
		expect(queue.size()).toBe(1);
	});

	it("A→B then B→C are two ordered entries, never merged", () => {
		const { queue } = make();
		queue.load();
		queue.enqueue("A.md", "B.md");
		queue.enqueue("B.md", "C.md");
		expect(pairs(queue)).toEqual([["A.md", "B.md"], ["B.md", "C.md"]]);
	});

	it("sequence numbers only go up, and are never reused after a removal or a restart", () => {
		const { queue, storage } = make();
		queue.load();
		const a = queue.enqueue("a", "b");
		const b = queue.enqueue("c", "d");
		queue.remove(b.seq);
		const c = queue.enqueue("e", "f");
		expect(c.seq).toBeGreaterThan(b.seq);
		queue.remove(a.seq);
		queue.remove(c.seq);
		const after = reopen(storage);
		expect(after.queue.enqueue("g", "h").seq).toBeGreaterThan(c.seq);
	});

	it("removeWhere drops the matching entries with one write and keeps the order of the rest", () => {
		const { queue, storage } = make();
		queue.load();
		queue.enqueue("Dir/1.md", "New/1.md");
		queue.enqueue("x.md", "y.md");
		queue.enqueue("Dir/2.md", "New/2.md");
		const writesBefore = storage.writes.length;
		expect(queue.removeWhere((e) => e.oldPath.startsWith("Dir/"))).toBe(2);
		expect(storage.writes.length).toBe(writesBefore + 1);
		expect(pairs(queue)).toEqual([["x.md", "y.md"]]);
		expect(queue.removeWhere(() => false)).toBe(0);
		expect(storage.writes.length).toBe(writesBefore + 1);
	});
});

describe("write-ahead and survival", () => {
	it("every enqueue is on disk before it returns", () => {
		const { queue, storage } = make();
		queue.load();
		for (const [i, name] of ["a", "b", "c"].entries()) {
			queue.enqueue(`${name}.md`, `${name}2.md`);
			expect(onDisk(storage)!.entries).toHaveLength(i + 1);
		}
	});

	it("a restart (a new queue over the same file) resumes from the first unacknowledged entry, in order", () => {
		const first = make();
		first.queue.load();
		const a = first.queue.enqueue("a.md", "a2.md");
		first.queue.enqueue("b.md", "b2.md");
		first.queue.enqueue("c.md", "c2.md");
		first.queue.remove(a.seq); // a was acknowledged; the drop came while b was in flight
		const second = reopen(first.storage);
		expect(pairs(second.queue)).toEqual([["b.md", "b2.md"], ["c.md", "c2.md"]]);
		expect(second.queue.first()).toMatchObject({ oldPath: "b.md" });
		expect(second.corrupt).toEqual([]);
	});

	it("repeated reopen cycles lose and duplicate nothing", () => {
		const storage = new MemoryStorage();
		let current = make(storage);
		current.queue.load();
		current.queue.enqueue("1", "2");
		for (let i = 0; i < 5; i++) {
			current = reopen(storage);
			expect(pairs(current.queue)).toEqual([["1", "2"]]);
		}
	});

	it("load() twice does not re-read or reset the queue", () => {
		const { queue, storage } = make();
		queue.load();
		queue.enqueue("a", "b");
		const read = vi.spyOn(storage, "read");
		queue.load();
		expect(read).not.toHaveBeenCalled();
		expect(queue.size()).toBe(1);
	});

	it("a failed write is reported, never thrown, and the entry is kept and written with the next successful write", () => {
		const { queue, storage, writeErrors } = make();
		queue.load();
		storage.failWrites = true;
		expect(() => queue.enqueue("a.md", "b.md")).not.toThrow();
		expect(writeErrors).toHaveLength(1);
		expect(queue.size()).toBe(1);
		storage.failWrites = false;
		queue.enqueue("c.md", "d.md");
		expect(onDisk(storage)!.entries.map((e) => e.oldPath)).toEqual(["a.md", "c.md"]);
	});

	it("the file holds paths and times only: no note content", () => {
		const { queue, storage } = make();
		queue.load();
		queue.enqueue("a.md", "b.md");
		expect(Object.keys(onDisk(storage)!.entries[0] as object).sort()).toEqual(["newPath", "oldPath", "queuedAt", "seq"]);
	});
});

describe("serialised writes", () => {
	it("a burst of 200 enqueues leaves every write a complete, valid snapshot, each one entry longer than the last", () => {
		const { queue, storage } = make();
		queue.load();
		for (let i = 0; i < 200; i++) queue.enqueue(`Dir/child-${i}.md`, `Moved/child-${i}.md`);
		expect(storage.writes).toHaveLength(200);
		storage.writes.forEach((text, i) => {
			const parsed = JSON.parse(text) as { entries: unknown[] };
			expect(parsed.entries).toHaveLength(i + 1);
		});
		const after = reopen(storage);
		expect(after.queue.entries().map((e) => e.oldPath)).toEqual(Array.from({ length: 200 }, (_, i) => `Dir/child-${i}.md`));
	});

	it("interleaved enqueues and removals keep the file equal to the in-memory queue after every step", () => {
		const { queue, storage } = make();
		queue.load();
		const live: number[] = [];
		for (let i = 0; i < 60; i++) {
			live.push(queue.enqueue(`o${i}`, `n${i}`).seq);
			if (i % 3 === 2) queue.remove(live.shift()!);
			expect(onDisk(storage)!.entries.map((e) => (e as { seq?: number }).seq)).toEqual(live);
		}
	});
});

describe("unicode and awkward paths survive byte for byte", () => {
	it.each([
		["Café ☕.md", "Café ☕ 2.md"],
		["日本語/ノート.md", "日本語/メモ.md"],
		["emoji 🧪/📓 notes.md", "emoji 🧪/📓 notes (2).md"],
		["A # B.md", "A ^ B [x].md"],
		["with  double  spaces.md", " leading and trailing .md"],
		["decomposed e\u0301.md", "precomposed \u00e9.md"],
		["quote \" and \\ backslash.md", "tab\there.md"],
		["lone \ud800 surrogate.md", "ok.md"],
	])("%j → %j", (oldPath, newPath) => {
		const { queue, storage } = make();
		queue.load();
		queue.enqueue(oldPath, newPath);
		const reloaded = reopen(storage);
		expect(reloaded.queue.first()?.oldPath).toBe(oldPath);
		expect(reloaded.queue.first()?.newPath).toBe(newPath);
		expect(reloaded.corrupt).toEqual([]);
	});
});

describe("a corrupt or unreadable file", () => {
	const bad: Array<[string, string]> = [
		["not JSON", "{oops"],
		["empty", ""],
		["a bare array", "[]"],
		["null", "null"],
		["unknown version", JSON.stringify({ version: 2, entries: [] })],
		["entries not a list", JSON.stringify({ version: 1, entries: {} })],
		["an entry without a new path", JSON.stringify({ version: 1, entries: [{ seq: 1, oldPath: "a", queuedAt: 1 }] })],
		["an empty path", JSON.stringify({ version: 1, entries: [{ seq: 1, oldPath: "", newPath: "b", queuedAt: 1 }] })],
		["a non-numeric seq", JSON.stringify({ version: 1, entries: [{ seq: "1", oldPath: "a", newPath: "b", queuedAt: 1 }] })],
		["entries out of order", JSON.stringify({ version: 1, entries: [{ seq: 2, oldPath: "a", newPath: "b", queuedAt: 1 }, { seq: 1, oldPath: "c", newPath: "d", queuedAt: 1 }] })],
	];

	it.each(bad)("%s: kept aside as .corrupt-<ts>, an empty queue starts, one report, no throw", (_name, text) => {
		const storage = new MemoryStorage();
		storage.files.set(PATH, text);
		const { queue, corrupt } = make(storage, 777);
		expect(() => queue.load()).not.toThrow();
		expect(queue.size()).toBe(0);
		expect(corrupt).toHaveLength(1);
		expect(corrupt[0].asidePath).toBe(`${PATH}.corrupt-777`);
		expect(storage.files.get(`${PATH}.corrupt-777`)).toBe(text); // the bad file is kept, not deleted
		expect(storage.files.has(PATH)).toBe(false);
		// a new entry then starts a valid file
		queue.enqueue("a.md", "b.md");
		expect(onDisk(storage)!.entries).toHaveLength(1);
	});

	it("an unreadable file (permissions) is treated the same, and a second load() does not report again", () => {
		const storage = new MemoryStorage();
		storage.files.set(PATH, "{}");
		storage.failReads = true;
		const { queue, corrupt } = make(storage);
		queue.load();
		queue.load();
		expect(corrupt).toHaveLength(1);
		expect(corrupt[0].reason).toMatch(/unreadable/);
		expect(queue.size()).toBe(0);
	});

	it("when the file can't even be moved aside, it still starts empty and says so (asidePath null)", () => {
		const storage = new MemoryStorage();
		storage.files.set(PATH, "{oops");
		storage.failMoves = true;
		const { queue, corrupt } = make(storage);
		expect(() => queue.load()).not.toThrow();
		expect(corrupt).toEqual([{ asidePath: null, reason: "not valid JSON" }]);
		expect(queue.size()).toBe(0);
	});

	it("a throwing report handler can't crash the load", () => {
		const storage = new MemoryStorage();
		storage.files.set(PATH, "{oops");
		const queue = new TephraRenameQueue({
			storage,
			path: PATH,
			now: () => 1,
			onCorrupt: () => {
				throw new Error("notice failed");
			},
			onWriteError: () => {},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => queue.load()).not.toThrow();
	});

	it("a missing file is an empty queue with no report", () => {
		const { queue, corrupt } = make();
		queue.load();
		expect(queue.size()).toBe(0);
		expect(corrupt).toEqual([]);
	});

	it("a stored `nextSeq` that is behind the entries is repaired, so a new entry never reuses a seq", () => {
		const storage = new MemoryStorage();
		storage.files.set(PATH, JSON.stringify({ version: 1, nextSeq: 1, entries: [{ seq: 5, oldPath: "a", newPath: "b", queuedAt: 1 }] }));
		const { queue, corrupt } = make(storage);
		queue.load();
		expect(corrupt).toEqual([]);
		expect(queue.enqueue("c", "d").seq).toBe(6);
	});
});
