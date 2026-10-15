import { delimiter } from 'node:path';

export interface ServerConfig {
	apiKey?: string;
	baseUrl?: string;
	// Directories multipart contentPath may read from; empty disables contentPath.
	uploadDirs: string[];
	writesEnabled: boolean;
}

// The only place that reads the environment. Everything else gets these values injected.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	return {
		apiKey: env.LEXWARE_OFFICE_API_KEY,
		baseUrl: env.LEXWARE_OFFICE_API_BASE_URL,
		uploadDirs: (env.LEXWARE_OFFICE_UPLOAD_DIRS ?? '')
			.split(delimiter)
			.map((dir) => dir.trim())
			.filter((dir) => dir.length > 0),
		// Writes are blocked by default and require explicit opt-in; READ_ONLY is a hard block that wins over ALLOW_WRITES.
		writesEnabled: env.LEXWARE_OFFICE_READ_ONLY !== 'true' && env.LEXWARE_OFFICE_ALLOW_WRITES === 'true',
	};
}
