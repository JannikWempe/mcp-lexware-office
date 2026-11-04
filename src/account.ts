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
	// A failed lookup is retried after this long instead of on every call.
	failureTtlMs?: number;
	now?: () => number;
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
	private failedAtMs?: number;

	constructor(client: LexwareApiClient, options: AccountProfileOptions = {}) {
		this.client = client;
		this.label = options.label;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	// Without an API key no request is made, so `search` keeps working offline.
	get(): Promise<AccountInfo> {
		if (!this.client.hasApiKey) return Promise.resolve(this.withLabel({ error: 'profile unavailable: no API key configured' }));
		if (this.cached && (this.failedAtMs === undefined || this.now() - this.failedAtMs < this.failureTtlMs)) return this.cached;
		this.failedAtMs = undefined;
		this.cached = this.fetch().then((account) => {
			if (account.error !== undefined) this.failedAtMs = this.now();
			return this.withLabel(account);
		});
		return this.cached;
	}

	private async fetch(): Promise<AccountInfo> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		try {
			const response = await this.client.request({ path: '/v1/profile' }, { signal });
			if (!response.ok || typeof response.data !== 'object' || response.data === null) {
				return { error: `profile unavailable: ${response.errorCategory ?? 'unknown'} (HTTP ${response.status})` };
			}
			const profile = response.data as Record<string, unknown>;
			return Object.fromEntries(PROFILE_FIELDS.filter((field) => profile[field] !== undefined).map((field) => [field, profile[field]]));
		} catch {
			return { error: `profile unavailable: ${signal.aborted ? 'timeout' : 'network'}` };
		}
	}

	private withLabel(account: AccountInfo): AccountInfo {
		return this.label !== undefined ? { label: this.label, ...account } : account;
	}
}
