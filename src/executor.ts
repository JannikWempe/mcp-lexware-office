import {
	newQuickJSWASMModule,
	newVariant,
	RELEASE_SYNC,
	shouldInterruptAfterDeadline,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
} from 'quickjs-emscripten';

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
	maxLogEntries?: number;
	maxLogChars?: number;
	filename?: string;
	// Installed as globals; guest calls return promises settled by the host.
	hostFunctions?: Record<string, SandboxHostFunction>;
	// Guest script evaluated before the user function (strict, no top-level await); its top-level
	// const/let/class declarations are visible to user code but not added to globalThis.
	prelude?: string;
	// External cancellation (e.g. the MCP request signal). Aborting ends execution with a cancelled error.
	signal?: AbortSignal;
}

export interface CodeExecutionResult {
	result?: unknown;
	// Set, and non-empty, whenever execution failed.
	error?: string;
	logs?: string[];
}

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
// This QuickJS build has no malloc_usable_size, so runtime.setMemoryLimit counts a fixed overhead per
// allocation, not its size: typed arrays and long strings barely count. The hard cap is therefore the
// WASM heap itself. The build requires 16 MB of initial memory (static data, stack, heap) and allows
// at most 2 GB; the heap may grow by memoryLimitBytes beyond the initial 16 MB.
const WASM_PAGE_BYTES = 64 * 1024;
const WASM_INITIAL_BYTES = 16 * 1024 * 1024;
const WASM_MAX_PAGES = 32 * 1024;
// QuickJS checks this limit against the WASM shadow stack, but its native recursion also uses the
// host (V8) stack, which overflows first above roughly 512 KB. Stay below that, so runaway guest
// recursion is a catchable QuickJS InternalError instead of a host stack overflow. Not configurable
// for that reason; deeper native recursion (vm.dump of deep values) is handled by markEngineFailed.
const MAX_STACK_SIZE_BYTES = 256 * 1024;
const DEFAULT_MAX_LOG_ENTRIES = 25;
const DEFAULT_MAX_LOG_CHARS = 8_000;
const PRELUDE_FILENAME = 'prelude.js';
const CANCELLED_MESSAGE = 'Execution cancelled by client';
// A host result copied into a full WASM heap fails as an out-of-bounds write rather than a QuickJS out of memory.
const HOST_OUT_OF_MEMORY_MESSAGE =
	'Sandbox out of memory: a value passed into the sandbox (e.g. a large API response) did not fit into its memory limit. Request less data per call, e.g. smaller pages.';
const HOST_STACK_OVERFLOW_MESSAGE =
	'Sandbox stack overflow: a value is nested too deeply or recursion went too deep. Flatten deeply nested data before returning, logging or serializing it.';

