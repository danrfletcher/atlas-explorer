import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { App, TFile } from "obsidian";

/** Every file path under `tests/fixtures/sources-vault/`, vault-relative with `/` separators, in a
 * stable (sorted) order. Folders are implied by the paths. */
export function sourcesVaultPaths(): string[] {
	const root = join(__dirname, "fixtures", "sources-vault");
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(relative(root, full).split("\\").join("/"));
		}
	};
	walk(root);
	return out;
}

/** Seeds `paths` (and every folder on the way) into the mock vault; returns the created files. */
export function seedPaths(app: App, paths: readonly string[]): TFile[] {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
	}
	for (const folder of [...folders].sort((a, b) => a.split("/").length - b.split("/").length)) app.vault.seedFolder(folder);
	return paths.map((path) => app.vault.seedFile(path));
}

/**
 * The UNPATCHED reference: a transliteration of Obsidian 1.14.4's `MetadataCache.getLinkpathDest` +
 * `getFirstLinkpathDest` (from its `app.js`), over the mock vault's files. F9 parity tests compare
 * the hooked resolver against this.
 */
export function obsidianFirstLinkpathDest(app: App): (linkpath: string, sourcePath: string) => TFile | null {
	const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
	const dirName = (p: string) => (p.lastIndexOf("/") === -1 ? "" : p.slice(0, p.lastIndexOf("/")));
	return (e, t) => {
		const lookup = new Map<string, TFile[]>();
		for (const f of app.vault.getFiles()) {
			const k = f.name.toLowerCase();
			lookup.set(k, [...(lookup.get(k) ?? []), f]);
		}
		if (e === "" && t) {
			const self = app.vault.getAbstractFileByPath(t);
			if (self instanceof TFile) return self;
		}
		let o = e.toLowerCase();
		let a = baseName(o);
		let s: TFile[] | undefined;
		if (a.includes(".")) s = lookup.get(a);
		if (!s) {
			o = `${e}.md`.toLowerCase();
			a = baseName(o);
			s = lookup.get(a);
		}
		if (!s) return null;
		if (a === o && s.length === 1) return s[0];
		let l = dirName(t).toLowerCase();
		if (o.startsWith("./") || o.startsWith("../")) {
			if (o.startsWith("./../")) o = o.slice(2);
			if (o.startsWith("./")) {
				if (l !== "") l += "/";
				o = l + o.slice(2);
			} else {
				while (o.startsWith("../")) {
					o = o.slice(3);
					l = dirName(l);
				}
				if (l !== "") l += "/";
				o = l + o;
			}
			for (const m of s) if (m.path.toLowerCase() === o) return m;
		}
		if (o.startsWith("/")) o = o.slice(1);
		for (const m of s) if (m.path.toLowerCase() === o) return m;
		if (e.startsWith("/")) return null;
		const d: TFile[] = [];
		const f: TFile[] = [];
		for (const m of s) {
			const y = m.path.toLowerCase();
			if (y.endsWith(o)) (y.startsWith(l) ? d : f).push(m);
		}
		d.sort((x, y) => x.path.length - y.path.length);
		f.sort((x, y) => x.path.length - y.path.length);
		return d.concat(f)[0] ?? null;
	};
}
