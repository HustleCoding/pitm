/**
 * Custom errors for pi-task-master. No silent failures: every domain error
 * surfaces a clear, typed message so the orchestrator can route to
 * `needs_human` instead of crashing ambiguously.
 */

export class PitmError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "PitmError";
	}
}

export class ConfigError extends PitmError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR");
		this.name = "ConfigError";
	}
}

export class StateError extends PitmError {
	constructor(message: string) {
		super(message, "STATE_ERROR");
		this.name = "StateError";
	}
}

export class ModelResolutionError extends PitmError {
	constructor(message: string) {
		super(message, "MODEL_RESOLUTION_ERROR");
		this.name = "ModelResolutionError";
	}
}

export class GitError extends PitmError {
	constructor(message: string) {
		super(message, "GIT_ERROR");
		this.name = "GitError";
	}
}

export class DoctorError extends PitmError {
	constructor(message: string) {
		super(message, "DOCTOR_ERROR");
		this.name = "DoctorError";
	}
}

/** True if the thrown value is one of our typed domain errors. */
export function isPitmError(e: unknown): e is PitmError {
	return e instanceof PitmError;
}
