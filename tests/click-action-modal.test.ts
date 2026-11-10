import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Platform } from "obsidian";
import { ClickActionDraft, ClickActionModal, CommandPickerModal, ClickActionTarget, clickActionChoices, listRegisteredCommands } from "../src/click-action-modal";
import { ClickAction } from "../src/types";

/** Fake `app.commands.commands`: three entries, one of them App Runner's, as the spec's fixture asks. */
const COMMANDS = {
	"editor:toggle-bold": { id: "editor:toggle-bold", name: "Toggle bold" },
	"app-runner:open-live-captions": { id: "app-runner:open-live-captions", name: "App Runner: Open Live Captions" },
	"workspace:close": { id: "workspace:close", name: "Close current tab" },
};
const LIVE_ID = "app-runner:open-live-captions";

let app: App;
const saved: (ClickAction | undefined)[] = [];

function setCommands(commands: Record<string, { id: string; name: string }>): void {
	(app as unknown as { commands: unknown }).commands = { commands };
}

beforeEach(() => {
	app = new App();
	setCommands({ ...COMMANDS });
	saved.length = 0;
	Platform.isMobile = false;
});

afterEach(() => {
	Platform.isMobile = false;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function open(target: ClickActionTarget, stored?: unknown, isMobile?: boolean): ClickActionModal {
	const modal = new ClickActionModal(app, target, stored, (action) => saved.push(action), isMobile);
	modal.open();
	return modal;
}

const select = () => document.querySelector<HTMLSelectElement>(".atlas-click-action-kind")!;
const field = () => document.querySelector<HTMLInputElement>(".atlas-click-action-value input")!;
const message = () => document.querySelector<HTMLElement>(".atlas-name-message")!;
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label)!;
const optionLabels = () => Array.from(select().options).map((o) => o.textContent);

function chooseKind(value: string): void {
	select().value = value;
	select().dispatchEvent(new Event("change", { bubbles: true }));
}

function typeInto(value: string): void {
	field().value = value;
	field().dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(): KeyboardEvent {
	const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
	field().dispatchEvent(evt);
	return evt;
}

/** Opens the picker from the modal's own button, capturing the real `CommandPickerModal` it creates. */
function openPicker(): CommandPickerModal {
	const pickers: CommandPickerModal[] = [];
	vi.spyOn(CommandPickerModal.prototype, "open").mockImplementation(function (this: CommandPickerModal) {
		pickers.push(this);
	});
	document.querySelector<HTMLButtonElement>(".atlas-click-action-choose")!.click();
	expect(pickers).toHaveLength(1);
	return pickers[0];
}

function choose(picker: CommandPickerModal, query: string, index = 0): void {
	const match = picker.getSuggestions(query)[index];
	picker.onChooseSuggestion(match as never, new MouseEvent("click"));
}

describe("kind options per node type (G1, G2, G10)", () => {
	it("a module offers Default, terminal, command and URI, in that order", () => {
		expect(clickActionChoices("module", false).map((o) => o.label)).toEqual([
			"Default (open the interface note)",
			"Run terminal command (desktop only)",
			"Run Obsidian command",
			"Open Obsidian URI",
		]);
	});

	it("a Folder offers None in place of Default", () => {
		const labels = clickActionChoices("folder", false).map((o) => o.label);
		expect(labels[0]).toBe("None");
		expect(labels).not.toContain("Default (open the interface note)");
		expect(labels.slice(1)).toEqual(["Run terminal command (desktop only)", "Run Obsidian command", "Open Obsidian URI"]);
	});

	it("an API item offers Use source setting first", () => {
		expect(clickActionChoices("api-item", false)[0].label).toBe("Use source setting");
	});

	it("an API item also offers None, then the three kinds; no other target does", () => {
		expect(clickActionChoices("api-item", false).map((o) => o.label)).toEqual(["Use source setting", "None", "Run terminal command (desktop only)", "Run Obsidian command", "Open Obsidian URI"]);
		expect(clickActionChoices("api-item", false).map((o) => o.value)).toContain("none");
		for (const target of ["module", "folder"] as const) expect(clickActionChoices(target, false).map((o) => o.value)).not.toContain("none");
	});

	it("an API item's draft opens on a stored None, and its result is exactly { kind: 'none' }", () => {
		const draft = new ClickActionDraft("api-item", { kind: "none" }, false);
		expect(draft.choice).toBe("none");
		expect(draft.error()).toBeNull();
		expect(draft.result()).toEqual({ kind: "none" });
		draft.setChoice("unset");
		expect(draft.result()).toBeUndefined();
	});

	it("a module's draft reads a stored None as no action, and refuses to switch to it", () => {
		const draft = new ClickActionDraft("module", { kind: "none" }, false);
		expect(draft.choice).toBe("unset");
		draft.setChoice("none");
		expect(draft.choice).toBe("unset");
	});

	it("on mobile the terminal kind is not offered for a new setting", () => {
		for (const target of ["module", "folder", "api-item"] as const) {
			expect(clickActionChoices(target, true).map((o) => o.value)).not.toContain("terminal");
		}
	});

	it("on mobile a stored terminal action keeps its option so it can be shown", () => {
		expect(clickActionChoices("module", true, { kind: "terminal", value: "open -a Docker" }).map((o) => o.value)).toContain("terminal");
	});

	it("on mobile a stored command or URI action does not bring the terminal option back", () => {
		expect(clickActionChoices("module", true, { kind: "uri", value: "obsidian://open" }).map((o) => o.value)).not.toContain("terminal");
	});
});

describe("ClickActionDraft", () => {
	it("a module with no stored action opens on Default, and saving it stores nothing", () => {
		const draft = new ClickActionDraft("module", undefined, false);
		expect(draft.choice).toBe("unset");
		expect(draft.error()).toBeNull();
		expect(draft.result()).toBeUndefined();
	});

	it("a Folder with no stored action opens on None, and saving it stores nothing", () => {
		const draft = new ClickActionDraft("folder", undefined, false);
		expect(draft.choice).toBe("unset");
		expect(draft.result()).toBeUndefined();
	});

	it("picking Default or None after a real action stores nothing (absent), not an empty action", () => {
		const draft = new ClickActionDraft("module", { kind: "uri", value: "obsidian://open" }, false);
		draft.setChoice("unset");
		expect(draft.result()).toBeUndefined();
	});

	it("preloads the stored kind and value", () => {
		const draft = new ClickActionDraft("module", { kind: "command", value: LIVE_ID }, false);
		expect(draft.choice).toBe("command");
		expect(draft.value).toBe(LIVE_ID);
		expect(draft.result()).toEqual({ kind: "command", value: LIVE_ID });
	});

	it.each<[string, unknown]>([
		["an unknown kind", { kind: "shell", value: "ls" }],
		["a non-string value", { kind: "terminal", value: 5 }],
		["a null value", { kind: "uri", value: null }],
		["a blank value", { kind: "command", value: "   " }],
		["a string instead of an object", "run"],
		["an array", [{ kind: "uri", value: "obsidian://x" }]],
		["null", null],
	])("a malformed stored action (%s) opens on the default without throwing", (_label, stored) => {
		for (const target of ["module", "folder"] as const) {
			const draft = new ClickActionDraft(target, stored, false);
			expect(draft.choice).toBe("unset");
			expect(draft.result()).toBeUndefined();
		}
		expect(() => open("module", stored)).not.toThrow();
		expect(select().value).toBe("unset");
	});

	it("keeps each kind's draft across switches, but stores only the active kind", () => {
		const draft = new ClickActionDraft("module", undefined, false);
		draft.setChoice("terminal");
		draft.setValue("open -a Docker");
		draft.setChoice("uri");
		draft.setValue("obsidian://open?file=A");
		draft.setChoice("command");
		draft.setValue(LIVE_ID);

		draft.setChoice("terminal");
		expect(draft.value).toBe("open -a Docker");
		expect(draft.result()).toEqual({ kind: "terminal", value: "open -a Docker" });
		draft.setChoice("uri");
		expect(draft.value).toBe("obsidian://open?file=A");
		expect(draft.result()).toEqual({ kind: "uri", value: "obsidian://open?file=A" });
		draft.setChoice("unset");
		expect(draft.result()).toBeUndefined();
	});

	it("validates only the active kind: an invalid draft elsewhere does not block", () => {
		const draft = new ClickActionDraft("module", undefined, false);
		draft.setChoice("terminal");
		draft.setValue("open 'unbalanced");
		expect(draft.error()).not.toBeNull();
		draft.setChoice("uri");
		draft.setValue("obsidian://open?file=A");
		expect(draft.error()).toBeNull();
	});

	it("on mobile a stored terminal action is read-only and keeps its value", () => {
		const draft = new ClickActionDraft("module", { kind: "terminal", value: "open -a Docker" }, true);
		expect(draft.choice).toBe("terminal");
		expect(draft.readOnly).toBe(true);
		draft.setValue("rm -rf /");
		expect(draft.value).toBe("open -a Docker");
		expect(draft.result()).toEqual({ kind: "terminal", value: "open -a Docker" });
	});

	it("on mobile it can be changed to another kind, or cleared", () => {
		const draft = new ClickActionDraft("module", { kind: "terminal", value: "open -a Docker" }, true);
		draft.setChoice("uri");
		expect(draft.readOnly).toBe(false);
		draft.setValue("obsidian://open?file=A");
		expect(draft.result()).toEqual({ kind: "uri", value: "obsidian://open?file=A" });
		draft.setChoice("unset");
		expect(draft.result()).toBeUndefined();
	});

	it("on mobile a new terminal choice is refused", () => {
		const draft = new ClickActionDraft("module", undefined, true);
		draft.setChoice("terminal");
		expect(draft.choice).toBe("unset");
	});
});

describe("the modal", () => {
	it("is titled Click action, with the Kind dropdown, a value area, Save and Cancel (G1)", () => {
		const modal = open("module");
		expect(modal.titleEl.textContent).toBe("Click action");
		expect(optionLabels()).toEqual([
			"Default (open the interface note)",
			"Run terminal command (desktop only)",
			"Run Obsidian command",
			"Open Obsidian URI",
		]);
		expect(select().value).toBe("unset");
		expect(button("Save")).toBeTruthy();
		expect(button("Cancel")).toBeTruthy();
	});

	it("a Folder opens on None (G2)", () => {
		open("folder");
		expect(optionLabels()[0]).toBe("None");
		expect(select().value).toBe("unset");
	});

	it("opens preloaded with the stored kind and value", () => {
		open("module", { kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" });
		expect(select().value).toBe("uri");
		expect(field().value).toBe("obsidian://open?vault=Notes&file=Docker");
	});

	it("Save on Default stores nothing: the callback gets undefined, once", () => {
		open("module", { kind: "uri", value: "obsidian://open" });
		chooseKind("unset");
		button("Save").click();
		expect(saved).toEqual([undefined]);
	});

	it("Save on None for a Folder stores nothing", () => {
		open("folder");
		button("Save").click();
		expect(saved).toEqual([undefined]);
	});

	it("Cancel stores nothing, even after edits", () => {
		open("module");
		chooseKind("uri");
		typeInto("obsidian://open?file=A");
		button("Cancel").click();
		expect(saved).toEqual([]);
		expect(document.querySelector(".modal")).toBeNull();
	});

	it("Escape and a click outside both close the modal (Obsidian's own close path) and store nothing", () => {
		const modal = open("module");
		chooseKind("terminal");
		typeInto("open -a Docker");
		modal.close();
		expect(saved).toEqual([]);
	});

	it("closing after a Save does not fire a second save", () => {
		const modal = open("module");
		chooseKind("uri");
		typeInto("obsidian://open?file=A");
		button("Save").click();
		modal.close();
		expect(saved).toHaveLength(1);
	});

	it("double-clicking Save writes once", () => {
		open("module");
		chooseKind("uri");
		typeInto("obsidian://open?file=A");
		const save = button("Save"); // the same element is clicked twice, as a fast double-click does
		save.click();
		save.click();
		expect(saved).toEqual([{ kind: "uri", value: "obsidian://open?file=A" }]);
	});

	it("saving the same values twice (two modal sessions) hands back an identical action each time", () => {
		open("module", { kind: "command", value: LIVE_ID });
		button("Save").click();
		open("module", saved[0]);
		button("Save").click();
		expect(saved).toEqual([
			{ kind: "command", value: LIVE_ID },
			{ kind: "command", value: LIVE_ID },
		]);
	});

	it("only the active kind is stored on Save, though other kinds were edited", () => {
		open("module");
		chooseKind("terminal");
		typeInto("open -a Docker");
		chooseKind("uri");
		typeInto("obsidian://open?file=A");
		chooseKind("terminal");
		expect(field().value).toBe("open -a Docker");
		chooseKind("uri");
		expect(field().value).toBe("obsidian://open?file=A");
		button("Save").click();
		expect(saved).toEqual([{ kind: "uri", value: "obsidian://open?file=A" }]);
	});

	describe("terminal kind (G4, E5)", () => {
		beforeEach(() => {
			open("module");
			chooseKind("terminal");
		});

		it("blocks Save on an empty value with an inline error", () => {
			expect(button("Save").disabled).toBe(true);
			expect(message().textContent).not.toBe("");
			expect(message().classList.contains("atlas-hidden")).toBe(false);
		});

		it.each(["   ", "\t "])("blocks Save on whitespace only (%j)", (value) => {
			typeInto(value);
			expect(button("Save").disabled).toBe(true);
			button("Save").click();
			expect(saved).toEqual([]);
		});

		it("blocks Save on unbalanced quotes and says so", () => {
			typeInto('open -a "Live Captions');
			expect(button("Save").disabled).toBe(true);
			expect(message().textContent).toMatch(/quote/i);
			expect(field().getAttribute("aria-invalid")).toBe("true");
		});

		it("accepts quoted arguments and stores the line exactly as typed", () => {
			typeInto('open -a "Live Captions"');
			expect(button("Save").disabled).toBe(false);
			expect(message().textContent).toBe("");
			button("Save").click();
			expect(saved).toEqual([{ kind: "terminal", value: 'open -a "Live Captions"' }]);
		});

		it("does not resolve or reject a {field} placeholder at save time", () => {
			typeInto("open {path}");
			expect(button("Save").disabled).toBe(false);
			button("Save").click();
			expect(saved).toEqual([{ kind: "terminal", value: "open {path}" }]);
		});

		it("accepts a command naming a missing executable", () => {
			typeInto("definitely-not-installed --flag");
			button("Save").click();
			expect(saved).toEqual([{ kind: "terminal", value: "definitely-not-installed --flag" }]);
		});

		it("Enter saves only when valid", () => {
			typeInto("open 'x");
			expect(pressEnter().defaultPrevented).toBe(true);
			expect(saved).toEqual([]);
			expect(document.querySelector(".modal")).not.toBeNull();

			typeInto("open -a Docker");
			pressEnter();
			expect(saved).toEqual([{ kind: "terminal", value: "open -a Docker" }]);
			expect(document.querySelector(".modal")).toBeNull();
		});

		it("pressing Enter twice writes once", () => {
			typeInto("open -a Docker");
			const input = field();
			const enter = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			enter();
			enter();
			expect(saved).toHaveLength(1);
		});
	});

	describe("URI kind (G6, E4, F10)", () => {
		beforeEach(() => {
			open("module");
			chooseKind("uri");
		});

		it.each(["", "not a uri", "//no-scheme", ":foo", "docker", "   "])("refuses %j: inline error, Save disabled, nothing stored, modal stays open", (value) => {
			typeInto(value);
			expect(button("Save").disabled).toBe(true);
			expect(message().textContent).not.toBe("");
			button("Save").click();
			pressEnter();
			expect(saved).toEqual([]);
			expect(document.querySelector(".modal")).not.toBeNull();
		});

		it.each(["obsidian://open?vault=Notes&file=Docker", "https://example.com", "mailto:dan@example.com"])("accepts %s, whatever the scheme", (value) => {
			typeInto(value);
			expect(button("Save").disabled).toBe(false);
			button("Save").click();
			expect(saved).toEqual([{ kind: "uri", value }]);
		});

		it("stores exactly what was typed: no trimming, no vault-name added or replaced", () => {
			const typed = "obsidian://open?file=a  b ";
			typeInto(typed);
			button("Save").click();
			expect(saved[0]?.value).toBe(typed);
			saved.length = 0;

			open("module");
			chooseKind("uri");
			typeInto("obsidian://open?file=Docker");
			button("Save").click();
			expect(saved[0]?.value).toBe("obsidian://open?file=Docker");
		});
	});

	describe("unicode and long values", () => {
		const URI = "obsidian://open?vault=Café&file=日本語 🚀";
		const LONG = `https://example.com/?q=${"x".repeat(1977)}`;

		it.each([
			["a unicode URI", { kind: "uri", value: URI }],
			["a 2,000-character URI", { kind: "uri", value: LONG }],
			["a unicode terminal line", { kind: "terminal", value: "open -a Café 日本語" }],
			["a unicode command id", { kind: "command", value: "plügin:öpen-🚀" }],
		] as [string, ClickAction][])("%s is saved and reopened unchanged", (_label, action) => {
			expect(LONG).toHaveLength(2000);
			open("module");
			chooseKind(action.kind);
			if (action.kind === "command") {
				setCommands({ [action.value]: { id: action.value, name: "Unicode" } });
				choose(openPicker(), "");
			} else {
				typeInto(action.value);
			}
			button("Save").click();
			expect(saved).toEqual([action]);

			document.body.innerHTML = "";
			open("module", saved[0]);
			expect(select().value).toBe(action.kind);
			if (action.kind !== "command") expect(field().value).toBe(action.value);
			button("Save").click();
			expect(saved[1]).toEqual(action);
		});
	});

	describe("command kind and its picker (G5, F9)", () => {
		it("lists only the commands registered right now, by display name, and reads them live", () => {
			open("module");
			chooseKind("command");
			const first = openPicker();
			expect(first.getItems().map((c) => c.name)).toEqual(["App Runner: Open Live Captions", "Close current tab", "Toggle bold"]);
			expect(first.getItemText(first.getItems()[0])).toBe("App Runner: Open Live Captions");

			setCommands({ "only:one": { id: "only:one", name: "Only one" } });
			expect(first.getItems().map((c) => c.id)).toEqual(["only:one"]);
			expect(listRegisteredCommands(app).map((c) => c.id)).toEqual(["only:one"]);
		});

		it("an app with no commands map lists nothing and does not throw", () => {
			(app as unknown as { commands?: unknown }).commands = undefined;
			expect(listRegisteredCommands(app)).toEqual([]);
		});

		it("searching 'live' finds App Runner's command; choosing it stores the id, not the name (GP2)", () => {
			open("module");
			chooseKind("command");
			expect(button("Save").disabled).toBe(true); // nothing chosen yet
			const picker = openPicker();
			expect((picker as unknown as { placeholder: string }).placeholder).toBe("Search commands…");
			expect(picker.getSuggestions("live").map((m) => m.item.id)).toEqual([LIVE_ID]);
			choose(picker, "live");

			expect(document.querySelector(".atlas-click-action-command-name")!.textContent).toBe("App Runner: Open Live Captions");
			expect(document.querySelector(".atlas-click-action-command-id")!.textContent).toBe(LIVE_ID);
			button("Save").click();
			expect(saved).toEqual([{ kind: "command", value: LIVE_ID }]);
		});

		it("reopening shows the chosen command", () => {
			open("module", { kind: "command", value: LIVE_ID });
			expect(select().value).toBe("command");
			expect(document.querySelector(".atlas-click-action-command-name")!.textContent).toBe("App Runner: Open Live Captions");
			expect(document.querySelector(".atlas-click-action-command-id")!.textContent).toBe(LIVE_ID);
		});

		it("a stored id that is no longer registered shows as the raw id and can be saved unchanged", () => {
			open("module", { kind: "command", value: "gone-plugin:gone-command" });
			expect(document.querySelector(".atlas-click-action-command-name")!.textContent).toBe("gone-plugin:gone-command");
			expect(button("Save").disabled).toBe(false);
			button("Save").click();
			expect(saved).toEqual([{ kind: "command", value: "gone-plugin:gone-command" }]);
		});

		it("closing the picker without choosing changes nothing", () => {
			open("module", { kind: "command", value: LIVE_ID });
			const picker = openPicker();
			picker.close();
			button("Save").click();
			expect(saved).toEqual([{ kind: "command", value: LIVE_ID }]);
		});

		it("closing the modal closes an open picker", () => {
			const modal = open("module");
			chooseKind("command");
			const picker = openPicker();
			const close = vi.spyOn(picker, "close");
			modal.close();
			expect(close).toHaveBeenCalled();
		});
	});

	describe("on mobile", () => {
		it("does not offer the terminal kind for a new setting", () => {
			open("module", undefined, true);
			expect(optionLabels()).toEqual(["Default (open the interface note)", "Run Obsidian command", "Open Obsidian URI"]);
		});

		it("reads Platform.isMobile when no flag is passed", () => {
			Platform.isMobile = true;
			open("module");
			expect(optionLabels()).not.toContain("Run terminal command (desktop only)");
		});

		it("shows a stored terminal action read-only with its value", () => {
			open("module", { kind: "terminal", value: "open -a Docker" }, true);
			expect(select().value).toBe("terminal");
			expect(field().value).toBe("open -a Docker");
			expect(field().readOnly).toBe(true);
			button("Save").click();
			expect(saved).toEqual([{ kind: "terminal", value: "open -a Docker" }]);
		});

		it("lets a stored terminal action be changed to another kind", () => {
			open("module", { kind: "terminal", value: "open -a Docker" }, true);
			chooseKind("uri");
			expect(field().readOnly).toBe(false);
			typeInto("obsidian://open?file=A");
			button("Save").click();
			expect(saved).toEqual([{ kind: "uri", value: "obsidian://open?file=A" }]);
		});

		it("lets a stored terminal action be cleared", () => {
			open("module", { kind: "terminal", value: "open -a Docker" }, true);
			chooseKind("unset");
			button("Save").click();
			expect(saved).toEqual([undefined]);
		});
	});

	it("scroll: switching kind rebuilds only the value area and puts `.modal`'s scrollTop back", () => {
		const modal = open("module");
		let top = 120;
		Object.defineProperty(modal.modalEl, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
		const valueEl = document.querySelector<HTMLElement>(".atlas-click-action-value")!;
		const empty = valueEl.empty.bind(valueEl);
		valueEl.empty = () => {
			empty();
			top = 0; // what scroll anchoring does to a rebuilt `.modal`
		};
		chooseKind("uri");
		expect(top).toBe(120);
		chooseKind("command");
		expect(top).toBe(120);
	});
});
