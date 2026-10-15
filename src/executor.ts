import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSDeferredPromise } from 'quickjs-emscripten';

export interface CodeExecutor {
	// Each capability is JSON-copied into the sandbox and bound to a local const of the same name.
	execute(
		code: string,
		capabilities: Record<string, unknown>,
		options?: CodeExecutorOptions,
	): Promise<CodeExecutionResult>;
}

export interface SandboxHostCallContext {
	// Aborted when the execution times out, is cancelled via CodeExecutorOptions.signal, or finishes.
	signal: AbortSignal;
}

export type SandboxHostFunction = (payload: string, context: SandboxHostCallContext) => Promise<string>;

export interface CodeExecutorOptions {
	timeoutMs?: number;
	memoryLimitBytes?: number;
	maxStackSizeBytes?: number;
	maxLogEntries?: number;
	maxLogChars?: number;
	filename?: string;
	// Installed as globals; guest calls return promises settled by the host.
	hostFunctions?: Record<string, SandboxHostFunction>;
	// Guest source evaluated inside the wrapper scope before the user function; its top-level
	// declarations are visible to user code but not added to globalThis.
	prelude?: string;
	// External cancellation (e.g. the MCP request signal). Aborting ends execution with a cancelled error.
	signal?: AbortSignal;
}

export interface CodeExecutionResult {
	result?: unknown;
	error?: string;
	logs?: string[];
}

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LOG_ENTRIES = 25;
const DEFAULT_MAX_LOG_CHARS = 8_000;
const CANCELLED_MESSAGE = 'Execution cancelled by client';

