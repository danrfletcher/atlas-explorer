/**
 * G11 (PR-10): the on-disk queue of Obsidian rename events that Tephra has not acknowledged yet.
 *
 * Every rename is written here BEFORE the vault-event handler returns, so it survives Tephra being offline, a
 * crash and an Obsidian restart; an entry leaves only after Tephra acknowledges it (`remove`). The file holds
 * paths only, never note content (F3). Writes are synchronous and whole-file (a snapshot of the queue), so they
 * can never interleave, and the storage replaces the file atomically, so a reader never sees half a file.
 */

/** Where the queue lives, under the plugin folder (`.obsidian/plugins/<id>/`). */
export const TEPHRA_RENAME_QUEUE_FILE = "tephra-rename-queue.json";

/** The file system the queue uses; `tephra-rename-queue-fs.ts` backs it with Node, tests with a Map. */
export interface QueueStorage {
	/** The file's text, or null when it doesn't exist. Throws when it exists but can't be read. */
	read(path: string): string | null;
	/** Replaces the file's whole content, atomically. */
	write(path: string, text: string): void;
	/** Moves a file to a new path (used to keep a corrupt queue aside). */
	moveAside(from: string, to: string): void;
}

/** One rename Obsidian reported, with the exact vault paths. */
export interface QueuedRename {
	/** Strictly increasing across the queue's life; the identity an acknowledgement refers to. */
	seq: number;
	oldPath: string;
	newPath: string;
	/** Epoch ms when it was recorded. Informational only. */
	queuedAt: number;
}

interface QueueFileShape {
	version: 1;
	nextSeq: number;
	entries: QueuedRename[];
}

export interface RenameQueueDeps {
	storage: QueueStorage;
	/** Absolute path of the queue file. */
	path: string;
	now(): number;
	/** Called once when the file at load was unreadable or invalid and has been kept aside (`asidePath` null if even that failed). */
	onCorrupt(info: { asidePath: string | null; reason: string }): void;
	/** Called when a write failed; the entry stays in memory and the next successful write includes it. */
	onWriteError(error: unknown): void;
}

function isQueuedRename(value: unknown): value is QueuedRename {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.seq === "number" &&
		Number.isSafeInteger(entry.seq) &&
		entry.seq > 0 &&
		typeof entry.oldPath === "string" &&
		entry.oldPath !== "" &&
		typeof entry.newPath === "string" &&
		entry.newPath !== "" &&
		typeof entry.queuedAt === "number"
	);
}

/** Parses the file text; returns null with a reason when it isn't a valid queue. Never throws. */
function parseQueueFile(text: string): { ok: true; nextSeq: number; entries: QueuedRename[] } | { ok: false; reason: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: "not valid JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "not a queue object" };
	const file = raw as Record<string, unknown>;
	if (file.version !== 1) return { ok: false, reason: "unknown version" };
	if (!Array.isArray(file.entries) || !file.entries.every(isQueuedRename)) return { ok: false, reason: "invalid entries" };
	const entries = file.entries as QueuedRename[];
	for (let i = 1; i < entries.length; i++) if (entries[i].seq <= entries[i - 1].seq) return { ok: false, reason: "entries out of order" };
	const highest = entries.length > 0 ? entries[entries.length - 1].seq : 0;
	const nextSeq = typeof file.nextSeq === "number" && Number.isSafeInteger(file.nextSeq) && file.nextSeq > highest ? file.nextSeq : highest + 1;
	return { ok: true, nextSeq, entries };
}

export class TephraRenameQueue {
	private items: QueuedRename[] = [];
	private nextSeq = 1;
	private loaded = false;

	constructor(private readonly deps: RenameQueueDeps) {}

	isLoaded(): boolean {
		return this.loaded;
	}

	/**
	 * Reads the queue file. A missing file is an empty queue. A file that can't be read or isn't a valid queue is
	 * moved aside to `<file>.corrupt-<timestamp>`, the queue starts empty, and `onCorrupt` is told once. Never
	 * throws, so a bad file can't stop the plugin from loading. Calling it again does nothing.
	 */
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		const { storage, path } = this.deps;
		let text: string | null;
		try {
			text = storage.read(path);
		} catch (error) {
			this.keepAside(`unreadable (${describe(error)})`);
			return;
		}
		if (text === null) return;
		const parsed = parseQueueFile(text);
		if (!parsed.ok) {
			this.keepAside(parsed.reason);
			return;
		}
		this.items = parsed.entries;
		this.nextSeq = parsed.nextSeq;
	}

	entries(): readonly QueuedRename[] {
		return this.items;
	}

	size(): number {
		return this.items.length;
	}

	first(): QueuedRename | undefined {
		return this.items[0];
	}

	/** Appends one rename and writes the file before returning. Never throws: a failed write is reported and the entry stays in memory. */
	enqueue(oldPath: string, newPath: string): QueuedRename {
		const entry: QueuedRename = { seq: this.nextSeq++, oldPath, newPath, queuedAt: this.deps.now() };
		this.items.push(entry);
		this.persist();
		return entry;
	}

	/** Drops the entry with this `seq` (after Tephra acknowledged it) and writes the file. Returns whether it was there. */
	remove(seq: number): boolean {
		const index = this.items.findIndex((item) => item.seq === seq);
		if (index === -1) return false;
		this.items.splice(index, 1);
		this.persist();
		return true;
	}

	/** Drops every entry `shouldDrop` picks with one write (used to fold a folder's children into the folder's own event). Returns how many went. */
	removeWhere(shouldDrop: (entry: QueuedRename) => boolean): number {
		const kept = this.items.filter((entry) => !shouldDrop(entry));
		const dropped = this.items.length - kept.length;
		if (dropped === 0) return 0;
		this.items = kept;
		this.persist();
		return dropped;
	}

	private persist(): void {
		const shape: QueueFileShape = { version: 1, nextSeq: this.nextSeq, entries: this.items };
		try {
			this.deps.storage.write(this.deps.path, JSON.stringify(shape));
		} catch (error) {
			this.deps.onWriteError(error);
		}
	}

	private keepAside(reason: string): void {
		const { storage, path } = this.deps;
		const asidePath = `${path}.corrupt-${this.deps.now()}`;
		let moved: string | null = asidePath;
		try {
			storage.moveAside(path, asidePath);
		} catch {
			moved = null;
		}
		this.items = [];
		this.nextSeq = 1;
		try {
			this.deps.onCorrupt({ asidePath: moved, reason });
		} catch (error) {
			console.error("[Atlas] the rename-queue corruption notice threw", error);
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