/**
 * Generic QuickJS sandbox runner: model-supplied JS plus JSON capabilities, host functions and an
 * optional guest prelude. Keep it Lexware-agnostic; Lexware specifics go in lexware-sandbox-sdk.ts
 * and code-mode.ts.
 */
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
		const capabilitiesJson = JSON.stringify(capabilities);

		if (options.signal?.aborted) return { error: `Error: ${CANCELLED_MESSAGE}`, logs: [] };

		const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
		if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes < 0) throw new Error(`Invalid memoryLimitBytes: ${memoryLimitBytes}`);
		// A fresh WASM module per execution (a few ms) isolates failures: when an engine call breaks
		// (see `markEngineFailed` below), this run's module is dropped without touching runs on other modules.
		// Its own bounded memory makes runaway allocations a catchable "out of memory" (see WASM_INITIAL_BYTES).
		const wasmMemory = new WebAssembly.Memory({
			initial: WASM_INITIAL_BYTES / WASM_PAGE_BYTES,
			maximum: Math.min(WASM_MAX_PAGES, Math.ceil((WASM_INITIAL_BYTES + memoryLimitBytes) / WASM_PAGE_BYTES)),
		});
		const QuickJS = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory }));
		// Recheck: the signal may have aborted while QuickJS was loading. Everything below runs
		// synchronously up to evalCode, so no later abort can slip in before guest code starts.
		if (options.signal?.aborted) return { error: `Error: ${CANCELLED_MESSAGE}`, logs: [] };
		const runtime = QuickJS.newRuntime();
		const vm = runtime.newContext();
		const logs: string[] = [];

		// Set when a QuickJS call throws a host-level error, typically a V8 RangeError from deep native
		// recursion (vm.dump or JSON.stringify of a deeply nested value) outgrowing the host stack
		// before QuickJS's own stack check fires. The error unwinds WASM frames mid-operation and
		// leaves the runtime inconsistent: disposing it would abort the whole process with
		// `Assertion failed: list_empty(&rt->gc_obj_list)`. A broken runtime is therefore never
		// touched again; it is garbage-collected along with this execution's module.
		let engineFailure: string | undefined;
		let rejectEngineFailed!: (error: Error) => void;
		const engineFailedPromise = new Promise<never>((_resolve, reject) => { rejectEngineFailed = reject; });
		engineFailedPromise.catch(() => { /* raced below; may fire after execution has ended */ });
		const markEngineFailed = (error: unknown) => {
			if (engineFailure !== undefined) return;
			engineFailure = isHostStackOverflow(error)
				? HOST_STACK_OVERFLOW_MESSAGE
				: isWasmOutOfBounds(error) ? HOST_OUT_OF_MEMORY_MESSAGE : `Sandbox engine failure: ${stringifyHostError(error)}`;
			rejectEngineFailed(new Error(engineFailure));
		};
		const engineFailureResult = (): CodeExecutionResult => ({ error: `Error: ${engineFailure}`, logs });

		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
		const maxLogChars = options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
		const filename = options.filename ?? 'sandbox.js';

		runtime.setMemoryLimit(memoryLimitBytes);
		runtime.setMaxStackSize(MAX_STACK_SIZE_BYTES);
		// One deadline for both the interrupt handler and the wall-clock timer below, so synchronous guest
		// work before the first await counts against timeoutMs too.
		const deadline = Date.now() + timeoutMs;
		const deadlinePassed = shouldInterruptAfterDeadline(deadline);
		// Also stop guest code once execution has ended (e.g. continuations spinning during teardown
		// after a cancellation) or the runtime has failed.
		runtime.setInterruptHandler((rt) =>
			hostCallController.signal.aborted || engineFailure !== undefined || deadlinePassed(rt));

		// Track every QuickJS deferred promise created by host functions.
		// We must settle (reject) all unsettled deferreds before disposing the VM/runtime;
		// otherwise the resolveHandle/rejectHandle remain live in QuickJS's GC list and
		// JS_FreeRuntime aborts the process with an assertion failure.
		const unsettledDeferreds = new Set<QuickJSDeferredPromise>();

		// Signals whether the VM has been torn down; host callbacks must not touch
		// VM handles after this is set to true.
		let vmDisposed = false;

		// The native-side promise that mirrors the user function's QuickJS promise.
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

					// Guest code can still call host functions while teardown drains its continuations,
					// or until the interrupt handler stops it after an engine failure; reject those
					// immediately instead of starting new work.
					if (hostCallController.signal.aborted || engineFailure !== undefined) {
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
								if (!vmDisposed && engineFailure === undefined) {
									unsettledDeferreds.delete(deferred);
									try {
										const resultHandle = vm.newString(result);
										deferred.resolve(resultHandle);
										resultHandle.dispose();
										runtime.executePendingJobs();
									} catch (error) {
										markEngineFailed(error);
									}
								}
							},
							(error) => {
								if (!vmDisposed && engineFailure === undefined) {
									unsettledDeferreds.delete(deferred);
									try {
										const errorHandle = vm.newError({ name: 'Error', message: stringifyHostError(error) });
										deferred.reject(errorHandle);
										errorHandle.dispose();
										runtime.executePendingJobs();
									} catch (engineError) {
										markEngineFailed(engineError);
									}
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
				if (logs.length >= maxLogEntries || engineFailure !== undefined) return;
				let message: string;
				try {
					message = args.map((arg) => stringifyLogValue(vm.dump(arg))).join(' ');
				} catch (error) {
					// Not rethrown into the guest, which must not handle it: the interrupt handler stops it.
					markEngineFailed(error);
					return;
				}
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

			vm.newString(capabilitiesJson).consume((capabilitiesHandle) => {
				vm.setProp(vm.global, '__capabilitiesJson', capabilitiesHandle);
			});

			// Capabilities and prelude run as their own global script, so the user function below compiles
			// in a file of its own and error positions are relative to the submitted code. Their top-level
			// const/let declarations become global lexical bindings: visible to the user script, not on globalThis.
			const preludeCode = `const { ${capabilityNames.join(', ')} } = JSON.parse(globalThis.__capabilitiesJson);\n${options.prelude ?? ''}`;
			const preludeEvaluation = vm.evalCode(preludeCode, PRELUDE_FILENAME, { type: 'global', strict: true });
			if (engineFailure !== undefined) return engineFailureResult();
			if (preludeEvaluation.error) return { error: stringifyQuickJsError(dumpAndDispose(vm, preludeEvaluation.error)), logs };
			preludeEvaluation.value.dispose();

			// The script's completion value is the function. `0, ` keeps the code an expression (also
			// `async function () {}`) without adding a line, so only columns on line 1 shift (by 3). A trailing
			// semicolon or comment (async () => 1; // main) still parses; a statement after the function
			// becomes the completion value and is rejected below.
			const userEvaluation = vm.evalCode(`0, ${code}`, filename, { type: 'global', strict: true });
			if (engineFailure !== undefined) return engineFailureResult();
			if (userEvaluation.error) return { error: stringifyQuickJsError(dumpAndDispose(vm, userEvaluation.error)), logs };
			const userFunction = userEvaluation.value;
			if (vm.typeof(userFunction) !== 'function') {
				userFunction.dispose();
				return { error: 'Error: Code must evaluate to a function, for example: async () => ({ ok: true })', logs };
			}
			const evaluation = vm.callFunction(userFunction, vm.undefined);
			// Disposed only on success: the call may have broken the runtime (see `markEngineFailed`).
			if (engineFailure !== undefined) return engineFailureResult();
			userFunction.dispose();
			if (evaluation.error) return { error: stringifyQuickJsError(dumpAndDispose(vm, evaluation.error)), logs };

			// Promise.resolve also settles a plain (non-async) function's return value.
			const promiseHandle = evaluation.value;
			const nativePromise = vm.resolvePromise(promiseHandle);
			sandboxNativePromise = nativePromise;
			const pendingJobsResult = runtime.executePendingJobs();
			if (engineFailure !== undefined) return engineFailureResult();
			if (pendingJobsResult.error) {
				const error = stringifyQuickJsError(dumpAndDispose(vm, pendingJobsResult.error));
				promiseHandle.dispose();
				return { error, logs };
			}

			let resolved;
			try {
				resolved = await withTimeoutAndCancel(Promise.race([nativePromise, engineFailedPromise]), deadline, timeoutMs, options.signal);
				sandboxNativePromise = undefined;
			} catch (error) {
				return { error: String(error), logs };
			} finally {
				if (engineFailure === undefined) promiseHandle.dispose();
			}

			if (resolved.error) {
				const error = stringifyQuickJsError(dumpAndDispose(vm, resolved.error));
				return { error, logs };
			}

			return { result: dumpAndDispose(vm, resolved.value), logs };
		} catch (error) {
			// Everything in this block drives QuickJS, so an unexpected throw leaves the runtime in an
			// unknown state; treat it as broken rather than risk aborting the process on dispose.
			markEngineFailed(error);
			return engineFailureResult();
		} finally {
			// Signal host callbacks not to touch the VM anymore.
			vmDisposed = true;
			hostCallController.abort();

			// Reject every unsettled QuickJS deferred. Without this, the resolveHandle /
			// rejectHandle inside each deferred remain live in QuickJS's GC list and
			// JS_FreeRuntime asserts list_empty(&rt->gc_obj_list), crashing the process.
			if (unsettledDeferreds.size > 0 && engineFailure === undefined) {
				try {
					const shutdownError = vm.newError('Sandbox VM is shutting down');
					for (const deferred of unsettledDeferreds) {
						try { deferred.reject(shutdownError); } catch { /* already settled */ }
					}
					shutdownError.dispose();
					runtime.executePendingJobs();
				} catch (error) {
					markEngineFailed(error);
				}
			}
			unsettledDeferreds.clear();

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
			if (sandboxNativePromise !== undefined && engineFailure === undefined) {
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

			// A failed runtime is left for the garbage collector together with its module (see `markEngineFailed`).
			if (engineFailure === undefined) {
				try {
					vm.dispose();
					runtime.dispose();
				} catch {
					// QuickJS can leak objects when it runs out of memory in a continuation, and JS_FreeRuntime
					// then aborts this module. The result is already settled; the module is dropped like a failed one.
				}
			}
		}
	}
}

// Rejects at the absolute `deadline`; timeoutMs only appears in the message.
function withTimeoutAndCancel<T>(promise: Promise<T>, deadline: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
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
		}, Math.max(0, deadline - Date.now()));
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

// vm.dump already disposes promise handles (e.g. a guest that throws a promise).
function dumpAndDispose(vm: QuickJSContext, handle: QuickJSHandle): unknown {
	const value = vm.dump(handle);
	if (handle.alive) handle.dispose();
	return value;
}

function isWasmOutOfBounds(error: unknown): boolean {
	return error instanceof WebAssembly.RuntimeError && /memory access out of bounds/i.test(error.message);
}

function isHostStackOverflow(error: unknown): boolean {
	return error instanceof RangeError && /call stack/i.test(error.message);
}

function stringifyLogValue(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		// JSON.stringify returns undefined for undefined, functions and symbols.
		return JSON.stringify(value) ?? String(value);
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
	// Never empty: callers treat a missing or empty error as success.
	if (value === undefined) return 'Error: the script threw undefined (or rejected without a reason) instead of an Error';
	if (value === '') return 'Error: the script threw an empty string instead of an Error';
	return stringifyLogValue(value);
}
