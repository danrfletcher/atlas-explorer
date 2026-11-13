import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** E4: the report-only script, run for real against a throwaway vault. */
const script = join(__dirname, "../../scripts/count-case-mismatched-links.mjs");

function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, name.name);
			if (name.isSymbolicLink()) out[p] = `-> ${readlinkSync(p)}`; // record the link, never follow it
			else if (name.isDirectory()) walk(p);
			else out[p] = readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

describe("scripts/count-case-mismatched-links.mjs", () => {
	it("counts only links whose case differs from the target, ignores code, URLs and unresolved links, and writes nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "atlas-e4-"));
		mkdirSync(join(dir, "Notes"));
		mkdirSync(join(dir, ".obsidian"));
		writeFileSync(join(dir, "Notes", "Leg Day.md"), "# Leg Day\n");
		writeFileSync(join(dir, "pic.PNG"), "x");
		writeFileSync(
			join(dir, "a.md"),
			[
				"ok: [[Leg Day]] [[Notes/Leg Day]] [[Leg Day#h|alias]] ![[pic.PNG]] [t](Notes/Leg%20Day.md)",
				"bad: [[leg day]] [[LEG DAY.md]] ![[pic.png]] [t](notes/leg%20day.md)",
				"ignored: [[Nope]] [u](https://x.com/LEG.md) `[[leg day]]`",
				"```",
				"[[leg day]]",
				"```",
			].join("\n")
		);
		writeFileSync(join(dir, ".obsidian", "b.md"), "[[leg day]]");
		const before = snapshot(dir);
		const report = JSON.parse(execFileSync("node", [script, dir, "--json"], { encoding: "utf8" }));
		expect(report.count).toBe(4);
		expect(report.mismatches.map((m: { link: string }) => m.link)).toEqual(["[[leg day]]", "[[LEG DAY.md]]", "![[pic.png]]", "[t](notes/leg%20day.md)"]);
		expect(snapshot(dir)).toEqual(before); // read-only
	});

	it("does not follow symlinks: linked sources and symlink loops are not scanned or counted", () => {
		const base = mkdtempSync(join(tmpdir(), "atlas-e4-link-"));
		const vault = join(base, "vault");
		const outside = join(base, "whoop-source"); // a real folder outside the vault, as Sources/<name> will point at
		mkdirSync(join(vault, "Sources"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(vault, "Leg Day.md"), "[[leg day]]\n"); // the vault's own mismatch
		writeFileSync(join(outside, "Plan.md"), "[[leg day]] [[LEG DAY]]\n"); // would add two if followed
		symlinkSync(outside, join(vault, "Sources", "whoop"), "dir");
		symlinkSync(vault, join(vault, "loop"), "dir"); // loop back into the vault
		symlinkSync(join(outside, "Plan.md"), join(vault, "Linked Plan.md"), "file");
		const before = snapshot(vault);
		const report = JSON.parse(execFileSync("node", [script, vault, "--json"], { encoding: "utf8" }));
		expect(report.filesScanned).toBe(1);
		expect(report.count).toBe(1);
		expect(report.mismatches.map((m: { file: string }) => m.file)).toEqual(["Leg Day.md"]);
		expect(snapshot(vault)).toEqual(before);
	});

	it("exits non-zero with usage when no vault is given", () => {
		expect(() => execFileSync("node", [script], { stdio: "pipe" })).toThrow();
	});
});
