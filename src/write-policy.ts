import type { LexwareExecuteMethod } from './lexware-client.js';
import { lexwareSpec, type HttpMethod } from './lexware-spec.js';

export const WRITE_METHODS: ReadonlySet<LexwareExecuteMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// One LEXWARE_OFFICE_WRITE_ALLOW entry, resolved against the catalog.
export interface WriteAllowRule {
	operationId: string;
	method: LexwareExecuteMethod;
	pathTemplate: string;
	// Also allows finalize=true on sales documents. Without it, only drafts may be created.
	finalize: boolean;
}

// What the model sees as spec.info.writePolicy. `allow: 'all'` means no allowlist is configured.
export interface WritePolicy {
	enabled: boolean;
	allow: string[] | 'all';
}

type CatalogWrite = Omit<WriteAllowRule, 'finalize'> & { finalizable: boolean };

const FINALIZE_SUFFIX = '?finalize';

const catalogWrites: CatalogWrite[] = Object.entries(lexwareSpec.paths).flatMap(([pathTemplate, methods]) =>
	[...WRITE_METHODS].flatMap((method) => {
		const operation = methods[method.toLowerCase() as HttpMethod];
		if (operation === undefined) return [];
		return [{
			operationId: operation.operationId,
			method,
			pathTemplate,
			finalizable: operation.parameters?.some((parameter) => parameter.name === 'finalize') ?? false,
		}];
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
	if (finalize && !write.finalizable) {
		throw new Error(`LEXWARE_OFFICE_WRITE_ALLOW entry "${entry}": ${describeWrite(write)} has no finalize parameter.`);
	}
	const { finalizable: _, ...rule } = write;
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

// Returns why the allowlist blocks this write, or undefined if a rule allows it. `operationId` is the
// cataloged operation the request matched; uncataloged writes never match a rule.
export function writeAllowViolation(rules: WriteAllowRule[], request: { method: string; path: string; query: URLSearchParams; operationId?: string }): string | undefined {
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
	return undefined;
}
