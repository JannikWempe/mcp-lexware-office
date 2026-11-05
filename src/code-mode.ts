import type { CallToolResult } from '@modelcontextprotocol/server';

import type { AccountInfo, AccountProfile } from './account.js';
import { catalogLookupPrelude } from './catalog-lookup.js';
import { type CodeExecutor, QuickJsExecutor } from './executor.js';
import { type LexwareApiClient, type PlannedWrite, type RequestLogEntry, untilAborted } from './lexware-client.js';
import { lexwareSandbox, stateSandbox } from './lexware-sandbox-sdk.js';
import { lexwareSpec } from './lexware-spec.js';
import { SandboxState } from './sandbox-state.js';
import { truncateJson } from './truncate.js';

// Keep a single Lexware request shorter than the execute timeout so that a slow request
// fails with a clean error the sandbox can still handle. Request chains (incl. a GET 429
// retry waiting up to 5 s) can exceed EXECUTE_TIMEOUT_MS; the executor then aborts in-flight
// requests and reports them as cancelled in `requests`. Pass this to the LexwareApiClient.
export const LEXWARE_REQUEST_TIMEOUT_MS = 25_000;
const EXECUTE_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 1_000;
// `search` doesn't wait longer than this for a cold or slow profile lookup.
const SEARCH_ACCOUNT_WAIT_MS = 1_000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
// Up to this many successful reads are listed in `requests`; more are collapsed into `readsSummary`.
const MAX_LISTED_READS = 5;
// A planned write's body in `plannedWrites` is shrunk structurally beyond this many characters.
const MAX_PLANNED_BODY_CHARS = 4_000;
// Planned writes cost no request budget, so this bounds what a dry run holds on the host.
const MAX_PLANNED_WRITES = 100;

export interface CodeModeOptions {
	client: LexwareApiClient;
	executor?: CodeExecutor;
	// Shown as spec.info.account.
	account: Pick<AccountProfile, 'get'>;
	// Guest `state` of execute, shared by all execute calls of this instance.
	state?: SandboxState;
}

export interface RunOptions {
	signal?: AbortSignal;
}

export interface ExecuteOptions extends RunOptions {
	// Budget of HTTP attempts sent to Lexware (fetch calls, incl. 429 retries).
	maxRequests: number;
	// Writes are planned instead of sent and listed in `plannedWrites`; reads run normally.
	dryRun?: boolean;
}

// Runs one `search` or `execute` tool call to completion and returns the MCP tool result.
export class CodeMode {
	private readonly client: LexwareApiClient;
	private readonly executor: CodeExecutor;
	private readonly account: Pick<AccountProfile, 'get'>;
	private readonly state: SandboxState;

	constructor(options: CodeModeOptions) {
		this.client = options.client;
		this.executor = options.executor ?? new QuickJsExecutor();
		this.account = options.account;
		this.state = options.state ?? new SandboxState();
	}

