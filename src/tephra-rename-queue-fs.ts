import * as fs from "fs";
import { dirname } from "path";
import type { QueueStorage } from "./tephra-rename-queue";

/**
 * The real file system for the rename queue (desktop only; mobile never builds a queue). Synchronous on
 * purpose: a rename must be on disk before the vault-event handler returns. A write goes to a temp file in the
 * same folder and is renamed over the queue file, so a crash leaves either the old or the new content, never
 * half of one. Only the queue file and its own temp and `.corrupt-<ts>` neighbours are ever touched.
 */
export const nodeQueueStorage: QueueStorage = {
	read(path) {
		try {
			return fs.readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	},
	write(path, text) {
		// A missing folder must never cost a rename: create it rather than fail with ENOENT.
		fs.mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.tmp`;
		fs.writeFileSync(temp, text, "utf8");
		fs.renameSync(temp, path);
	},
	moveAside(from, to) {
		fs.renameSync(from, to);
	},
};
