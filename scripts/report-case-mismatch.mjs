#!/usr/bin/env node
// E4 (report-only): counts wikilinks and Markdown links whose target text differs in case from the
// file they resolve to. Case matters once links resolve inside a source (`@whoop:workout plan`).
//
// READ-ONLY: this script only calls readdirSync / readFileSync / lstatSync. It never writes, renames
// or deletes anything, and it sends nothing over the network.
//
//   node scripts/report-case-mismatch.mjs <vault-path> [--json]
//
// A link "mismatches" when its last path segment (without `.md`) matches no file name exactly but
// matches one case-insensitively. Links inside fenced code blocks and inline code are ignored, as
// are links to other things (URLs, `#heading`-only links, files that do not exist).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = args.find((a) => !a.startsWith("--"));
if (!root) {
	console.error("usage: node scripts/report-case-mismatch.mjs <vault-path> [--json]");
	process.exit(2);
}

const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules"]);

/**
 * Every real file under `root` (relative, `/`-separated). Symbolic links (to folders or files) are
 * skipped entirely, so `Sources/<name>` links to other sources are not scanned and the report
 * covers the vault's own notes only. `lstatSync` does not follow links; `statSync` would.
 */
function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(dir, name);
		let st;
		try {
			st = lstatSync(full, { throwIfNoEntry: false });
		} catch {
			continue;
		}
		if (!st || st.isSymbolicLink()) continue;
		if (st.isDirectory()) walk(full, out);
		else out.push(relative(root, full).split("\\").join("/"));
	}
	return out;
}

const files = walk(root, []);
const exactNames = new Set(); // "Leg Day.md", "pic.png"
const lowerToNames = new Map(); // "leg day.md" -> Set of real names
for (const f of files) {
	const name = basename(f);
	exactNames.add(name);
	const key = name.toLowerCase();
	if (!lowerToNames.has(key)) lowerToNames.set(key, new Set());
	lowerToNames.get(key).add(name);
}

function stripCode(text) {
	return text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "").replace(/`[^`\n]*`/g, "");
}

const WIKI = /!?\[\[([^\]\n]+?)\]\]/g;
const MD = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;

/** The last path segment of a link target, without alias / subpath, with `.md` normalised. */
function targetName(raw, isMarkdownLink) {
	let t = raw;
	if (!isMarkdownLink) t = t.split("|")[0];
	t = t.split("#")[0].trim();
	if (isMarkdownLink) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("<")) return null; // URLs
		try {
			t = decodeURIComponent(t);
		} catch {
			// keep the raw text
		}
	}
	if (t === "") return null;
	const last = t.split("/").pop();
	return last === "" ? null : last;
}

const mismatches = [];
let linksChecked = 0;
for (const file of files.filter((f) => extname(f).toLowerCase() === ".md")) {
	let text;
	try {
		text = readFileSync(join(root, file), "utf8");
	} catch {
		continue;
	}
	const body = stripCode(text);
	const lines = body.split("\n");
	lines.forEach((line, i) => {
		for (const [re, isMd] of [[WIKI, false], [MD, true]]) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(line)) !== null) {
				const name = targetName(m[1], isMd);
				if (!name) continue;
				const candidates = extname(name) && lowerToNames.has(name.toLowerCase()) ? [name] : [];
				candidates.push(`${name}.md`);
				// Does any candidate exist exactly? Then the case is right.
				if (candidates.some((c) => exactNames.has(c))) {
					linksChecked++;
					continue;
				}
				const real = candidates.flatMap((c) => [...(lowerToNames.get(c.toLowerCase()) ?? [])]);
				if (real.length === 0) continue; // unresolved: not a case issue
				linksChecked++;
				mismatches.push({ file, line: i + 1, link: m[0], target: name, actual: real[0] });
			}
		}
	});
}

if (asJson) {
	console.log(JSON.stringify({ vault: root, filesScanned: files.length, linksChecked, count: mismatches.length, mismatches }, null, 2));
} else {
	console.log(`vault: ${root}`);
	console.log(`files scanned: ${files.length}, resolvable links checked: ${linksChecked}`);
	console.log(`case-mismatched links: ${mismatches.length}`);
	for (const x of mismatches) console.log(`  ${x.file}:${x.line}  ${x.link}  ->  ${x.actual}`);
}
