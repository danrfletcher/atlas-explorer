import * as fs from "fs";
import type { SourcesFs } from "./sources-links";

/**
 * The real filesystem for the `Sources/` folder code (desktop only; mobile never reaches it). Every call is
 * one `fs.promises` call with no recursion: `rmdir` is the non-recursive one, `unlink` removes a link and
 * never what it points at, and `lstat` doesn't follow links. There is no `rm`, `rename` or vault-API call
 * anywhere in this adapter, by design: the files under a source are the source's own.
 */
export const nodeSourcesFs: SourcesFs = {
	lstat: (path) => fs.promises.lstat(path),
	readdir: (path) => fs.promises.readdir(path),
	readlink: (path) => fs.promises.readlink(path),
	symlink: (target, path) => fs.promises.symlink(target, path, "dir"),
	unlink: (path) => fs.promises.unlink(path),
	mkdir: (path) => fs.promises.mkdir(path),
	rmdir: (path) => fs.promises.rmdir(path),
	readFile: (path, encoding) => fs.promises.readFile(path, encoding),
	appendFile: (path, data) => fs.promises.appendFile(path, data),
};

/** Whether `path` exists right now (follows links, so a dangling link answers false). */
export function existsOnDisk(path: string): boolean {
	try {
		fs.statSync(path);
		return true;
	} catch {
		return false;
	}
}
