// Key/value store that outlives a single `execute` call, so batched workflows can hand
// intermediate results (id lists, cursors, partial totals) to the next call. In memory, per server
// process; values are kept as their JSON text, so every `get` returns a fresh copy.

export interface SandboxStateLimits {
	// Serialized (UTF-8) size of one value.
	maxValueBytes: number;
	// Serialized size of all keys and values together.
	maxTotalBytes: number;
	maxKeys: number;
	maxKeyLength: number;
	// An entry expires this long after it was last read or written.
	idleTtlMs: number;
}

export const DEFAULT_STATE_LIMITS: SandboxStateLimits = {
	maxValueBytes: 1024 * 1024,
	maxTotalBytes: 10 * 1024 * 1024,
	maxKeys: 1_000,
	maxKeyLength: 256,
	idleTtlMs: 60 * 60 * 1000,
};

export interface SandboxStateOptions {
	limits?: Partial<SandboxStateLimits>;
	now?: () => number;
}

interface Entry {
	json: string;
	bytes: number;
	touchedAt: number;
}

export class SandboxState {
	readonly limits: SandboxStateLimits;
	private readonly now: () => number;
	private readonly entries = new Map<string, Entry>();
	private totalBytes = 0;

	constructor(options: SandboxStateOptions = {}) {
		this.limits = { ...DEFAULT_STATE_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
	}

	// The stored JSON text, or undefined for a missing or expired key.
	get(key: string): string | undefined {
		this.validateKey(key, 'get');
		this.expire();
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		entry.touchedAt = this.now();
		return entry.json;
	}

	set(key: string, json: string): void {
		this.validateKey(key, 'set');
		if (typeof json !== 'string') throw new Error('state.set expects a JSON-serializable value');
		this.expire();
		const valueBytes = Buffer.byteLength(json);
		const bytes = Buffer.byteLength(key) + valueBytes;
		if (valueBytes > this.limits.maxValueBytes) {
			throw new Error(`state.set: the value for "${key}" is ${formatBytes(valueBytes)} serialized; the limit is ${formatBytes(this.limits.maxValueBytes)} per value. Store less, or split it across keys.`);
		}
		const previous = this.entries.get(key);
		if (previous === undefined && this.entries.size >= this.limits.maxKeys) {
			throw new Error(`state.set: the state already holds ${this.limits.maxKeys} keys, the limit. Delete keys you no longer need with state.delete.`);
		}
		const totalBytes = this.totalBytes - (previous?.bytes ?? 0) + bytes;
		if (totalBytes > this.limits.maxTotalBytes) {
			throw new Error(`state.set: storing "${key}" would grow the state to ${formatBytes(totalBytes)}; the limit is ${formatBytes(this.limits.maxTotalBytes)} in total. Delete keys you no longer need with state.delete.`);
		}
		this.entries.set(key, { json, bytes, touchedAt: this.now() });
		this.totalBytes = totalBytes;
	}

	delete(key: string): void {
		this.validateKey(key, 'delete');
		this.expire();
		this.remove(key);
	}

	keys(): string[] {
		this.expire();
		return [...this.entries.keys()];
	}

	private remove(key: string) {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.entries.delete(key);
		this.totalBytes -= entry.bytes;
	}

	private expire() {
		const cutoff = this.now() - this.limits.idleTtlMs;
		for (const [key, entry] of this.entries) {
			if (entry.touchedAt <= cutoff) this.remove(key);
		}
	}

	private validateKey(key: unknown, operation: string): asserts key is string {
		if (typeof key !== 'string' || key.length === 0 || key.length > this.limits.maxKeyLength) {
			throw new Error(`state.${operation} expects a key of 1 to ${this.limits.maxKeyLength} characters, got ${typeof key === 'string' ? `${key.length} characters` : typeof key}`);
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}
