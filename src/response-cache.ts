// In-memory cache of successful GET responses, shared by all execute calls of this server process.
// Safe to share because one process serves one API key. LexwareApiClient decides what is cacheable
// (catalog cacheTtlSeconds, 2xx JSON) and reports every write it sends; this class stores serialized
// responses with an expiry, evicts the least recently used beyond its limits, and serves nothing while a write is in flight.

export interface ResponseCacheLimits {
	maxEntries: number;
	// Serialized (UTF-8) size of all keys and responses together.
	maxTotalBytes: number;
}

export const DEFAULT_RESPONSE_CACHE_LIMITS: ResponseCacheLimits = {
	maxEntries: 200,
	maxTotalBytes: 5 * 1024 * 1024,
};

export interface ResponseCacheOptions {
	limits?: Partial<ResponseCacheLimits>;
	now?: () => number;
}

interface Entry {
	json: string;
	bytes: number;
	expiresAt: number;
}

export class ResponseCache {
	private readonly limits: ResponseCacheLimits;
	private readonly now: () => number;
	// Map iteration order is insertion order: re-inserting on a hit keeps the oldest entry first.
	private readonly entries = new Map<string, Entry>();
	private totalBytes = 0;
	// Bumped by clear(), so a response requested before a write is not stored after it.
	private currentGeneration = 0;
	private writesInFlight = 0;

	constructor(options: ResponseCacheOptions = {}) {
		this.limits = { ...DEFAULT_RESPONSE_CACHE_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
	}

	get generation(): number {
		return this.currentGeneration;
	}

	// The stored JSON text, or undefined for a missing or expired key or while a write is in flight.
	get(key: string): string | undefined {
		if (this.writesInFlight > 0) return undefined;
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.remove(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.json;
	}

	// Ignored if the cache was cleared since `generation` was read. An entry larger than the limit
	// is not stored, but still drops the older response under the same key.
	set(key: string, json: string, ttlMs: number, generation: number): void {
		if (generation !== this.currentGeneration || this.writesInFlight > 0) return;
		this.remove(key);
		const bytes = Buffer.byteLength(key) + Buffer.byteLength(json);
		if (ttlMs <= 0 || bytes > this.limits.maxTotalBytes) return;
		this.entries.set(key, { json, bytes, expiresAt: this.now() + ttlMs });
		this.totalBytes += bytes;
		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= this.limits.maxEntries && this.totalBytes <= this.limits.maxTotalBytes) break;
			this.remove(oldest);
		}
	}

	// Call when a write is handed to fetch, and the returned function once it settled. Lexware may apply
	// the write any time in between, so the cache is cleared at both ends and neither serves nor stores meanwhile.
	writeSent(): () => void {
		this.clear();
		this.writesInFlight += 1;
		let settled = false;
		return () => {
			if (settled) return;
			settled = true;
			this.writesInFlight -= 1;
			this.clear();
		};
	}

	private clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
		this.currentGeneration += 1;
	}

	private remove(key: string) {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.entries.delete(key);
		this.totalBytes -= entry.bytes;
	}
}
