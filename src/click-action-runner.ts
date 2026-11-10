import type { spawn } from "child_process";
import { Notice, Platform } from "obsidian";
import { executeApiCommand } from "./api-command-runner";
import { resolveArgv, tokenizeCommand } from "./command-argv";
import { MIDDLE_CLICK_CONTROL_SELECTOR } from "./middle-click-open";
import { ClickAction, ViewNode } from "./types";

/** Atlas-18 (G3, G12, G13, E1, E9): runs a stored Click action (a terminal command, an Obsidian command id
 * or a URI). Deliberately free of the explorer view so every rule is testable with explicit inputs: the
 * view only decides *whether* a click or Enter should run an action; this module decides what running it
 * means. Atlas knows nothing about which commands or schemes exist: the stored id or URI is passed on
 * exactly as saved (F4, F9, F10). */

/** E9: a second run of the same node inside this window, measured from the START of the previous run
 * (not its end), is ignored with no feedback. */
export const CLICK_ACTION_DEBOUNCE_MS = 1000;

/** What `app.commands` must offer. Obsidian does not type it publicly, so this is the one structural cast. */
export interface ClickActionCommands {
	executeCommandById?: (id: string) => unknown;
}

export interface ClickActionRunnerOptions {
	/** The Obsidian app (only `commands` is read). Called through as stored: no cached command list (F9). */
	app: { commands?: ClickActionCommands };
	noticeImpl?: (message: string) => void;
	spawnImpl?: typeof spawn;
}

/** `no-action`: the stored value is missing or malformed, so nothing ran and the caller keeps today's
 * behaviour. `debounced`: ignored by E9. `ran`: dispatched with nothing to report. `failed`: a notice was shown. */
export type ClickActionOutcome = "no-action" | "debounced" | "ran" | "failed";

/** Reads a stored `clickAction` defensively at run time. `data.json` is hand-editable and may bypass the
 * load-time sanitiser, so anything that is not `{kind: terminal|command|uri, value: non-blank string}` is
 * treated as no action. Never throws, never changes its input; `value` is returned exactly as stored. */
export function readRunnableClickAction(raw: unknown): ClickAction | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { kind, value } = raw as { kind?: unknown; value?: unknown };
	if (kind !== "terminal" && kind !== "command" && kind !== "uri") return undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return { kind, value };
}

/** F1/G14: the Click action a Bucket row runs on a plain click or Enter, or undefined when it has none.
 * Only a module (a `unit` node holding a folder ref) and a Folder (`meta` node) can have one: a block, file,
 * Table/CSV row never does, even if a hand-edited `data.json` put a `clickAction` on it. An
 * Outside-Vault-managed module is excluded too (its plain click opens nothing, so there is no default for the
 * action to replace). `outsideManaged` is a callback so it is only evaluated when a stored action exists. */
export function rowClickAction(node: ViewNode, outsideManaged: () => boolean): ClickAction | undefined {
	if (node.clickAction === undefined) return undefined;
	if (node.type === "unit" && (node.ref?.kind !== "folder" || outsideManaged())) return undefined;
	return readRunnableClickAction(node.clickAction);
}

/** G3/E13: the action an Enter key press runs: `rowClickAction` when the key is Enter, else undefined. */
export function clickActionForEnter(evt: { key: string }, node: ViewNode, outsideManaged: () => boolean): ClickAction | undefined {
	return evt.key === "Enter" ? rowClickAction(node, outsideManaged) : undefined;
}

/** F5: whether a click landed on a control inside the row that owns its own job (chevron, status dot,
 * remove button, badge, connection dot, sort indicator, truncation row), so it must never run the action.
 * `iconIsControl` adds a module's icon, which opens Module Contents; a Folder's icon has no job of its own. */
export function clickHitsRowControl(evt: Event, rowEl: HTMLElement, iconIsControl: boolean): boolean {
	const target = evt.target;
	if (!(target instanceof Element)) return false;
	const selector = iconIsControl ? `${MIDDLE_CLICK_CONTROL_SELECTOR}, .atlas-icon` : MIDDLE_CLICK_CONTROL_SELECTOR;
	const hit = target.closest(selector);
	return hit !== null && rowEl.contains(hit);
}

/** F5: a click or key press with any modifier is a selection or editing gesture, never a run. */
export function hasModifier(evt: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
	return evt.shiftKey || evt.metaKey || evt.ctrlKey || evt.altKey;
}

export class ClickActionRunner {
	/** Node id -> `Date.now()` at the start of its last run. Entries older than the window are dropped on
	 * each run, so it never grows past the nodes clicked in the last second. */
	private readonly lastStart = new Map<string, number>();

	constructor(private readonly options: ClickActionRunnerOptions) {}

	private notify(message: string): void {
		(this.options.noticeImpl ?? ((msg: string) => new Notice(msg)))(message);
	}

	/** Runs `raw` (a stored `clickAction`, treated as untrusted) for the node `nodeId`. Resolves once the
	 * action has been dispatched; for a terminal action, once the process has exited. Never rejects and never
	 * changes any stored state: a failure is a notice only (E1). */
	async run(nodeId: string, raw: unknown): Promise<ClickActionOutcome> {
		const action = readRunnableClickAction(raw);
		if (!action) return "no-action";
		if (!this.tryStart(nodeId)) return "debounced";
		return this.dispatch(action);
	}

