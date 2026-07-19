export interface TruncationOptions {
	maxChars?: number;
}

const DEFAULT_MAX_CHARS = 24_000;
const RECOVERY_GUIDANCE = 'Recovery: use a more specific search query, return fewer fields, paginate or narrow date ranges, or summarize inside execute before returning.';

export function truncateText(value: string, options: TruncationOptions = {}): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}\n\n...[truncated ${omitted} characters]\n${RECOVERY_GUIDANCE}`;
}

export function stringifyForMcp(value: unknown, options: TruncationOptions = {}): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2);
	} catch (error) {
		text = JSON.stringify({ error: 'Result is not JSON-serializable', detail: String(error) }, null, 2);
	}
	return truncateText(text, options);
}
