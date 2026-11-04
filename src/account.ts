import type { LexwareApiClient } from './lexware-client.js';

// The connected organization as the sandboxes see it in spec.info.account. Only business facts:
// the user name and email in profile.created are deliberately left out.
export interface AccountInfo {
	// LEXWARE_OFFICE_ACCOUNT_LABEL, to tell several server instances apart.
	label?: string;
	organizationId?: string;
	companyName?: string;
	taxType?: string;
	smallBusiness?: boolean;
	distanceSalesPrinciple?: string;
	businessFeatures?: string[];
	// Set instead of the profile fields when GET /v1/profile failed.
	error?: string;
}

export interface AccountProfileOptions {
	label?: string;
	// Bounds the profile request, which runs before the sandbox and outside its timeout.
	timeoutMs?: number;
	// A failed lookup is retried after this long instead of on every call. Timeouts and 429s,
	// which a busy rate-limit queue can cause, are retried on the next call (a 429 after Retry-After).
	failureTtlMs?: number;
	now?: () => number;
}

export interface AccountGetOptions {
	// Resolve with a "still loading" error instead of waiting longer for the lookup, which keeps running.
	maxWaitMs?: number;
}

const PROFILE_FIELDS = ['organizationId', 'companyName', 'taxType', 'smallBusiness', 'distanceSalesPrinciple', 'businessFeatures'] as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;

/**
 * Lazily fetches GET /v1/profile once and caches it for the process lifetime. Never throws:
 * failures resolve to `{ error }`. The request bypasses the execute budget and audit log.
 */
export class AccountProfile {
	private readonly client: LexwareApiClient;
	private readonly label?: string;
	private readonly timeoutMs: number;
	private readonly failureTtlMs: number;
	private readonly now: () => number;
	private cached?: Promise<AccountInfo>;
	// When the cached lookup must be redone; undefined while in flight or after a success.
	private expiresAtMs?: number;

	constructor(client: LexwareApiClient, options: AccountProfileOptions = {}) {
		this.client = client;
		this.label = options.label;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	// Without an API key no request is made, so `search` keeps working offline.
	get(options: AccountGetOptions = {}): Promise<AccountInfo> {
		if (!this.client.hasApiKey) return Promise.resolve(this.withLabel({ error: 'profile unavailable: no API key configured' }));
		if (this.cached === undefined || (this.expiresAtMs !== undefined && this.now() >= this.expiresAtMs)) {
			this.expiresAtMs = undefined;
			this.cached = this.fetch().then(({ account, retryAfterMs }) => {
				if (retryAfterMs !== undefined) this.expiresAtMs = this.now() + retryAfterMs;
				return this.withLabel(account);
			});
		}
		return options.maxWaitMs !== undefined ? this.within(this.cached, options.maxWaitMs) : this.cached;
	}

	private async fetch(): Promise<{ account: AccountInfo; retryAfterMs?: number }> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		const failed = (reason: string, retryAfterMs = this.failureTtlMs) => ({ account: { error: `profile unavailable: ${reason}` }, retryAfterMs });
		try {
			const response = await this.client.request({ path: '/v1/profile' }, { signal });
			if (!response.ok || typeof response.data !== 'object' || response.data === null) {
				const category = response.errorCategory ?? 'unknown';
				return failed(`${category} (HTTP ${response.status})`, category === 'rate_limit' ? (response.retryAfterSeconds ?? 0) * 1000 : undefined);
			}
			const profile = response.data as Record<string, unknown>;
			const account: AccountInfo = Object.fromEntries(PROFILE_FIELDS.filter((field) => profile[field] !== undefined).map((field) => [field, profile[field]]));
			return Object.keys(account).length > 0 ? { account } : failed(`no profile fields in response (HTTP ${response.status})`);
		} catch {
			return signal.aborted ? failed('timeout', 0) : failed('network');
		}
	}

	private async within(lookup: Promise<AccountInfo>, maxWaitMs: number): Promise<AccountInfo> {
		let timer: NodeJS.Timeout | undefined;
		const loading = new Promise<AccountInfo>((resolve) => {
			timer = setTimeout(() => resolve(this.withLabel({ error: 'profile still loading; check again in a later call' })), maxWaitMs);
		});
		try {
			return await Promise.race([lookup, loading]);
		} finally {
			clearTimeout(timer);
		}
	}

	private withLabel(account: AccountInfo): AccountInfo {
		return this.label !== undefined ? { label: this.label, ...account } : account;
	}
}
