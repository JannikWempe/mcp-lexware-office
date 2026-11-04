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
	bad_request_error: 'The request is malformed: check the query parameters and the JSON body against the catalog. The contacts email and name filters need at least 3 characters.',
}));

const CONFLICT_HINT = 'Optimistic locking conflict: re-fetch the resource, re-apply your change to the current version, and retry only if the change is still identical.';

// Returns undefined when the body has neither shape and the status has no generic hint.
export function normalizeIssues(status: number, data: unknown): LexwareIssue[] | undefined {
	const issues = issuesFromBody(data);
	if (status === 409) {
		if (issues.length === 0) issues.push({ hint: CONFLICT_HINT });
		for (const issue of issues) issue.hint ??= CONFLICT_HINT;
	}
	return issues.length > 0 ? issues : undefined;
}

function issuesFromBody(data: unknown): LexwareIssue[] {
	if (!isRecord(data)) return [];
	if (Array.isArray(data.IssueList)) {
		return data.IssueList.filter(isRecord).map((entry) => {
			const code = stringOrUndefined(entry.i18nKey);
			const source = stringOrUndefined(entry.source);
			// bad_request_error carries a message such as "size must be between 3 and 255" in source.
			const sourceIsMessage = code?.toLowerCase() === 'bad_request_error';
			return withHint({
				...(source !== undefined && !sourceIsMessage && { field: source }),
				...(code !== undefined && { code }),
				...(source !== undefined && sourceIsMessage && { message: source }),
			});
		});
	}
	if (Array.isArray(data.details)) {
		return data.details.filter(isRecord).map((entry) => {
			const field = stringOrUndefined(entry.field);
			const code = stringOrUndefined(entry.violation);
			const message = stringOrUndefined(entry.message);
			return withHint({
				...(field !== undefined && { field }),
				...(code !== undefined && { code }),
				...(message !== undefined && { message }),
			});
		});
	}
	return [];
}

function withHint(issue: LexwareIssue): LexwareIssue {
	const hint = issue.code !== undefined ? CODE_HINTS.get(issue.code.toLowerCase()) : undefined;
	return hint !== undefined ? { ...issue, hint } : issue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
