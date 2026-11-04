export interface TruncationOptions {
	maxChars?: number;
}

export interface JsonTruncationOptions extends TruncationOptions {
	// Top-level keys that are never shrunk, as long as they fit on their own.
	keep?: string[];
}

const DEFAULT_MAX_CHARS = 24_000;
const RECOVERY_GUIDANCE = 'Recovery: use a more specific search query, return fewer fields, paginate or narrow date ranges, or summarize inside execute before returning.';
const INDENT = 2;
// Values up to this many characters stay whole; larger ones get at least this budget or become a marker.
const MIN_SHRINK_CHARS = 80;
// Values nested deeper than this become a marker when they don't fit, so recursion stays bounded.
const MAX_SHRINK_DEPTH = 64;
// Room reserved for a "[truncated: ...]" marker element or entry.
const MARKER_RESERVE_CHARS = 40;
const MAX_NAMED_DROPPED_KEYS = 10;
// The size estimates ignore a few separators, so each retry tightens the budget by this factor.
const BUDGET_TIGHTENING = 0.8;

export function truncateText(value: string, options: TruncationOptions = {}): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}\n\n...[truncated ${omitted} characters]\n${RECOVERY_GUIDANCE}`;
}

// Shrinks a JSON value structurally so that JSON.stringify(_, null, 2) fits maxChars and stays
// valid JSON: arrays keep whole leading items plus a "[truncated: N more items]" element, objects
// shrink their largest values first and drop trailing keys only if needed, and long strings are
// clipped. A value that already fits is returned as is. Otherwise the result carries a `truncated`
// hint: as a key of a top-level object, or wrapping any other value as { truncated, value }.
export function truncateJson(value: unknown, options: JsonTruncationOptions = {}): unknown {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const originalChars = JSON.stringify(value, null, INDENT)?.length ?? 0;
	if (originalChars <= maxChars) return value;
	const sizes = new SizeCache();

	const hint = {
		originalChars,
		note: `Result exceeded ${maxChars} characters and was shrunk: values marked "[truncated: ...]" were clipped or omitted. ${RECOVERY_GUIDANCE}`,
	};
	const hintChars = sizes.of({ truncated: hint }, 0);
	const shrinker = new Shrinker(sizes);
	// First try to shrink only the keys not kept; if the kept keys alone don't fit, shrink everything.
	const keptKeys = isPlainObject(value) ? Object.keys(value).filter((key) => options.keep?.includes(key)) : [];
	const attempts = [(budget: number) => shrinker.shrink(value, budget, 0)];
	if (keptKeys.length > 0) attempts.unshift((budget) => shrinker.shrinkExcept(value as Record<string, unknown>, keptKeys, budget));
	for (const attempt of attempts) {
		for (let budget = maxChars - hintChars; budget >= MIN_SHRINK_CHARS; budget = Math.floor(budget * BUDGET_TIGHTENING)) {
			const shrunk = attempt(budget);
			if (shrunk === undefined) break;
			const result = withHint(shrunk, hint);
			if (sizes.of(result, 0) <= maxChars) return result;
		}
	}
	return { truncated: hint };
}

function withHint(shrunk: unknown, hint: { originalChars: number; note: string }): unknown {
	return isPlainObject(shrunk) ? { ...shrunk, truncated: hint } : { truncated: hint, value: shrunk };
}

class Shrinker {
	constructor(private readonly sizes: SizeCache) {}

	// Shrinks the keys other than keptKeys into what the kept ones leave of the budget, keeping key order.
	shrinkExcept(value: Record<string, unknown>, keptKeys: string[], budget: number): Record<string, unknown> | undefined {
		const kept = Object.fromEntries(keptKeys.map((key) => [key, value[key]]));
		const restBudget = budget - this.sizes.of(kept, 0);
		if (restBudget < MIN_SHRINK_CHARS) return undefined;
		const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !keptKeys.includes(key)));
		const shrunk = this.shrink(rest, restBudget, 0) as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			if (key in kept) result[key] = kept[key];
			else if (key in shrunk) result[key] = shrunk[key];
		}
		// Keys only in shrunk: the "[truncated]" entry naming dropped keys.
		for (const key of Object.keys(shrunk)) {
			if (!(key in value)) result[key] = shrunk[key];
		}
		return result;
	}

	shrink(value: unknown, budget: number, depth: number): unknown {
		const size = this.sizes.of(value, depth);
		// Small values stay whole; a parent that still doesn't fit drops trailing items or keys.
		if (size <= budget || size <= MIN_SHRINK_CHARS) return value;
		if (budget < MIN_SHRINK_CHARS || depth > MAX_SHRINK_DEPTH) return marker(`${size} chars`);
		if (typeof value === 'string') return clipString(value, budget);
		if (Array.isArray(value)) return this.shrinkArray(value, budget, depth);
		if (isPlainObject(value)) return this.shrinkObject(value, budget, depth);
		return marker(`${size} chars`);
	}

	private shrinkArray(value: unknown[], budget: number, depth: number): unknown[] {
		const itemOverhead = (depth + 1) * INDENT + 2; // indentation and ",\n"
		const reserve = MARKER_RESERVE_CHARS + itemOverhead;
		const kept: unknown[] = [];
		let used = 4; // brackets and their newlines
		for (const item of value) {
			const itemChars = this.sizes.of(item, depth + 1) + itemOverhead;
			if (used + itemChars + reserve > budget) break;
			kept.push(item);
			used += itemChars;
		}
		// A single item too large to keep whole is shrunk rather than dropped.
		if (kept.length === 0 && value.length > 0) {
			kept.push(this.shrink(value[0], budget - used - reserve - itemOverhead, depth + 1));
		}
		const omitted = value.length - kept.length;
		return omitted > 0 ? [...kept, marker(`${omitted} more items`)] : kept;
	}

	private shrinkObject(value: Record<string, unknown>, budget: number, depth: number): Record<string, unknown> {
		const entryOverhead = (key: string) => (depth + 1) * INDENT + JSON.stringify(key).length + 4; // indentation, ": " and ",\n"
		const entries = Object.entries(value);
		// Fair share, smallest values first: small values stay whole and the budget they leave is
		// split evenly among the larger ones, so the largest values are the ones that shrink.
		const bySize = entries
			.map(([key, entry]) => ({ key, entry, chars: this.sizes.of(entry, depth + 1) }))
			.sort((a, b) => a.chars - b.chars);
		let remaining = budget - 4 - entries.reduce((sum, [key]) => sum + entryOverhead(key), 0);
		const shrunk = new Map<string, unknown>();
		bySize.forEach(({ key, entry, chars }, index) => {
			const share = Math.floor(remaining / (bySize.length - index));
			const result = chars > share ? this.shrink(entry, Math.max(share, 0), depth + 1) : entry;
			shrunk.set(key, result);
			remaining -= this.sizes.of(result, depth + 1);
		});
		const result = Object.fromEntries(entries.map(([key]) => [key, shrunk.get(key)]));
		if (remaining >= 0) return result;

		// Too many keys to fit even as markers: keep leading keys and name the dropped ones.
		const kept: Record<string, unknown> = {};
		let used = 4 + MARKER_RESERVE_CHARS * 3;
		for (const [key, entry] of Object.entries(result)) {
			const chars = entryOverhead(key) + this.sizes.of(entry, depth + 1);
			if (used + chars > budget) break;
			kept[key] = entry;
			used += chars;
		}
		const dropped = entries.map(([key]) => key).filter((key) => !(key in kept));
		const named = dropped.slice(0, MAX_NAMED_DROPPED_KEYS).join(', ') + (dropped.length > MAX_NAMED_DROPPED_KEYS ? ', …' : '');
		kept['[truncated]'] = clipString(marker(`${dropped.length} more keys: ${named}`), MARKER_RESERVE_CHARS * 3);
		return kept;
	}
}

function clipString(value: string, budget: number): string {
	// Clip until the escaped string plus the marker fits; escaping can make it longer than its length.
	let keep = Math.max(0, budget - MARKER_RESERVE_CHARS);
	while (true) {
		// Don't split a surrogate pair.
		if (keep > 0 && /[\uD800-\uDBFF]/.test(value[keep - 1])) keep -= 1;
		const clipped = `${value.slice(0, keep)}…${marker(`${value.length - keep} chars`)}`;
		if (JSON.stringify(clipped).length <= budget || keep === 0) return clipped;
		keep = Math.floor(keep * BUDGET_TIGHTENING);
	}
}

function marker(detail: string): string {
	return `[truncated: ${detail}]`;
}

// Pretty-printed size of JSON values, computed bottom-up once per array or object. Below
// MAX_SHRINK_DEPTH, where nothing is shrunk, subtrees are measured natively in one go.
class SizeCache {
	private readonly cache = new WeakMap<object, { chars: number; lines: number }>();

	// Characters JSON.stringify(value, null, 2) takes when nested `depth` levels deep.
	of(value: unknown, depth: number): number {
		const { chars, lines } = this.measure(value);
		return chars + lines * depth * INDENT;
	}

	private measure(value: unknown, depth = 0): { chars: number; lines: number } {
		if (value === null || typeof value !== 'object') return { chars: JSON.stringify(value)?.length ?? 0, lines: 0 };
		const cached = this.cache.get(value);
		if (cached !== undefined) return cached;
		if (depth > MAX_SHRINK_DEPTH) return measureNatively(value);
		const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
			? value.map((item) => [undefined, item])
			: Object.entries(value).filter(([, entry]) => entry !== undefined && typeof entry !== 'function');
		// "[\n" + per entry: indentation, optional `"key": `, the value with each inner line indented
		// once more, ",\n" between entries + "\n]".
		let chars = entries.length === 0 ? 2 : 4 + 2 * (entries.length - 1);
		let lines = entries.length === 0 ? 0 : entries.length + 1;
		for (const [key, entry] of entries) {
			const child = this.measure(entry, depth + 1);
			chars += INDENT + (key !== undefined ? JSON.stringify(key).length + 2 : 0) + child.chars + child.lines * INDENT;
			lines += child.lines;
		}
		const result = { chars, lines };
		this.cache.set(value, result);
		return result;
	}
}

function measureNatively(value: object): { chars: number; lines: number } {
	const json = JSON.stringify(value, null, INDENT);
	let lines = 0;
	for (let index = json.indexOf('\n'); index !== -1; index = json.indexOf('\n', index + 1)) lines += 1;
	return { chars: json.length, lines };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
