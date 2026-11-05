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
		baseUrl: env.LEXWARE_OFFICE_API_BASE_URL,
		accountLabel: env.LEXWARE_OFFICE_ACCOUNT_LABEL,
		uploadDirs: (env.LEXWARE_OFFICE_UPLOAD_DIRS ?? '')
			.split(delimiter)
			.map((dir) => dir.trim())
			.filter((dir) => dir.length > 0),
		// Writes are blocked by default and require explicit opt-in; READ_ONLY is a hard block that wins over ALLOW_WRITES.
		writesEnabled: env.LEXWARE_OFFICE_READ_ONLY !== 'true' && env.LEXWARE_OFFICE_ALLOW_WRITES === 'true',
		// Throws on entries that don't name a cataloged write, so a typo fails at startup instead of silently blocking.
		writeAllow: env.LEXWARE_OFFICE_WRITE_ALLOW !== undefined ? parseWriteAllow(env.LEXWARE_OFFICE_WRITE_ALLOW) : undefined,
		cacheEnabled: env.LEXWARE_OFFICE_CACHE?.trim().toLowerCase() !== 'off',
	};
}
