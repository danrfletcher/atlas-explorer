import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileJsMapper } from "../../src/api-js-mapping";
import { CLICK_FUNCTION_HELP } from "../../src/api-source-modal";

/** Atlas-18 (G18): the click-action docs say what the shipped build does. Each test reads the real markdown
 * with `fs` and checks it against the real code (the helper-text constant, the JS compile helper), so a
 * doc can't drift from the modal or promise something the fence rules out. No network, no vault mock. */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const README = "README.md";
const USING = "docs/using-the-explorer.md";
const SOURCES = "docs/data-sources.md";
const DOC_FILES = [README, USING, SOURCES];

/** The text of a `##`/`###` section: from its heading to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => /^#{2,3} /.test(line) && line.replace(/^#+ /, "") === heading);
	if (start === -1) throw new Error(`no section "${heading}"`);
	const level = lines[start].match(/^#+/)![0].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const match = lines[i].match(/^(#+) /);
		if (match && match[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

describe("G18: every term the docs must carry", () => {
	// [file, term]: each term must appear in the named file.
	const TERMS: [string, string][] = [
		// README
		[README, "**Run something on click.**"],
		[README, "terminal command"],
		[README, "Obsidian command"],
		[README, "Obsidian URI"],
		[README, "module, Folder or API item"],
		[README, "docs/using-the-explorer.md#click-actions"],
		// using-the-explorer: section, kinds per row type, setting and clearing
		[USING, "## Click actions"],
		[USING, "Default (open the interface note)"],
		[USING, "Run terminal command (desktop only)"],
		[USING, "Run Obsidian command"],
		[USING, "Open Obsidian URI"],
		[USING, "Use source setting"],
		[USING, "Click action…"],
		[USING, "Clear click action"],
		[USING, "Choose command…"],
		[USING, "**Save**"],
		// value rules
		[USING, "without a shell"],
		[USING, "pipes, redirects, `&&`, globbing, `~` and environment variables"],
		[USING, "`{field}` placeholders work only in an API source's own static command"],
		[USING, "picker of the commands registered right now"],
		[USING, "`new URL()`"],
		[USING, "exactly as typed"],
		// feedback, debounce, gestures, Folder
		[USING, "A failure shows a notice and changes nothing. Success is silent."],
		[USING, "within 1 second"],
		[USING, "ignored, with no feedback"],
		[USING, "not cmd/ctrl-click, shift-click, drag or middle-click, and not a click on a module's icon"],
		[USING, "A long press on a module does not run it either (it opens Module contents)"],
		[USING, "a long press on a Folder or an API item counts as a click and runs the action"],
		[USING, "not a click on a module's icon, a status dot or the chevron"],
		[USING, "A Folder's icon and an API item's icon have no job of their own, so a click on either runs the action"],
		[SOURCES, "or on the row's status dot, does not call the function"],
		[USING, "runs the action only and does not fold"],
		[USING, "The chevron and **Space** still fold"],
		[USING, "**Enter** on a Folder runs its action"],
		// the module with no action
		[USING, "A module with no action keeps opening its interface note"],
		[USING, "right-click **Open** and middle-click"],
		// mobile
		[USING, "desktop only"],
		[USING, "hidden when you set a new action on mobile"],
		[USING, "Atlas: terminal actions are desktop only"],
		[USING, "the setting is kept"],
		// data-sources: renamed paragraph and the three new ones
		[SOURCES, "### Source click action"],
		[SOURCES, "### Click function"],
		[SOURCES, "### Item override"],
		[SOURCES, "[Click function](#click-function)"],
		[SOURCES, "[Item override](#item-override)"],
		// precedence, in order
		[SOURCES, "1. The row's [Item override](#item-override)."],
		[SOURCES, "2. The Click function's result."],
		[SOURCES, "3. The source click action."],
		[SOURCES, "4. Open attachment, which applies only when the source click action is **Open attachment** or unset"],
		// Click function behaviour beyond the helper text
		[SOURCES, "An empty box means no function."],
		[SOURCES, "`argv` goes straight to the runner with no tokenizing and no `{field}` resolution"],
		[SOURCES, "`{ kind: \"none\" }` stops everything"],
		[SOURCES, "a Promise return or a throw shows a notice"],
		[SOURCES, "runs nothing"],
		[SOURCES, "`extra = {}`"],
		[SOURCES, "Guard `item.extra`"],
		[SOURCES, "within 1 second"],
		[SOURCES, "unsandboxed and has no timeout"],
		[SOURCES, "Atlas's full trust"],
		[SOURCES, "Save compiles the code but never runs it"],
		// Item override
		[SOURCES, "Clear click action"],
		[SOURCES, "Use source setting"],
		[SOURCES, "**None**"],
		[SOURCES, "**Merge** refresh keeps an override"],
		[SOURCES, "**Overwrite** drops it along with the row"],
		[SOURCES, "does not copy overrides"],
		[SOURCES, "whose source was removed, or on a Table or CSV row, does nothing; the setting is kept"],
	];

	it.each(TERMS)("%s contains %j", (file, term) => {
		expect(read(file)).toContain(term);
	});

	it("the Click actions section sits after Keyboard", () => {
		const text = read(USING);
		expect(text.indexOf("## Keyboard")).toBeGreaterThan(-1);
		expect(text.indexOf("## Click actions")).toBeGreaterThan(text.indexOf("## Keyboard"));
	});

	it("the Click actions section lists the kinds per row type", () => {
		const table = section(read(USING), "Click actions");
		const row = (name: string): string => table.split("\n").find((line) => line.startsWith(`| ${name} |`)) ?? "";
		for (const kind of ["Run terminal command (desktop only)", "Run Obsidian command", "Open Obsidian URI"]) {
			for (const name of ["Module", "Folder", "API item"]) expect(row(name)).toContain(kind);
		}
		expect(row("Module")).toContain("Default (open the interface note)");
		expect(row("Folder")).toContain("**None**");
		expect(row("API item")).toContain("Use source setting");
		expect(row("API item")).toContain("**None**");
		expect(row("Module")).not.toContain("Use source setting");
	});

	it("the three right-click lists and Keyboard mention the action", () => {
		const text = read(USING);
		expect(section(text, "Right-click a unit row (a block, file or module in the bucket)")).toContain("**Click action…** (modules only)");
		expect(section(text, "Right-click a Folder row")).toContain("**Click action…**");
		expect(section(text, "Right-click an API item row")).toContain("**Clear click action**");
		expect(section(text, "Keyboard")).toContain("[Click action](#click-actions)");
	});

	it("the README bullet is in the feature list and names no plugin", () => {
		const bullet = read(README)
			.split("\n")
			.find((line) => line.startsWith("- **Run something on click.**"));
		expect(bullet).toBeDefined();
		expect(bullet).toMatch(/terminal command/);
		expect(bullet).toMatch(/Obsidian command/);
		expect(bullet).toMatch(/Obsidian URI/);
		expect(bullet).not.toMatch(/app[ -]?runner|advanced uri/i);
		expect(read(README).indexOf(bullet!)).toBeGreaterThan(read(README).indexOf("## What you can do"));
	});
});

describe("G18: stale wording is gone", () => {
	it.each([
		[USING, "A Folder row just folds and unfolds"],
		[USING, "With a row focused: **Enter** opens it"],
		[USING, "Click** a row to open its note. A module opens its interface note; a module's **icon** opens"],
		[SOURCES, "**Click action.** What happens when a row is clicked"],
		[USING, "not a click on the icon, the status dot or the chevron"],
		[SOURCES, "or on the row's icon or status dot"],
		[USING, "middle-click or long-press, and not a click"],
	])("%s no longer says %j", (file, stale) => {
		expect(read(file)).not.toContain(stale);
	});
});

describe("G18: links and anchors resolve", () => {
	/** GitHub/kramdown-style heading id: lower-case, markup and punctuation dropped, spaces to hyphens. */
	function slug(heading: string): string {
		return heading
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/[*_`]/g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N} -]/gu, "")
			.trim()
			.replace(/ /g, "-");
	}
	function anchors(markdown: string): Set<string> {
		const out = new Set<string>();
		let inFence = false;
		for (const line of markdown.split("\n")) {
			if (line.startsWith("```")) inFence = !inFence;
			const match = !inFence && line.match(/^#{1,6} (.*)$/);
			if (match) out.add(slug(match[1]));
		}
		return out;
	}

	it("the headings this PR links to exist", () => {
		expect(anchors(read(USING)).has("click-actions")).toBe(true);
		const sources = anchors(read(SOURCES));
		for (const id of ["api", "click-function", "item-override", "source-click-action"]) expect(sources.has(id)).toBe(true);
	});

	it.each(DOC_FILES)("every relative link in %s points at an existing file and heading", (file) => {
		const text = read(file);
		const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href));
		expect(links.length).toBeGreaterThan(0);
		for (const href of links) {
			const [path, hash] = href.split("#");
			const target = path === "" ? file : resolve(dirname(file), path).replace(`${ROOT}/`, "");
			const targetText = readFileSync(resolve(ROOT, target), "utf8"); // throws when the file does not exist
			if (hash && target.endsWith(".md")) {
				expect(anchors(targetText), `${file} links to ${href}`).toContain(hash);
			}
		}
	});
});

