/**
 * G16 / R3-3: the clean-up that only the Tephra toggle's off path may run.
 *
 * Later PRs register a step here for each thing they change outside Atlas's own `data.json` (PR-3 removes
 * the `Sources/` folder links, PR-10 restores Obsidian's "Automatically update internal links").
 * `TephraController.setEnabled(false)` is the ONLY caller of `runTephraTeardown`. Plugin unload (a
 * disabled plugin, quitting Obsidian) must never reach it: E8 says nothing changes on unload, so the
 * `Sources/` links and the link setting stay as they were.
 */

export interface TephraTeardownStep {
	/** Shown when the step fails, so the user (and the console) can tell which clean-up did not finish. */
	name: string;
	/** Must be safe to run more than once: a failed step runs again on the next toggle-off. */
	run: () => void | Promise<void>;
}

export interface TephraTeardownFailure {
	name: string;
	error: unknown;
}

export class TephraTeardownRegistry {
	private steps: TephraTeardownStep[] = [];

	/** Appends a step; steps run in registration order. Returns a function that removes it again. */
	register(step: TephraTeardownStep): () => void {
		this.steps.push(step);
		return () => {
			const index = this.steps.indexOf(step);
			if (index >= 0) this.steps.splice(index, 1);
		};
	}

	/** Names of the registered steps, in run order. */
	names(): string[] {
		return this.steps.map((step) => step.name);
	}

	/**
	 * Runs every step in order, one at a time (each awaited before the next starts). A step that throws
	 * or rejects is recorded and the rest still run. Steps stay registered afterwards.
	 */
	async run(): Promise<TephraTeardownFailure[]> {
		const failures: TephraTeardownFailure[] = [];
		for (const step of [...this.steps]) {
			try {
				await step.run();
			} catch (error) {
				failures.push({ name: step.name, error });
			}
		}
		return failures;
	}

	/** Test helper: forgets every step. */
	clear(): void {
		this.steps = [];
	}
}

/** The plugin-wide registry later PRs register into. */
export const tephraTeardown = new TephraTeardownRegistry();

export function registerTephraTeardown(step: TephraTeardownStep): () => void {
	return tephraTeardown.register(step);
}

export function runTephraTeardown(): Promise<TephraTeardownFailure[]> {
	return tephraTeardown.run();
}
