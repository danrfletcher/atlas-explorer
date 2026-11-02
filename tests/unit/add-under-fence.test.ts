import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(path: string): string {
	return readFileSync(resolve(__dirname, "../../", path), "utf8");
}

// Same static-text check fence-checks.test.ts uses for its own F5 checks; kept as a plain local
// copy rather than an import since fence-checks.test.ts doesn't export it.
const DISK_WRITE_CALL = /\.(create|createFolder|createBinary|modify|modifyBinary|append|delete|trash|rename|copy)\s*\(|renameFile\s*\(|fileManager\s*\./;

const ADD_UNDER_MENTION = /add[-_ ]?under/i;

/** Every file that can register a command, hotkey or key handler. Commands are actually registered in
 * `commands.ts` and `f10-commands.ts` (`main.ts` only wires them up), so all four plus the view are scanned. */
const COMMAND_SOURCES = ["src/main.ts", "src/commands.ts", "src/f10-commands.ts", "src/explorer-view.ts"];

/** The text of one method: from its signature to the next sibling member (a `private` method or a
 * doc comment at class-member indentation). */
function methodBody(source: string, signature: string): string {
	const start = source.indexOf(signature);
	expect(start, `${signature} not found`).toBeGreaterThan(-1);
	const rest = source.slice(start + signature.length);
	const end = rest.search(/\n\t(?:private |public |async |\/\*\*)/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** F2 static check: this PR adds a menu item and a no-op seam only — no command, hotkey or
 * toolbar button, and no disk write anywhere in the new module. */
describe("PR-2.F1 F2 — no command, hotkey or toolbar change; add-under.ts writes nothing to disk", () => {
	it.each(COMMAND_SOURCES)("%s registers no add-under command or hotkey", (path) => {
		const body = read(path);
		// Each addCommand call (id, name, callback, hotkeys) is checked for any add-under mention.
		for (const match of body.matchAll(/addCommand\(/g)) {
			const call = body.slice(match.index, match.index + 700);
			// Stop at the next addCommand so one command's window never reads into its neighbour.
			const own = call.split(/addCommand\(/)[1] ?? call;
			expect(own).not.toMatch(ADD_UNDER_MENTION);
			expect(own).not.toMatch(/startAddUnder|addUnder/);
		}
		expect(body).not.toMatch(/hotkeys\s*:/);
	});

	it.each(["src/main.ts", "src/commands.ts", "src/f10-commands.ts"])("%s neither imports nor mentions the add-under modules", (path) => {
		const body = read(path);
		expect(body).not.toMatch(/from\s+["']\.\/add-under/);
		expect(body).not.toMatch(ADD_UNDER_MENTION);
	});

	it("the set of commands that exist is unchanged (none of them is an Add under… command)", () => {
		const names = COMMAND_SOURCES.flatMap((path) => [...read(path).matchAll(/name:\s*["']([^"']+)["']/g)].map((m) => m[1]));
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((n) => ADD_UNDER_MENTION.test(n))).toEqual([]);
	});

	it("handleRowKeydown handles exactly the keys it did before and never starts an add-under flow", () => {
		const body = methodBody(read("src/explorer-view.ts"), "private handleRowKeydown(");
		const keys = [...body.matchAll(/evt\.key === "([^"]*)"/g)].map((m) => m[1]);
		expect(keys).toEqual(["Enter", " ", "Delete", "F2", "Escape"]);
		expect(body).not.toMatch(ADD_UNDER_MENTION);
		expect(body).not.toMatch(/startAddUnder|runAddUnder/);
	});

	it("the toolbar's create section (Add block/file/module/folder) still has exactly four buttons", () => {
		const body = read("src/explorer-view.ts");
		const start = body.indexOf("// --- section 2: create");
		const end = body.indexOf("// --- section 3: view controls");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const section = body.slice(start, end);
		const count = (section.match(/this\.toolbarButton\(/g) ?? []).length;
		expect(count).toBe(4);
		expect(section).not.toMatch(/startAddUnder|runAddUnder/);
	});

	it("src/add-under.ts contains no disk-write call", () => {
		expect(read("src/add-under.ts")).not.toMatch(DISK_WRITE_CALL);
	});
});
