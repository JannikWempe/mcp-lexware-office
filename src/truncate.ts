export interface TruncationOptions {
	maxChars?: number;
}

const DEFAULT_MAX_CHARS = 24_000;
const RECOVERY_GUIDANCE = 'Recovery: use a more specific search query, return fewer fields, paginate or narrow date ranges, or summarize inside execute before returning.';
// Values up to this many characters are kept whole; larger ones get at least this budget or become a marker.
const MIN_SHRINK_CHARS = 80;
const INDENT = 2;

export function truncateText(value: string, options: TruncationOptions = {}): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}\n\n...[truncated ${omitted} characters]\n${RECOVERY_GUIDANCE}`;
}

export interface JsonTruncationHint {
	originalChars: number;
	note: string;
}

// Shrinks a JSON value structurally so that JSON.stringify(_, null, 2) fits maxChars and stays
// valid JSON: arrays keep whole leading items plus a "[truncated: N more items]" marker, objects
// shrink their largest values first (down to a "[truncated: N chars]" marker), and long strings
// are clipped. A value that already fits is returned as is. Otherwise the result carries a
// `truncated` hint: as a key of a top-level object, or wrapping any other value as { truncated, value }.
export function truncateJson(value: unknown, options: TruncationOptions = {}): unknown {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const originalChars = sizeOf(value, 0);
	if (originalChars <= maxChars) return value;

	const hint: JsonTruncationHint = {
		originalChars,
		note: `Result exceeded ${maxChars} characters and was shrunk: values marked "[truncated: ...]" were clipped or omitted. ${RECOVERY_GUIDANCE}`,
	};
	const withHint = (shrunk: unknown) => isPlainObject(shrunk) ? { ...shrunk, truncated: hint } : { truncated: hint, value: shrunk };
	const hintChars = sizeOf({ truncated: hint }, 0);
	// The size estimate ignores some separators, so tighten the budget until the result fits.
	for (let budget = maxChars - hintChars; budget >= MIN_SHRINK_CHARS; budget = Math.floor(budget * 0.8)) {
		const result = withHint(shrink(value, budget, 0));
		if (sizeOf(result, 0) <= maxChars) return result;
	}
	return { truncated: hint };
}

function shrink(value: unknown, budget: number, depth: number): unknown {
	const size = sizeOf(value, depth);
	// Small values stay whole; a parent that still doesn't fit drops trailing items or keys.
	if (size <= budget || size <= MIN_SHRINK_CHARS) return value;
	if (budget < MIN_SHRINK_CHARS) return marker(`${size} chars`);
	if (typeof value === 'string') return clipString(value, budget);
	if (Array.isArray(value)) return shrinkArray(value, budget, depth);
	if (isPlainObject(value)) return shrinkObject(value, budget, depth);
	return marker(`${size} chars`);
}

function clipString(value: string, budget: number): string {
	// Clip until the escaped string plus the marker fits; escaping can make it longer than its length.
	let keep = Math.max(0, budget - 40);
	for (;;) {
		const clipped = `${value.slice(0, keep)}…${marker(`${value.length - keep} chars`)}`;
		if (JSON.stringify(clipped).length <= budget || keep === 0) return clipped;
		keep = Math.floor(keep * 0.8);
	}
}

function shrinkArray(value: unknown[], budget: number, depth: number): unknown[] {
	const itemOverhead = (depth + 1) * INDENT + 2; // indentation plus ",\n"
	const markerChars = 40 + itemOverhead;
	const kept: unknown[] = [];
	let used = 4; // "[\n" and "\n]" plus closing indentation slack
	for (const item of value) {
		const itemChars = sizeOf(item, depth + 1) + itemOverhead;
		if (used + itemChars + markerChars > budget) break;
		kept.push(item);
		used += itemChars;
	}
	// A single item too large to keep whole is shrunk rather than dropped.
	if (kept.length === 0 && value.length > 0) {
		kept.push(shrink(value[0], budget - used - markerChars - itemOverhead, depth + 1));
	}
	const omitted = value.length - kept.length;
	return omitted > 0 ? [...kept, marker(`${omitted} more items`)] : kept;
}

function shrinkObject(value: Record<string, unknown>, budget: number, depth: number): Record<string, unknown> {
	const result: Record<string, unknown> = { ...value };
	const entryOverhead = (key: string) => (depth + 1) * INDENT + JSON.stringify(key).length + 4; // indentation, ": " and ",\n"
	const keys = Object.keys(result);
	const sizes = new Map(keys.map((key) => [key, sizeOf(result[key], depth + 1)]));
	// Fair share, smallest values first: small values stay whole and the budget they leave is
	// split evenly among the larger ones, so the largest values are the ones that shrink.
	let remaining = budget - 4 - keys.reduce((sum, key) => sum + entryOverhead(key), 0);
	const bySize = [...keys].sort((a, b) => sizes.get(a)! - sizes.get(b)!);
	bySize.forEach((key, index) => {
		const share = Math.floor(remaining / (bySize.length - index));
		if (sizes.get(key)! > share) result[key] = shrink(result[key], Math.max(share, 0), depth + 1);
		remaining -= sizeOf(result[key], depth + 1);
	});
	if (remaining >= 0) return result;
	// Too many keys to fit even as markers: keep leading keys, then a "[truncated]" entry.
	const kept: Record<string, unknown> = {};
	let used = 4 + 60; // braces plus the "[truncated]" entry
	for (const key of keys) {
		const chars = entryOverhead(key) + sizeOf(result[key], depth + 1);
		if (used + chars > budget) break;
		kept[key] = result[key];
		used += chars;
	}
	kept['[truncated]'] = `${keys.length - Object.keys(kept).length} more keys`;
	return kept;
}

function marker(detail: string): string {
	return `[truncated: ${detail}]`;
}

// Characters JSON.stringify(value, null, 2) takes when nested `depth` levels deep.
function sizeOf(value: unknown, depth: number): number {
	const json = JSON.stringify(value, null, INDENT);
	if (json === undefined) return 0;
	if (depth === 0) return json.length;
	let lines = 0;
	for (let index = json.indexOf('\n'); index !== -1; index = json.indexOf('\n', index + 1)) lines += 1;
	return json.length + lines * depth * INDENT;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
