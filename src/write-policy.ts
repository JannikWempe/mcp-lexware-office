import type { LexwareExecuteMethod } from './lexware-client.js';
import { lexwareSpec, type HttpMethod, type LexwareOperation } from './lexware-spec.js';

export const WRITE_METHODS: ReadonlySet<LexwareExecuteMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// One LEXWARE_OFFICE_WRITE_ALLOW entry, resolved against the catalog.
export interface WriteAllowRule {
	operationId: string;
	method: LexwareExecuteMethod;
	pathTemplate: string;
	// Also allows finalize=true on sales documents and a finalizing voucherStatus on bookkeeping vouchers.
	// Without it, only drafts and unchecked vouchers may be written.
	finalize: boolean;
}

// What the model sees as spec.info.writePolicy. `allow: 'all'` means no allowlist is configured.
export interface WritePolicy {
	enabled: boolean;
	allow: string[] | 'all';
}

// How a write finalizes: the finalize query parameter (sales documents) or the body's voucherStatus.
type FinalizeMode = 'query' | NonNullable<LexwareOperation['voucherStatusFinalizes']>;

type CatalogWrite = Omit<WriteAllowRule, 'finalize'> & { finalizeMode?: FinalizeMode };

const FINALIZE_SUFFIX = '?finalize';

const catalogWrites: CatalogWrite[] = Object.entries(lexwareSpec.paths).flatMap(([pathTemplate, methods]) =>
	[...WRITE_METHODS].flatMap((method) => {
		const operation = methods[method.toLowerCase() as HttpMethod];
		if (operation === undefined) return [];
		const finalizeMode = operation.voucherStatusFinalizes
			?? (operation.parameters?.some((parameter) => parameter.name === 'finalize') ? 'query' : undefined);
		return [{ operationId: operation.operationId, method, pathTemplate, ...(finalizeMode !== undefined && { finalizeMode }) }];
	}));

// Path parameter names differ across the catalog ({id}, {voucherId}, {subscriptionId}), so compare templates without them.
const withoutParamNames = (template: string) => template.replace(/\{[^/}]*\}/g, '{}');

// Parses a comma- or newline-separated list of `METHOD /v1/template` or `operationId` entries, each
// optionally suffixed with `?finalize`. Throws on entries that don't name a cataloged write.
export function parseWriteAllow(raw: string): WriteAllowRule[] {
	const entries = raw.split(/[,\n]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	if (entries.length === 0) {
		throw new Error('LEXWARE_OFFICE_WRITE_ALLOW is set but empty. Unset it to allow all writes, or list the allowed writes, e.g. "POST /v1/files, PUT /v1/vouchers/{id}".');
	}
	return entries.map(parseEntry);
}

function parseEntry(entry: string): WriteAllowRule {
	const finalize = entry.endsWith(FINALIZE_SUFFIX);
	const target = finalize ? entry.slice(0, -FINALIZE_SUFFIX.length).trim() : entry;
	const write = findCatalogWrite(target);
	if (write === undefined) {
		throw new Error(`LEXWARE_OFFICE_WRITE_ALLOW entry "${entry}" does not match a cataloged write. Use "METHOD /v1/path/{id}" or an operationId. Known writes: ${catalogWrites.map(describeWrite).join(', ')}.`);
	}
	if (finalize && write.finalizeMode === undefined) {
		throw new Error(`LEXWARE_OFFICE_WRITE_ALLOW entry "${entry}": ${describeWrite(write)} cannot finalize.`);
	}
	const { finalizeMode: _, ...rule } = write;
	return { ...rule, finalize };
}

function findCatalogWrite(target: string): CatalogWrite | undefined {
	const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(target);
	if (match === null) return catalogWrites.find((write) => write.operationId === target);
	const [, method, path] = match;
	return catalogWrites.find((write) => write.method === method.toUpperCase() && withoutParamNames(write.pathTemplate) === withoutParamNames(path));
}

const describeWrite = (write: { method: string; pathTemplate: string }) => `${write.method} ${write.pathTemplate}`;

const describeRule = (rule: WriteAllowRule) => `${describeWrite(rule)}${rule.finalize ? FINALIZE_SUFFIX : ''}`;

export const describeWritePolicy = (enabled: boolean, rules: WriteAllowRule[] | undefined): WritePolicy => ({
	enabled,
	allow: rules !== undefined ? rules.map(describeRule) : 'all',
});

// Lexware reads finalize as a boolean; treat anything but an explicit false as finalizing. Key
// spellings a server might also bind (FINALIZE, finalize[]) count too.
export const requestsFinalize = (query: URLSearchParams) => [...query].some(([key, value]) =>
	key.toLowerCase().replace(/\[\]$/, '') === 'finalize' && value.trim().toLowerCase() !== 'false');

// The parts of a write the allowlist checks. Prompts pass a representative one.
export interface WriteRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	// The cataloged operation the request matched; uncataloged writes never match a rule.
	operationId?: string;
	body?: unknown;
	bodyBase64?: string;
	multipart?: unknown[];
}

