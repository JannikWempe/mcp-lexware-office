import type { LexwareExecuteMethod } from './lexware-client.js';

// Normalizes Lexware's two error body shapes into one `issues` list with actionable hints, so
// model code doesn't have to know both shapes or guess what a terse error code means.
// Shapes (https://developers.lexware.io/docs/#error-codes):
// - legacy (contacts, files, vouchers): { IssueList: [{ i18nKey, source, type, additionalData, args }] }
// - regular (all other endpoints): { status, error, message, traceId, details: [{ violation, field, message }] }

export interface LexwareIssue {
	field?: string;
	code?: string;
	message?: string;
	hint?: string;
}

// Keyed by lower-cased i18nKey / violation. Extend as new codes show up in practice.
const CODE_HINTS = new Map<string, string>(Object.entries({
	missing_contactid: 'Set contactId to an existing contact, or set useCollectiveContact: true (and omit contactId).',
	invalid_taxamount: 'Per item, taxAmount must match amount and taxRatePercent. For taxType gross: taxAmount = round(amount × rate / (100 + rate), 2). Split items if the document\'s rounding differs. totalTaxAmount must equal the sum of item taxAmounts.',
	missing_entity: 'The field must not be null or empty: set a value for it.',
	notnull: 'The field is mandatory: set a non-null value for it.',
	bad_request_error: 'The request is malformed: check the query parameters and the JSON body against the catalog (e.g. the contacts email and name filters need at least 3 characters).',
}));

const CONFLICT_HINT = 'Optimistic locking conflict: re-fetch the resource, re-apply your change to the current version, and retry only if the change is still identical.';

// Returns undefined when the body has neither shape and no generic hint applies. Only PUTs get
// the locking hint: other 409s mean something else (e.g. a draft has no file, a duplicate webhook).
export function normalizeIssues(status: number, method: LexwareExecuteMethod, data: unknown): LexwareIssue[] | undefined {
	const issues = issuesFromBody(data);
	if (status === 409 && method === 'PUT') {
		if (issues.length === 0) issues.push({ hint: CONFLICT_HINT });
		for (const issue of issues) issue.hint ??= CONFLICT_HINT;
	}
	return issues.length > 0 ? issues : undefined;
}

function issuesFromBody(data: unknown): LexwareIssue[] {
	if (!isRecord(data)) return [];
	if (Array.isArray(data.IssueList)) {
		return data.IssueList.filter(isRecord).map((entry) => {
			const source = stringOrUndefined(entry.source);
			// Only validation failures name a field in source; bad_request_error and technical_error
			// put a message there, e.g. "size must be between 3 and 255".
			const sourceIsField = entry.type === undefined || entry.type === null || entry.type === 'validation_failure';
			return toIssue(sourceIsField ? source : undefined, stringOrUndefined(entry.i18nKey), sourceIsField ? undefined : source);
		});
	}
	if (Array.isArray(data.details)) {
		return data.details.filter(isRecord).map((entry) => toIssue(stringOrUndefined(entry.field), stringOrUndefined(entry.violation), stringOrUndefined(entry.message)));
	}
	return [];
}

function toIssue(field: string | undefined, code: string | undefined, message: string | undefined): LexwareIssue {
	const hint = code !== undefined ? CODE_HINTS.get(code.toLowerCase()) : undefined;
	return {
		...(field !== undefined && { field }),
		...(code !== undefined && { code }),
		...(message !== undefined && { message }),
		...(hint !== undefined && { hint }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Empty strings carry no information for an issue, so they are dropped like missing values.
function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
