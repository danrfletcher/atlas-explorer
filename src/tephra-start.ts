import { executeApiCommand, type CommandRunResult, type CommandRunnerOptions } from "./api-command-runner";

/** F7: the one command Atlas may run for Tephra, and only when Dan clicks Start in the status bar. */
export const TEPHRA_START_ARGV: readonly string[] = ["tephractl", "daemon", "start"];

export interface TephraStarterDeps {
	/** Asks the connection for a check now; resolves when it is done. Called once the start command has exited. */
	check: () => Promise<void>;
	/** Runs a command with no shell. Defaults to `executeApiCommand`, which shows one notice if it fails. */
	run?: (argv: string[], options?: CommandRunnerOptions) => Promise<CommandRunResult>;
	/** Passed through to the runner (`spawnImpl`, `noticeImpl`), so a test can stand in for the process launch and the notice. */
	runnerOptions?: CommandRunnerOptions;
}

/**
 * G13/E1/F7: starts Tephra when, and only when, `start()` is called. Nothing in Atlas calls it except a click on
 * the status bar's Start (see `TephraStatusBar`): not plugin load, not the toggle, not a failed poll, not a
 * focus check, not a failed RPC call.
 *
 * While a run is pending a second `start()` does nothing (one `tephractl daemon start` per click burst). The
 * `starting` state lasts until the command has exited and the check after it has finished, so the status bar
 * reads "Tephra starting…" until the next answer. A command that fails (non-zero exit, `tephractl` not on PATH)
 * ends `starting` at once; the runner has already shown its one notice.
 */
export class TephraStarter {
	private starting = false;
	/** Bumped when a run ends or is cut short, so a run that finishes late can't clear a newer one's state. */
	private run = 0;
	private listeners = new Set<() => void>();

	constructor(private readonly deps: TephraStarterDeps) {}

	isStarting(): boolean {
		return this.starting;
	}

	/** Subscribes to `isStarting()` changes; returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Ends the starting state now: Tephra answered by itself (the poll saw it online) or the toggle went off.
	 * A run still pending is left to finish, but it no longer owns the state. */
	cancel(): void {
		this.run++;
		this.setStarting(false);
	}

	/** Runs `tephractl daemon start` unless one is already pending. Never throws. */
	async start(): Promise<void> {
		if (this.starting) return;
		const run = ++this.run;
		this.setStarting(true);
		let result: CommandRunResult;
		try {
			result = await (this.deps.run ?? executeApiCommand)([...TEPHRA_START_ARGV], this.deps.runnerOptions);
		} catch (error) {
			console.error("[Atlas] starting Tephra failed", error);
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (run !== this.run) return;
		if (result.ok) {
			try {
				await this.deps.check();
			} catch (error) {
				console.error("[Atlas] the check after starting Tephra failed", error);
			}
			if (run !== this.run) return;
		}
		this.setStarting(false);
	}

	private setStarting(next: boolean): void {
		if (this.starting === next) return;
		this.starting = next;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch (error) {
				console.error("[Atlas] a Tephra start listener threw", error);
			}
		}
	}
}