	async search(code: string, options: RunOptions = {}): Promise<CallToolResult> {
		const execution = await this.executor.execute(
			code,
			{ spec: await this.sandboxSpec(options.signal, SEARCH_ACCOUNT_WAIT_MS) },
			{
				timeoutMs: SEARCH_TIMEOUT_MS,
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				filename: 'lexware-search.js',
				signal: options.signal,
				prelude: catalogLookupPrelude,
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
		const { maxRequests, dryRun = false } = options;
		let requestCount = 0;
		const requests: RequestLogEntry[] = [];
		// Slots are reserved in request order; a plan whose body fails to serialize leaves its slot empty.
		const plannedWrites: Array<PlannedWrite | undefined> = [];
		const onPlanned = (planning: Promise<PlannedWrite>) => {
			if (plannedWrites.length >= MAX_PLANNED_WRITES) {
				throw new Error(`Dry run exceeded ${MAX_PLANNED_WRITES} planned writes`);
			}
			const slot = plannedWrites.push(undefined) - 1;
			planning.then((write) => {
				plannedWrites[slot] = write.body !== undefined ? { ...write, body: truncateJson(write.body, { maxChars: MAX_PLANNED_BODY_CHARS }) } : write;
			}, () => {});
		};
		const beforeSend = () => {
			if (requestCount >= maxRequests) {
				throw new Error(`Execution exceeded maxRequests=${maxRequests}`);
			}
			requestCount += 1;
		};
		const sandbox = lexwareSandbox(this.client, { beforeSend, onSettled: (entry) => requests.push(entry), dryRun, onPlanned });
		// A dry run sees the stored state but its changes are discarded, so it can't advance a real job's cursor.
		const state = stateSandbox(dryRun ? this.state.fork() : this.state);
		const execution = await this.executor.execute(
			code,
			{ spec: await this.sandboxSpec(options.signal) },
			{
				timeoutMs: EXECUTE_TIMEOUT_MS,
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				filename: 'lexware-execute.js',
				signal: options.signal,
				hostFunctions: { ...sandbox.hostFunctions, ...state.hostFunctions },
				prelude: `${catalogLookupPrelude}\n${sandbox.prelude}\n${state.prelude}`,
			},
		);

		const audit = { requestCount, ...summarizeRequests(requests), ...(dryRun && { dryRun, plannedWrites: plannedWrites.filter((write) => write !== undefined) }) };
		if (execution.error) {
			return toolResult({ ok: false, error: execution.error, logs: execution.logs ?? [], ...audit }, true);
		}

		return toolResult({ ok: true, result: execution.result, logs: execution.logs ?? [], ...audit });
	}

	// Inject the write mode and allowlist so callers can branch before attempting a write, and
	// the connected organization so they can confirm the account. When cancelled before or while
	// the profile loads, it is skipped; the executor then reports the cancellation.
	private async sandboxSpec(signal: AbortSignal | undefined, maxAccountWaitMs?: number) {
		const account: AccountInfo | undefined = signal?.aborted ? undefined : await untilAborted(this.account.get({ maxWaitMs: maxAccountWaitMs }), signal).catch(() => undefined);
		return { ...lexwareSpec, info: { ...lexwareSpec.info, writesEnabled: this.client.writesEnabled, writePolicy: this.client.writePolicy, account } };
	}
}

interface ReadsSummary {
	count: number;
	byStatus: Record<string, number>;
	totalDurationMs: number;
	// Reads answered from the response cache, included in count.
	cached?: number;
}

// Writes, non-OK responses, and errored or unsent attempts (but not cache hits) are always listed in full, since
// callers rely on `requests` to see which writes happened. Successful reads only add noise in
// read-heavy fan-outs, so beyond MAX_LISTED_READS they are collapsed into `readsSummary`.
function summarizeRequests(requests: RequestLogEntry[]): { requests: RequestLogEntry[]; readsSummary?: ReadsSummary } {
	const isSuccessfulRead = (entry: RequestLogEntry) => !entry.write && entry.ok === true;
	const reads = requests.filter(isSuccessfulRead);
	if (reads.length <= MAX_LISTED_READS) return { requests };
	const byStatus: Record<string, number> = {};
	for (const { status } of reads) byStatus[String(status)] = (byStatus[String(status)] ?? 0) + 1;
	const cached = reads.filter((entry) => entry.cached === true).length;
	return {
		requests: requests.filter((entry) => !isSuccessfulRead(entry)),
		readsSummary: { count: reads.length, byStatus, totalDurationMs: reads.reduce((sum, entry) => sum + entry.durationMs, 0), ...(cached > 0 && { cached }) },
	};
}

// The text block and structuredContent carry the same object. An oversized result is shrunk
// structurally (see truncateJson), so both stay valid JSON and carry a `truncated` hint. The
// audit fields are kept whole (unless they alone come close to the limit), so callers see which writes happened.
// `plannedWrites` is shrunk like `result`: `requests` already lists every planned write.
const AUDIT_KEYS = ['ok', 'requestCount', 'requests', 'readsSummary', 'dryRun'];

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
