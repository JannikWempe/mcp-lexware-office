import type { CallToolResult } from '@modelcontextprotocol/server';

import { type CodeExecutor, QuickJsExecutor } from './executor.js';
import type { LexwareApiClient, RequestLogEntry } from './lexware-client.js';
import { lexwareSandbox } from './lexware-sandbox-sdk.js';
import { lexwareSpec } from './lexware-spec.js';
import { truncateJson } from './truncate.js';

// Keep a single Lexware request shorter than the execute timeout so that a slow request
// fails with a clean error the sandbox can still handle. Request chains (incl. a GET 429
// retry waiting up to 5 s) can exceed EXECUTE_TIMEOUT_MS; the executor then aborts in-flight
// requests and reports them as cancelled in `requests`. Pass this to the LexwareApiClient.
export const LEXWARE_REQUEST_TIMEOUT_MS = 25_000;
const EXECUTE_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 1_000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_STACK_SIZE_BYTES = 1024 * 1024;
// Up to this many successful reads are listed in `requests`; more are collapsed into `readsSummary`.
const MAX_LISTED_READS = 5;

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
				...lexwareSandbox(this.client, { beforeSend, onSettled: (entry) => requests.push(entry) }),
			},
		);

		const requestLog = summarizeRequests(requests);
		if (execution.error) {
			return toolResult({ ok: false, error: execution.error, logs: execution.logs ?? [], requestCount, ...requestLog }, true);
		}

		return toolResult({ ok: true, result: execution.result, logs: execution.logs ?? [], requestCount, ...requestLog });
	}

	// Inject the write mode so callers can branch before attempting a write.
	private sandboxSpec() {
		return { ...lexwareSpec, info: { ...lexwareSpec.info, writesEnabled: this.client.writesEnabled } };
	}
}

interface ReadsSummary {
	count: number;
	byStatus: Record<string, number>;
	totalDurationMs: number;
}

// Writes, non-OK responses, and errored or unsent attempts are always listed in full, since
// callers rely on `requests` to see which writes happened. Successful reads only add noise in
// read-heavy fan-outs, so beyond MAX_LISTED_READS they are collapsed into `readsSummary`.
function summarizeRequests(requests: RequestLogEntry[]): { requests: RequestLogEntry[]; readsSummary?: ReadsSummary } {
	const isSuccessfulRead = (entry: RequestLogEntry) => !entry.write && entry.ok === true;
	const reads = requests.filter(isSuccessfulRead);
	if (reads.length <= MAX_LISTED_READS) return { requests };
	const byStatus: Record<string, number> = {};
	for (const { status } of reads) byStatus[String(status)] = (byStatus[String(status)] ?? 0) + 1;
	return {
		requests: requests.filter((entry) => !isSuccessfulRead(entry)),
		readsSummary: { count: reads.length, byStatus, totalDurationMs: reads.reduce((sum, entry) => sum + entry.durationMs, 0) },
	};
}

// The text block and structuredContent carry the same object. An oversized result is shrunk
// structurally (see truncateJson), so both stay valid JSON and carry a `truncated` hint. The
// audit fields are kept whole (unless they alone come close to the limit), so callers see which writes happened.
const AUDIT_KEYS = ['ok', 'requestCount', 'requests', 'readsSummary'];

function toolResult(payload: Record<string, unknown>, isError = false): CallToolResult {
	let normalized: Record<string, unknown>;
	let serializable = true;
	try {
		// Round-trip first so truncation measures exactly what gets serialized (toJSON, dropped undefined).
		normalized = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
	} catch (error) {
		serializable = false;
		// Without `ok`: an `ok: true` next to this error would contradict it.
		const audit = Object.fromEntries(AUDIT_KEYS.filter((key) => key !== 'ok' && key in payload).map((key) => [key, payload[key]]));
		normalized = { ...audit, error: 'Result is not JSON-serializable', detail: String(error) };
	}
	const structured = truncateJson(normalized, { keep: AUDIT_KEYS }) as Record<string, unknown>;
	const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }] };
	if (serializable) result.structuredContent = structured;
	if (isError) result.isError = true;
	return result;
}
