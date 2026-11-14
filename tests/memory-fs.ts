import type { SourcesFs } from "../src/sources-links";

type Node = { kind: "dir" } | { kind: "file"; data: string } | { kind: "link"; target: string };

function fsError(code: string, path: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * An in-memory `SourcesFs`: directories, files and symlinks keyed by absolute path. Like the real calls,
 * `lstat` doesn't follow links, `symlink` onto an existing path is EEXIST, `rmdir` of a non-empty folder is
 * ENOTEMPTY, and `unlink` of a folder is refused. `calls` records every call as `"op path"` so a test can
 * assert what the code did (and did not) touch. Links are never followed: nothing under a link target is
 * reachable through the link, which is all the code under test needs.
 */
export class MemoryFs implements SourcesFs {
	nodes = new Map<string, Node>();
	calls: string[] = [];
	/** Make the next call of `op` on a path ending in `suffix` fail with `code`. */
	failures: { op: string; suffix: string; code: string }[] = [];

	constructor() {
		this.nodes.set("/", { kind: "dir" });
	}

	dir(path: string): this {
		this.ensureParents(path);
		this.nodes.set(path, { kind: "dir" });
		return this;
	}

	file(path: string, data = ""): this {
		this.ensureParents(path);
		this.nodes.set(path, { kind: "file", data });
		return this;
	}

	link(path: string, target: string): this {
		this.ensureParents(path);
		this.nodes.set(path, { kind: "link", target });
		return this;
	}

	has(path: string): boolean {
		return this.nodes.has(path);
	}

	text(path: string): string | null {
		const node = this.nodes.get(path);
		return node?.kind === "file" ? node.data : null;
	}

	linkTarget(path: string): string | null {
		const node = this.nodes.get(path);
		return node?.kind === "link" ? node.target : null;
	}

	failNext(op: string, suffix: string, code: string): void {
		this.failures.push({ op, suffix, code });
	}

	private ensureParents(path: string): void {
		for (let dir = parentOf(path); dir !== "/" && !this.nodes.has(dir); dir = parentOf(dir)) this.nodes.set(dir, { kind: "dir" });
	}

	private begin(op: string, path: string): void {
		this.calls.push(`${op} ${path}`);
		const index = this.failures.findIndex((f) => f.op === op && path.endsWith(f.suffix));
		if (index >= 0) {
			const [failure] = this.failures.splice(index, 1);
			throw fsError(failure.code, path);
		}
		// Yield, as a real call does, so interleavings between concurrent callers are exercised.
	}

	private childrenOf(path: string): string[] {
		const prefix = path === "/" ? "/" : `${path}/`;
		const names: string[] = [];
		for (const key of this.nodes.keys()) {
			if (key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) names.push(key.slice(prefix.length));
		}
		return names;
	}

	async lstat(path: string) {
		this.begin("lstat", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (!node) throw fsError("ENOENT", path);
		return { isSymbolicLink: () => node.kind === "link", isDirectory: () => node.kind === "dir" };
	}

	async readdir(path: string) {
		this.begin("readdir", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (!node) throw fsError("ENOENT", path);
		if (node.kind !== "dir") throw fsError("ENOTDIR", path);
		return this.childrenOf(path).sort();
	}

	async readlink(path: string) {
		this.begin("readlink", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (!node) throw fsError("ENOENT", path);
		if (node.kind !== "link") throw fsError("EINVAL", path);
		return node.target;
	}

	async symlink(target: string, path: string) {
		this.begin("symlink", path);
		await Promise.resolve();
		if (this.nodes.has(path)) throw fsError("EEXIST", path);
		if (!this.nodes.has(parentOf(path))) throw fsError("ENOENT", path);
		this.nodes.set(path, { kind: "link", target });
	}

	async unlink(path: string) {
		this.begin("unlink", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (!node) throw fsError("ENOENT", path);
		if (node.kind === "dir") throw fsError("EISDIR", path);
		this.nodes.delete(path);
	}

	async mkdir(path: string) {
		this.begin("mkdir", path);
		await Promise.resolve();
		if (this.nodes.has(path)) throw fsError("EEXIST", path);
		if (!this.nodes.has(parentOf(path))) throw fsError("ENOENT", path);
		this.nodes.set(path, { kind: "dir" });
	}

	async rmdir(path: string) {
		this.begin("rmdir", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (!node) throw fsError("ENOENT", path);
		if (node.kind !== "dir") throw fsError("ENOTDIR", path);
		if (this.childrenOf(path).length > 0) throw fsError("ENOTEMPTY", path);
		this.nodes.delete(path);
	}

	async readFile(path: string) {
		this.begin("readFile", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (!node) throw fsError("ENOENT", path);
		if (node.kind !== "file") throw fsError("EISDIR", path);
		return node.data;
	}

	async appendFile(path: string, data: string) {
		this.begin("appendFile", path);
		await Promise.resolve();
		const node = this.nodes.get(path);
		if (node && node.kind !== "file") throw fsError("EISDIR", path);
		if (!this.nodes.has(parentOf(path))) throw fsError("ENOENT", path);
		this.nodes.set(path, { kind: "file", data: (node?.kind === "file" ? node.data : "") + data });
	}
}