describe("G18: the worked example is real code", () => {
	/** The one fenced `js` block in data-sources.md that holds the example Click function. */
	function exampleSource(): string {
		const blocks = [...read(SOURCES).matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
		const found = blocks.filter((block) => block.includes("item.extra.path"));
		expect(found).toHaveLength(1);
		return found[0];
	}

	it("is the plan's function, byte for byte", () => {
		expect(exampleSource()).toBe(
			`(item) => item.extra.path ? { kind: "terminal", argv: ["open", "-a", item.extra.path] } : { kind: "command", id: "app-runner:open-" + item.id }`
		);
	});

	it("compiles with the JS mapping helper and gives a terminal result, then a command result", () => {
		const compiled = compileJsMapper(exampleSource());
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.fn({ id: "a", extra: { path: "Docker" } })).toEqual({ kind: "terminal", argv: ["open", "-a", "Docker"] });
		expect(compiled.fn({ id: "b", extra: {} })).toEqual({ kind: "command", id: "app-runner:open-b" });
	});

	it("a row added later works with no per-item setup (it is the same function, new item)", () => {
		const compiled = compileJsMapper(exampleSource());
		if (!compiled.ok) throw new Error(compiled.error);
		expect(compiled.fn({ id: "new-app", label: "New App", secondary: undefined, extra: {} })).toEqual({ kind: "command", id: "app-runner:open-new-app" });
	});
});

