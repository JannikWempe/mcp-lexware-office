import { delimiter } from 'node:path';

import { parseWriteAllow, type WriteAllowRule } from './write-policy.js';

export interface ServerConfig {
	apiKey?: string;
	baseUrl?: string;
	// Human label for this instance, shown in spec.info.account.
	accountLabel?: string;
	// Directories multipart contentPath may read from; empty disables contentPath.
	uploadDirs: string[];
	writesEnabled: boolean;
	// Writes allowed when writesEnabled; undefined allows every write.
	writeAllow?: WriteAllowRule[];
	// Cache reference-data GETs across execute calls; LEXWARE_OFFICE_CACHE=off disables it.
	cacheEnabled: boolean;
}

// The only place that reads the environment. Everything else gets these values injected.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	return {
		apiKey: env.LEXWARE_OFFICE_API_KEY,
		baseUrl: parseBaseUrl(env.LEXWARE_OFFICE_API_BASE_URL),
		accountLabel: env.LEXWARE_OFFICE_ACCOUNT_LABEL,
		uploadDirs: (env.LEXWARE_OFFICE_UPLOAD_DIRS ?? '')
			.split(delimiter)
			.map((dir) => dir.trim())
			.filter((dir) => dir.length > 0),
		// Writes are blocked by default and require explicit opt-in; READ_ONLY is a hard block that wins over ALLOW_WRITES.
		// READ_ONLY fails closed: any value but empty or false (e.g. TRUE, 1, yes) blocks writes.
		writesEnabled: !isReadOnly(env.LEXWARE_OFFICE_READ_ONLY) && env.LEXWARE_OFFICE_ALLOW_WRITES === 'true',
		// Throws on entries that don't name a cataloged write, so a typo fails at startup instead of silently blocking.
		writeAllow: env.LEXWARE_OFFICE_WRITE_ALLOW !== undefined ? parseWriteAllow(env.LEXWARE_OFFICE_WRITE_ALLOW) : undefined,
		cacheEnabled: env.LEXWARE_OFFICE_CACHE !== 'off',
	};
}

// Empty means unset, so the client falls back to the default. Anything else must be an http(s) URL, checked at startup
// instead of failing every request with "Invalid URL".
function parseBaseUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed === '') return undefined;
	if (!URL.canParse(trimmed) || !['http:', 'https:'].includes(new URL(trimmed).protocol)) {
		throw new Error(`LEXWARE_OFFICE_API_BASE_URL "${value}" is not an http(s) URL. Unset it to use the default.`);
	}
	return trimmed;
}

function isReadOnly(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== '' && normalized !== 'false';
}
