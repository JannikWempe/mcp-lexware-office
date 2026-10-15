import type { CallToolResult } from '@modelcontextprotocol/server';

import { type CodeExecutor, QuickJsExecutor } from './executor.js';
import type { LexwareApiClient, RequestLogEntry } from './lexware-client.js';
import { lexwareSpec } from './lexware-spec.js';
import { truncateText } from './truncate.js';

// Keep a single Lexware request shorter than the execute timeout so that a slow request
// fails with a clean error the sandbox can still handle. Request chains (incl. a GET 429
// retry waiting up to 5 s) can exceed EXECUTE_TIMEOUT_MS; the executor then aborts in-flight
// requests and reports them as cancelled in `requests`. Pass this to the LexwareApiClient.
export const LEXWARE_REQUEST_TIMEOUT_MS = 25_000;
const EXECUTE_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 1_000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_STACK_SIZE_BYTES = 1024 * 1024;

export interface CodeModeOptions {
	client: LexwareApiClient;
	executor?: CodeExecutor;
}

export interface RunOptions {
	signal?: AbortSignal;
}

export interface ExecuteOptions extends RunOptions {
	// Budget of HTTP attempts sent to Lexware (fetch calls, incl. 429 retries).
	maxRequests: number;
}

// Runs one `search` or `execute` tool call to completion and returns the MCP tool result.
export class CodeMode {
	private readonly client: LexwareApiClient;
	private readonly executor: CodeExecutor;

	constructor(options: CodeModeOptions) {
		this.client = options.client;
		this.executor = options.executor ?? new QuickJsExecutor();
	}

	async search(code: string, options: RunOptions = {}): Promise<CallToolResult> {
		const execution = await this.executor.execute(
			code,
			{ spec: this.sandboxSpec() },
			{
				timeoutMs: SEARCH_TIMEOUT_MS,
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				maxStackSizeBytes: MAX_STACK_SIZE_BYTES,
				filename: 'lexware-search.js',
				signal: options.signal,
			},
		);

		if (execution.error) {
			return toolResult({ ok: false, error: execution.error, logs: execution.logs ?? [] }, true);
		}

		return toolResult({ ok: true, result: execution.result, logs: execution.logs ?? [] });
	}

	// requestCount is the number of attempts sent to Lexware, i.e. `requests` entries with
	// `sent: true`. Requests rejected before sending (validation, blocked writes, cancelled
	// while queued) don't consume budget; an attempt over budget fails unsent.
	async execute(code: string, options: ExecuteOptions): Promise<CallToolResult> {
		const { maxRequests } = options;
		let requestCount = 0;
		const requests: RequestLogEntry[] = [];
		const beforeSend = () => {
			if (requestCount >= maxRequests) {
				throw new Error(`Execution exceeded maxRequests=${maxRequests}`);
			}
			requestCount += 1;
		};
		const execution = await this.executor.execute(
			code,
			{ spec: this.sandboxSpec() },
			{
				timeoutMs: EXECUTE_TIMEOUT_MS,
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				maxStackSizeBytes: MAX_STACK_SIZE_BYTES,
				filename: 'lexware-execute.js',
				signal: options.signal,
				hostFunctions: {
					__lexwareRequestJson: async (payload, { signal }) => {
						const request = JSON.parse(payload) as unknown;
						const response = await this.client.request(request, { signal, beforeSend, onSettled: (entry) => requests.push(entry) });
						return JSON.stringify(response);
					},
				},
			},
		);

		if (execution.error) {
			return toolResult({ ok: false, error: execution.error, logs: execution.logs ?? [], requestCount, requests }, true);
		}

		return toolResult({ ok: true, result: execution.result, logs: execution.logs ?? [], requestCount, requests });
	}

	// Inject the write mode so callers can branch before attempting a write.
	private sandboxSpec() {
		return { ...lexwareSpec, info: { ...lexwareSpec.info, writesEnabled: this.client.writesEnabled } };
	}
}

// The text block (truncated) stays for clients without structuredContent support.
// structuredContent mirrors it but is never truncated, so it is only attached when the
// full JSON fits within the truncation limit.
function toolResult(payload: Record<string, unknown>, isError = false): CallToolResult {
	let json: string;
	let serializable = true;
	try {
		json = JSON.stringify(payload, null, 2);
	} catch (error) {
		serializable = false;
		json = JSON.stringify({ error: 'Result is not JSON-serializable', detail: String(error) }, null, 2);
	}
	const text = truncateText(json);
	const result: CallToolResult = { content: [{ type: 'text', text }] };
	if (serializable && text === json) result.structuredContent = payload;
	if (isError) result.isError = true;
	return result;
}