describe("G18: the quoted helper text is the modal's helper text", () => {
	it("every paragraph of CLICK_FUNCTION_HELP appears, in order, as one blockquote in data-sources.md", () => {
		expect(CLICK_FUNCTION_HELP.length).toBeGreaterThan(0);
		const quoted = CLICK_FUNCTION_HELP.map((line) => `> ${line}`).join("\n>\n");
		expect(read(SOURCES)).toContain(quoted);
	});

	it("the contract still names every shape the docs promise", () => {
		const contract = CLICK_FUNCTION_HELP.join("\n");
		for (const phrase of [
			"Runs when you click a row",
			"item is { id, label, secondary, extra }",
			'{ kind: "terminal", argv: [...] }',
			'{ kind: "command", id }',
			'{ kind: "uri", uri }',
			'{ kind: "none" }',
			"return nothing",
			"must be synchronous",
			"guard it",
		]) {
			expect(contract).toContain(phrase);
		}
	});
});

describe("G18: the docs do not promise what the fence rules out", () => {
	const all = DOC_FILES.map((file) => ({ file, lines: read(file).split("\n") }));

	it("F4: App Runner and Advanced URI are never named; the only mention is a sample command id", () => {
		for (const { file, lines } of all) {
			lines.forEach((line, i) => {
				for (const match of line.matchAll(/app runner|app-runner|advanced uri/gi)) {
					const around = line.slice(Math.max(0, match.index! - 1), match.index! + match[0].length + 1);
					expect(/app-runner/i.test(match[0]) && /app-runner:open-/.test(line), `${file}:${i + 1} ${around}`).toBe(true);
				}
			});
		}
	});

	it("F2: a shell form is only ever mentioned as unsupported", () => {
		for (const { file, lines } of all) {
			lines.forEach((line, i) => {
				if (/\b(sh|bash|zsh) -c\b/.test(line)) expect(line, `${file}:${i + 1}`).toMatch(/not supported/);
			});
		}
	});

	it("F6/F7: nothing about a confirm prompt, palette command, hotkey, MCP tool, output capture or run history for click actions", () => {
		const clickText = [section(read(USING), "Click actions"), section(read(SOURCES), "Source click action"), section(read(SOURCES), "Click function"), section(read(SOURCES), "Item override"), read(README).split("\n").find((l) => l.startsWith("- **Run something on click.**")) ?? ""].join("\n");
		expect(clickText).not.toMatch(/confirm|hotkey|command palette|MCP|output capture|run history|log view/i);
	});

	it("F11/F12: no fold-on-click setting, and middle-click opens nothing for a Folder or an API item", () => {
		for (const { file, lines } of all) {
			lines.forEach((line, i) => {
				expect(line, `${file}:${i + 1}`).not.toMatch(/fold[- ]on[- ]click|fold on click/i);
			});
		}
		for (const line of section(read(USING), "Click actions").split("\n")) {
			if (/middle-click/i.test(line)) expect(line).not.toMatch(/Folder|API item/);
		}
	});

	it("F1: the Click actions section limits actions to modules, Folders and API items, and the function to API sources", () => {
		const text = read(USING);
		expect(section(text, "Click actions")).toContain("Only modules, Folders and API items");
		for (const { file, lines } of all) {
			lines.forEach((line, i) => {
				expect(line, `${file}:${i + 1}`).not.toMatch(/(block|file)s? (can|may|also) (have|get) a Click action/i);
				expect(line, `${file}:${i + 1}`).not.toMatch(/(CSV|Markdown table|Folder) sources? (can|may) have a Click function/i);
			});
		}
	});
});