	/** E9: claims `nodeId` for a run starting now. False when its previous run started less than the window
	 * ago (the caller ignores the click, with no feedback). Entries older than the window are dropped here. */
	tryStart(nodeId: string): boolean {
		const now = Date.now();
		for (const [id, startedAt] of this.lastStart) {
			if (now - startedAt >= CLICK_ACTION_DEBOUNCE_MS) this.lastStart.delete(id);
		}
		const previous = this.lastStart.get(nodeId);
		if (previous !== undefined && now - previous < CLICK_ACTION_DEBOUNCE_MS) return false;
		this.lastStart.set(nodeId, now);
		return true;
	}

	/** Atlas-18 (G9): runs what an API source's Click function returned, after the caller has claimed the
	 * debounce with `tryStart`. `command` and `uri` go through the same runners as a stored action. A
	 * terminal `argv` is spawned as given: no tokenizing and no `{field}` resolution, so an element such as
	 * `"{path}"` reaches the process literally (still `shell: false`). Never rejects. */
	async runFunctionOutcome(outcome: { kind: "terminal"; argv: string[] } | { kind: "command"; id: string } | { kind: "uri"; uri: string }): Promise<ClickActionOutcome> {
		try {
			if (outcome.kind === "terminal") return await this.spawnArgv(outcome.argv);
			if (outcome.kind === "command") return await this.runCommand(outcome.id);
			return this.runUri(outcome.uri);
		} catch (err: unknown) {
			console.error("Atlas: click function action failed", err);
			return "failed";
		}
	}

	private async dispatch(action: ClickAction): Promise<ClickActionOutcome> {
		try {
			if (action.kind === "terminal") return await this.runTerminal(action.value);
			if (action.kind === "command") return await this.runCommand(action.value);
			return this.runUri(action.value);
		} catch (err: unknown) {
			// Every branch below handles its own expected failures; this only stops an unexpected throw
			// (for example a notice implementation that throws) from becoming an unhandled rejection.
			console.error("Atlas: click action failed", err);
			return "failed";
		}
	}

	/** G3/G4/G13: the same tokenizer and runner an API source's static command uses, with no shell. A
	 * `{field}` placeholder has no row data here, so it gives the existing resolve-error notice and nothing spawns. */
	private async runTerminal(value: string): Promise<ClickActionOutcome> {
		if (Platform.isMobile) {
			this.notify("Atlas: terminal actions are desktop only");
			return "failed";
		}
		const tokens = tokenizeCommand(value);
		if (!tokens.ok) {
			this.notify(`Atlas: command error — ${tokens.error}`);
			return "failed";
		}
		const resolved = resolveArgv(tokens.tokens, undefined);
		if (!resolved.ok) {
			this.notify(`Atlas: ${resolved.error}`);
			return "failed";
		}
		return this.spawnArgv(resolved.argv);
	}

	/** Desktop only (G13). `shell: false` is `executeApiCommand`'s own rule. */
	private async spawnArgv(argv: string[]): Promise<ClickActionOutcome> {
		if (Platform.isMobile) {
			this.notify("Atlas: terminal actions are desktop only");
			return "failed";
		}
		const result = await executeApiCommand(argv, { noticeImpl: (msg) => this.notify(msg), spawnImpl: this.options.spawnImpl });
		return result.ok ? "ran" : "failed";
	}

	/** G5/E1: `executeCommandById` returns false for an id that is not registered right now. */
	private async runCommand(id: string): Promise<ClickActionOutcome> {
		const commands = this.options.app.commands;
		if (!commands || typeof commands.executeCommandById !== "function") {
			this.notify(`Atlas: command not found: ${id}`);
			return "failed";
		}
		let result: unknown;
		try {
			result = commands.executeCommandById(id);
		} catch (err: unknown) {
			this.notify(`Atlas: command failed: ${err instanceof Error ? err.message : String(err)}`);
			return "failed";
		}
		if (result && typeof (result as { then?: unknown }).then === "function") {
			try {
				result = await (result as PromiseLike<unknown>);
			} catch (err: unknown) {
				this.notify(`Atlas: command failed: ${err instanceof Error ? err.message : String(err)}`);
				return "failed";
			}
		}
		if (result === false) {
			this.notify(`Atlas: command not found: ${id}`);
			return "failed";
		}
		return "ran";
	}

	/** G6/F10: `window.open` gets the stored value byte for byte, with no vault name added or rewritten.
	 * A throw, or a null return on desktop, is a failure; on mobile a null return is not (unverified), only a throw is. */
	private runUri(uri: string): ClickActionOutcome {
		let opened: unknown;
		try {
			opened = window.open(uri);
		} catch {
			this.notify("Atlas: couldn't open URI");
			return "failed";
		}
		if (opened === null && !Platform.isMobile) {
			this.notify("Atlas: couldn't open URI");
			return "failed";
		}
		return "ran";
	}
}
