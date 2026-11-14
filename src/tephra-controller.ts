import { runTephraTeardown, type TephraTeardownFailure } from "./tephra-teardown";
import type { TephraConnection } from "./tephra-connection";

export interface TephraControllerDeps {
	/** The saved setting (`settings.tephraEnabled`). */
	getEnabled: () => boolean;
	/** Writes the setting in memory only; `save` persists it. */
	setEnabled: (enabled: boolean) => void;
	/** Saves `data.json` at once (not debounced): a quick reload must not lose the toggle. */
	save: () => Promise<void>;
	/** Mobile never builds a connection and behaves as if the toggle were off. */
	isMobile: () => boolean;
	createConnection: () => TephraConnection;
	/** Runs the registered teardown steps in order; defaults to the plugin-wide registry. */
	runTeardown?: () => Promise<TephraTeardownFailure[]>;
	reportTeardownFailures: (failures: TephraTeardownFailure[]) => void;
	/** E13: asked before the toggle goes on. Resolving false refuses it: the setting stays off, nothing is saved
	 * or connected, and the callee has already said why. Optional: absent means always allowed. */
	beforeEnable?: () => Promise<boolean>;
	/** Called after every applied change, with the setting already updated (the link hook re-syncs here). */
	afterChange: (enabled: boolean) => void;
}

/**
 * G16: owns the Tephra connection's life. Built only while the toggle is on (and never on mobile); with it
 * off there is no client, no timer and no call.
 *
 * Only `setEnabled(false)` runs the teardown steps. `dispose()`, which `onunload` calls, only stops the
 * connection (its timer): disabling Atlas or quitting Obsidian must change no file and no setting (E8).
 * After `dispose()` the controller is inert: a change that was mid-flight when the plugin unloaded finishes
 * its own setting and save but builds no connection, and any flip still queued is dropped.
 */
export class TephraController {
	private connection: TephraConnection | null = null;
	private applied: boolean;
	private desired: boolean;
	private draining: Promise<void> | null = null;
	private disposed = false;

	constructor(private readonly deps: TephraControllerDeps) {
		this.applied = deps.getEnabled() && !deps.isMobile();
		this.desired = this.applied;
	}

	/** The live connection, or null while the toggle is off. */
	getConnection(): TephraConnection | null {
		return this.connection;
	}

	/** Plugin load: connects if the saved toggle is on and this isn't mobile; otherwise does nothing at all. */
	startIfEnabled(): void {
		if (this.applied && !this.disposed) this.ensureConnection();
	}

	/**
	 * Turns the toggle on or off. Flips that arrive while one is being applied are collapsed: the result is
	 * the last value asked for, applied one change at a time, so there is never more than one live timer and
	 * no check is left running after an off. Resolves when the plugin has settled in the last requested state.
	 */
	setEnabled(enabled: boolean): Promise<void> {
		if (this.disposed || this.deps.isMobile()) return Promise.resolve();
		this.desired = enabled;
		if (!this.draining) {
			this.draining = this.drain().finally(() => {
				this.draining = null;
			});
		}
		return this.draining;
	}

	/**
	 * Plugin unload (E8): stops the timer and nothing else. No teardown, no setting, no file. Also marks the
	 * controller disposed so a change already being applied can't build a new connection once it resumes,
	 * and the drain loop starts no further change.
	 */
	dispose(): void {
		this.disposed = true;
		this.connection?.stop();
		this.connection = null;
	}

	private async drain(): Promise<void> {
		while (!this.disposed && this.applied !== this.desired) {
			const target = this.desired;
			let result = target;
			try {
				if (target) {
					if (await this.applyOn()) result = true;
					else {
						// Refused (E13): stays off, and a later flip is a fresh request.
						result = false;
						this.desired = false;
					}
				} else await this.applyOff();
			} catch (error) {
				console.error("[Atlas] turning Tephra on or off failed", error);
			} finally {
				this.applied = result; // never retried in a loop: a failed save leaves the in-memory state as asked
			}
		}
	}

	/** Returns false when `beforeEnable` refused: then nothing was changed. */
	private async applyOn(): Promise<boolean> {
		if (this.deps.beforeEnable && !(await this.deps.beforeEnable())) return false;
		if (this.disposed) return false;
		this.deps.setEnabled(true);
		try {
			await this.deps.save();
		} finally {
			// Unloaded while the save was pending: no connection, and nothing re-syncs against a dead plugin.
			if (!this.disposed) {
				this.ensureConnection();
				this.deps.afterChange(true);
			}
		}
		return true;
	}

	private async applyOff(): Promise<void> {
		try {
			const failures = await (this.deps.runTeardown ?? runTephraTeardown)();
			if (failures.length > 0) this.deps.reportTeardownFailures(failures);
		} finally {
			// Whatever the steps did, the toggle goes off: a stuck step must not keep Tephra running.
			this.deps.setEnabled(false);
			try {
				await this.deps.save();
			} finally {
				this.connection?.stop();
				this.connection = null;
				if (!this.disposed) this.deps.afterChange(false);
			}
		}
	}

	private ensureConnection(): void {
		this.connection ??= this.deps.createConnection();
		this.connection.start();
	}
}