// The body as a JSON object, parsing string bodies and reading no body as {}; undefined when it is
// binary, multipart or not an object.
function jsonObjectBody(request: WriteRequest): Record<string, unknown> | undefined {
	if (request.bodyBase64 !== undefined || request.multipart !== undefined) return undefined;
	let body = request.body === undefined ? {} : request.body;
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			return undefined;
		}
	}
	return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

// Describes what in the body finalizes the voucher, or undefined if nothing does. Fails closed: a body
// it cannot read finalizes, and so does any voucherStatus key spelling (VoucherStatus) a server might bind
// whose value is not 'unchecked', null included (on POST, a null voucherStatus means open).
function voucherStatusFinalizing(mode: 'whenSet' | 'unlessUnchecked', request: WriteRequest): string | undefined {
	const body = jsonObjectBody(request);
	if (body === undefined) return 'a body that is not a JSON object';
	const statuses = Object.entries(body).filter(([key, value]) => key.toLowerCase() === 'voucherstatus' && value !== undefined);
	const finalizing = statuses.find(([, value]) => typeof value !== 'string' || value.trim().toLowerCase() !== 'unchecked');
	if (finalizing !== undefined) return `${finalizing[0]} ${JSON.stringify(finalizing[1])}`;
	return mode === 'unlessUnchecked' && body.voucherStatus === undefined ? 'no voucherStatus' : undefined;
}

const finalizeModes = new Map(catalogWrites.map((write) => [write.operationId, write.finalizeMode]));

// Returns why the allowlist blocks this write, or undefined if a rule allows it.
export function writeAllowViolation(rules: WriteAllowRule[], request: WriteRequest): string | undefined {
	const allowed = `Allowed: ${rules.map(describeRule).join(', ')}. See spec.info.writePolicy.`;
	// A path parameter with an encoded separator or a ';' matrix parameter (e.g. /v1/vouchers/..;/files) matches a
	// template here but might route elsewhere upstream: Tomcat/Spring-style servers strip ';...' before resolving '..'.
	if (/%(2f|5c|3b)|;/i.test(request.path)) {
		return `${request.method} ${request.path} is blocked: LEXWARE_OFFICE_WRITE_ALLOW rejects encoded '/' or '\\' and ';' in write paths. ${allowed}`;
	}
	const matching = rules.filter((rule) => rule.operationId === request.operationId);
	if (matching.length === 0) {
		return `${request.method} ${request.path} is blocked: not in LEXWARE_OFFICE_WRITE_ALLOW. ${allowed}`;
	}
	if (requestsFinalize(request.query) && !matching.some((rule) => rule.finalize)) {
		return `${request.method} ${request.path} with finalize=true is blocked: LEXWARE_OFFICE_WRITE_ALLOW only allows drafts here; create a draft instead, or ask the server operator to add "${describeWrite(matching[0])}${FINALIZE_SUFFIX}". ${allowed}`;
	}
	const mode = finalizeModes.get(matching[0].operationId);
	if (mode !== undefined && mode !== 'query' && !matching.some((rule) => rule.finalize)) {
		const finalizing = voucherStatusFinalizing(mode, request);
		if (finalizing !== undefined) {
			const instead = mode === 'whenSet' ? 'omit voucherStatus to edit without finalizing' : "send voucherStatus 'unchecked' to create an unchecked voucher";
			return `${request.method} ${request.path} with ${finalizing} is blocked: it would finalize the voucher (voucherStatus open), and LEXWARE_OFFICE_WRITE_ALLOW only allows unchecked vouchers here; ${instead}, or ask the server operator to add "${describeWrite(matching[0])}${FINALIZE_SUFFIX}". ${allowed}`;
		}
	}
	return undefined;
}