export class QuickJsExecutor implements CodeExecutor {
	async execute(
		code: string,
		capabilities: Record<string, unknown>,
		options: CodeExecutorOptions = {},
	): Promise<CodeExecutionResult> {
		const capabilityNames = Object.keys(capabilities);
		for (const name of capabilityNames) {
			if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Invalid capability name: ${name}`);
		}

		if (options.signal?.aborted) return { error: `Error: ${CANCELLED_MESSAGE}`, logs: [] };

		const QuickJS = await getQuickJS();
		// Recheck: the signal may have aborted while QuickJS was loading. Everything below runs
		// synchronously up to evalCode, so no later abort can slip in before guest code starts.
		if (options.signal?.aborted) return { error: `Error: ${CANCELLED_MESSAGE}`, logs: [] };
		const runtime = QuickJS.newRuntime();
		const vm = runtime.newContext();
		const logs: string[] = [];

		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
		const maxStackSizeBytes = options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES;
		const maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
		const maxLogChars = options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
		const filename = options.filename ?? 'sandbox.js';

		runtime.setMemoryLimit(memoryLimitBytes);
		runtime.setMaxStackSize(maxStackSizeBytes);
		runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));

		// Track every QuickJS deferred promise created by host functions.
		// We must settle (reject) all unsettled deferreds before disposing the VM/runtime;
		// otherwise the resolveHandle/rejectHandle remain live in QuickJS's GC list and
		// JS_FreeRuntime aborts the process with an assertion failure.
		const unsettledDeferreds = new Set<QuickJSDeferredPromise>();

		// Signals whether the VM has been torn down; host callbacks must not touch
		// VM handles after this is set to true.
		let vmDisposed = false;

		// The native-side promise that mirrors the top-level QuickJS async IIFE.
		// We track it here so the finally block can await its settlement after
		// forcing all pending deferreds to settle, which allows QuickJS to drain
		// its own continuation queue before we dispose.
		let sandboxNativePromise: Promise<unknown> | undefined;

		// In-flight host call Node.js promises. We wait for them in finally so
		// we don't dispose the VM while a callback is mid-flight.
		const pendingHostCalls = new Set<Promise<void>>();

		// Aborted in finally, i.e. as soon as execution ends for any reason (result, error,
		// timeout, external cancellation), so in-flight host calls stop their network requests.
		const hostCallController = new AbortController();

		try {
			for (const [name, handler] of Object.entries(options.hostFunctions ?? {})) {
				vm.newFunction(name, (payloadHandle) => {
					const payload = vm.getString(payloadHandle);
					const deferred = vm.newPromise();

					// Guest code can still call host functions while teardown drains its
					// continuations; reject those immediately instead of starting new work.
					if (hostCallController.signal.aborted) {
						const errorHandle = vm.newError({ name: 'Error', message: 'Sandbox execution has ended' });
						deferred.reject(errorHandle);
						errorHandle.dispose();
						return deferred.handle;
					}
					unsettledDeferreds.add(deferred);

					let resolveTracked!: () => void;
					const tracked = new Promise<void>((res) => { resolveTracked = res; });
					pendingHostCalls.add(tracked);

					handler(payload, { signal: hostCallController.signal })
						.then(
							(result) => {
								if (!vmDisposed) {
									unsettledDeferreds.delete(deferred);
									const resultHandle = vm.newString(result);
									deferred.resolve(resultHandle);
									resultHandle.dispose();
									runtime.executePendingJobs();
								}
							},
							(error) => {
								if (!vmDisposed) {
									unsettledDeferreds.delete(deferred);
									const errorHandle = vm.newError({ name: 'Error', message: stringifyHostError(error) });
									deferred.reject(errorHandle);
									errorHandle.dispose();
									runtime.executePendingJobs();
								}
							},
						)
						.finally(() => {
							pendingHostCalls.delete(tracked);
							resolveTracked();
						});

					// Return the handle; quickjs-emscripten takes ownership and disposes it.
					return deferred.handle;
				}).consume((hostFunctionHandle) => {
					vm.setProp(vm.global, name, hostFunctionHandle);
				});
			}

			vm.newFunction('log', (...args) => {
				if (logs.length >= maxLogEntries) return;
				const message = args.map((arg) => stringifyLogValue(vm.dump(arg))).join(' ');
				logs.push(message.length > maxLogChars ? `${message.slice(0, maxLogChars)}...[truncated]` : message);
			}).consume((logHandle) => {
				const consoleHandle = vm.newObject();
				vm.setProp(consoleHandle, 'log', logHandle);
				vm.setProp(consoleHandle, 'info', logHandle);
				vm.setProp(consoleHandle, 'warn', logHandle);
				vm.setProp(consoleHandle, 'error', logHandle);
				vm.setProp(vm.global, 'console', consoleHandle);
				consoleHandle.dispose();
			});

			const capabilitiesJson = JSON.stringify(capabilities);
			vm.newString(capabilitiesJson).consume((capabilitiesHandle) => {
				vm.setProp(vm.global, '__capabilitiesJson', capabilitiesHandle);
			});

			const wrappedCode = `
"use strict";
(async () => {
  const __capabilities = JSON.parse(globalThis.__capabilitiesJson);
  const { ${capabilityNames.join(', ')} } = __capabilities;
${options.prelude ?? ''}
  const __userFunction = (${code});
  if (typeof __userFunction !== "function") {
    throw new Error("Code must evaluate to a function, for example: async () => ({ ok: true })");
  }
  return await __userFunction();
})()
`;

			const evaluation = vm.evalCode(wrappedCode, filename, { type: 'global' });
			if (evaluation.error) {
				const error = stringifyQuickJsError(vm.dump(evaluation.error));
				evaluation.error.dispose();
				return { error, logs };
			}

			const promiseHandle = evaluation.value;
			let resolved;
			try {
				const nativePromise = vm.resolvePromise(promiseHandle);
				sandboxNativePromise = nativePromise;
				const pendingJobsResult = runtime.executePendingJobs();
				if (pendingJobsResult.error) {
					const error = stringifyQuickJsError(vm.dump(pendingJobsResult.error));
					pendingJobsResult.error.dispose();
					promiseHandle.dispose();
					return { error, logs };
				}
				resolved = await withTimeoutAndCancel(nativePromise, timeoutMs, options.signal);
				sandboxNativePromise = undefined;
				promiseHandle.dispose();
			} catch (error) {
				promiseHandle.dispose();
				return { error: String(error), logs };
			}

			if (resolved.error) {
				const error = stringifyQuickJsError(vm.dump(resolved.error));
				resolved.error.dispose();
				return { error, logs };
			}

			const result = vm.dump(resolved.value);
			resolved.value.dispose();
			return { result, logs };
		} finally {
			// Signal host callbacks not to touch the VM anymore.
			vmDisposed = true;
			hostCallController.abort();

			// Reject every unsettled QuickJS deferred. Without this, the resolveHandle /
			// rejectHandle inside each deferred remain live in QuickJS's GC list and
			// JS_FreeRuntime asserts list_empty(&rt->gc_obj_list), crashing the process.
			if (unsettledDeferreds.size > 0) {
				const shutdownError = vm.newError('Sandbox VM is shutting down');
				for (const deferred of unsettledDeferreds) {
					try { deferred.reject(shutdownError); } catch { /* already settled */ }
				}
				shutdownError.dispose();
				unsettledDeferreds.clear();
				runtime.executePendingJobs();
			}

			// If the sandbox native promise is still pending (i.e. we timed out while
			// the sandbox was awaiting a host call, or the guest has a never-settling
			// promise), drain it now that we've settled the deferreds.  This lets
			// QuickJS process its continuation callbacks before we free the runtime,
			// avoiding gc_obj_list assertion failures.
			//
			// IMPORTANT: use a hard cap so that a never-settling guest promise (e.g.
			//   async () => await new Promise(() => {})
			// does not block teardown indefinitely.  The cap is generous enough for
			// the continuation microtasks to flush but short enough to be invisible
			// to callers.
			if (sandboxNativePromise !== undefined) {
				const TEARDOWN_CAP_MS = 500;
				const teardownTimeout = new Promise<'timeout'>((resolve) =>
					setTimeout(() => resolve('timeout'), TEARDOWN_CAP_MS),
				);
				const results = await Promise.allSettled([
					Promise.race([sandboxNativePromise, teardownTimeout]),
				]);
				// Dispose any QuickJS handles returned by the resolved native promise.
				for (const r of results) {
					if (r.status === 'fulfilled' && r.value !== 'timeout') {
						const val = r.value as { error?: { dispose(): void }; value?: { dispose(): void } } | undefined;
						try { val?.error?.dispose(); } catch { /* ignore */ }
						try { val?.value?.dispose(); } catch { /* ignore */ }
					}
				}
				sandboxNativePromise = undefined;
			}

			// Wait for any in-flight Node.js host call promises to finish (they will not
			// touch the VM because vmDisposed is true, but we still need the microtask
			// queue to drain before we free the runtime).
			if (pendingHostCalls.size > 0) {
				await Promise.allSettled(pendingHostCalls);
			}

			vm.dispose();
			runtime.dispose();
		}
	}
}

function withTimeoutAndCancel<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error(CANCELLED_MESSAGE));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Execution timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		signal?.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function stringifyLogValue(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function stringifyHostError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return stringifyLogValue(error);
}

function stringifyQuickJsError(value: unknown): string {
	if (value && typeof value === 'object') {
		const maybeError = value as { name?: unknown; message?: unknown; stack?: unknown };
		const name = typeof maybeError.name === 'string' ? maybeError.name : 'Error';
		const message = typeof maybeError.message === 'string' ? maybeError.message : stringifyLogValue(value);
		const stack = typeof maybeError.stack === 'string' ? `\n${maybeError.stack}` : '';
		return `${name}: ${message}${stack}`;
	}
	return stringifyLogValue(value);
}
