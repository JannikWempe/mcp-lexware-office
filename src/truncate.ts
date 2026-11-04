export interface TruncationOptions {
	maxChars?: number;
}

export interface JsonTruncationOptions extends TruncationOptions {
	// Top-level keys that are kept whole unless they alone come close to maxChars.
	keep?: string[];
}

interface TruncationHint {
	originalChars: number;
	note?: string;
}

const DEFAULT_MAX_CHARS = 24_000;
const RECOVERY_GUIDANCE = 'Recovery: use a more specific search query, return fewer fields, paginate or narrow date ranges, or summarize inside execute before returning.';
const INDENT = 2;
// Values up to this many characters stay whole; larger ones get at least this budget or become a marker.
const MIN_SHRINK_CHARS = 80;
// Values nested deeper than this become a marker when they don't fit, so recursion stays bounded.
const MAX_SHRINK_DEPTH = 64;
// Room reserved for a "[truncated: N more items]" element or a clipped string's marker.
const MARKER_CHARS = 40;
// Room reserved for the "[truncated]" entry naming an object's dropped keys.
const DROPPED_KEYS_MARKER_CHARS = 120;
const MAX_NAMED_DROPPED_KEYS = 10;
// The size estimates ignore a few separators, so each retry tightens the budget by this factor.
const BUDGET_TIGHTENING = 0.8;
// Pretty-printed JSON adds per container: "[\n" + "\n]", and per entry: indentation + ",\n".
const CONTAINER_CHARS = 4;
const ENTRY_SEPARATOR_CHARS = 2;
const KEY_SEPARATOR_CHARS = 2; // ": "
const EMPTY_CONTAINER_CHARS = 2; // "[]" or "{}"

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
	const sizes = new SizeCache();
	const originalChars = sizes.of(value, 0);
	if (originalChars <= maxChars) return value;

	const shrinker = new Shrinker(sizes);
	const hint: TruncationHint = {
		originalChars,
		note: `Result exceeded ${maxChars} characters and was shrunk: values marked "[truncated: ...]" were clipped or omitted. ${RECOVERY_GUIDANCE}`,
	};
	const keptKeys = isPlainObject(value) ? Object.keys(value).filter((key) => options.keep?.includes(key)) : [];
	const shrinkExceptKept = (budget: number) => shrinker.shrinkExcept(value as Record<string, unknown>, keptKeys, budget);
	const keptOnly = () => Object.fromEntries(keptKeys.map((key) => [key, (value as Record<string, unknown>)[key]]));
	const shrinkAll = (budget: number) => shrinker.shrink(value, budget, 0);
	// Kept keys first: with the other keys shrunk, then dropped, with a compact hint as a last
	// resort. Only if the kept keys alone come close to the limit is everything shrunk.
	const plans: Array<[(budget: number) => unknown, TruncationHint]> = keptKeys.length > 0
		? [[shrinkExceptKept, hint], [shrinkExceptKept, { originalChars }], [keptOnly, { originalChars }], [shrinkAll, hint]]
		: [[shrinkAll, hint]];
	for (const [shrink, planHint] of plans) {
		const hintChars = sizes.of({ truncated: planHint }, 0);
		for (let budget = maxChars - hintChars; budget >= MIN_SHRINK_CHARS; budget = Math.floor(budget * BUDGET_TIGHTENING)) {
			const result = withHint(shrink(budget), planHint);
			if (sizes.of(result, 0) <= maxChars) return result;
		}
	}
	return { truncated: hint };
}

function withHint(shrunk: unknown, hint: TruncationHint): unknown {
	return isPlainObject(shrunk) ? { ...shrunk, truncated: hint } : { truncated: hint, value: shrunk };
}

class Shrinker {
	constructor(private readonly sizes: SizeCache) {}

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

	// Shrinks the keys other than keptKeys into what the kept ones leave of the budget, keeping key order.
	shrinkExcept(value: Record<string, unknown>, keptKeys: string[], budget: number): Record<string, unknown> {
		const kept = Object.fromEntries(keptKeys.map((key) => [key, value[key]]));
		const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !keptKeys.includes(key)));
		const restBudget = budget - this.sizes.of(kept, 0);
		const shrunk = restBudget >= MIN_SHRINK_CHARS
			? this.shrink(rest, restBudget, 0) as Record<string, unknown>
			// No room left: each remaining value becomes a marker, unless it is small (depth 1: inside the object).
			: Object.fromEntries(Object.entries(rest).map(([key, entry]) => [key, this.shrink(entry, 0, 1)]));
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

	private shrinkArray(value: unknown[], budget: number, depth: number): unknown[] {
		const itemOverhead = (depth + 1) * INDENT + ENTRY_SEPARATOR_CHARS;
		const reserve = MARKER_CHARS + itemOverhead;
		const kept: unknown[] = [];
		let used = CONTAINER_CHARS;
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
		const entryOverhead = (key: string) => (depth + 1) * INDENT + JSON.stringify(key).length + KEY_SEPARATOR_CHARS + ENTRY_SEPARATOR_CHARS;
		const entries = Object.entries(value);
		// Fair share, smallest values first: small values stay whole and the budget they leave is
		// split evenly among the larger ones, so the largest values are the ones that shrink.
		const bySize = entries
			.map(([key, entry]) => ({ key, entry, chars: this.sizes.of(entry, depth + 1) }))
			.sort((a, b) => a.chars - b.chars);
		let remaining = budget - CONTAINER_CHARS - entries.reduce((sum, [key]) => sum + entryOverhead(key), 0);
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
		let used = CONTAINER_CHARS + DROPPED_KEYS_MARKER_CHARS;
		for (const [key, entry] of Object.entries(result)) {
			const chars = entryOverhead(key) + this.sizes.of(entry, depth + 1);
			if (used + chars > budget) break;
			kept[key] = entry;
			used += chars;
		}
		const dropped = entries.map(([key]) => key).filter((key) => !(key in kept));
		const named = dropped.slice(0, MAX_NAMED_DROPPED_KEYS).join(', ') + (dropped.length > MAX_NAMED_DROPPED_KEYS ? ', …' : '');
		kept['[truncated]'] = clipString(marker(`${dropped.length} more keys: ${named}`), DROPPED_KEYS_MARKER_CHARS);
		return kept;
	}
}

function clipString(value: string, budget: number): string {
	const clip = (keep: number) => {
		// Don't split a surrogate pair.
		const end = keep > 0 && /[\uD800-\uDBFF]/.test(value[keep - 1]) ? keep - 1 : keep;
		return `${value.slice(0, end)}…${marker(`${value.length - end} chars`)}`;
	};
	// Escaping can make the string longer than its length, so tighten until it fits.
	let keep = Math.max(0, budget - MARKER_CHARS);
	let clipped = clip(keep);
	while (JSON.stringify(clipped).length > budget && keep > 0) {
		keep = Math.floor(keep * BUDGET_TIGHTENING);
		clipped = clip(keep);
	}
	return clipped;
}

function marker(detail: string): string {
	return `[truncated: ${detail}]`;
}

interface Measure {
	chars: number;
	lines: number;
}

interface MeasureFrame {
	node: object;
	entries: Array<[string | undefined, unknown]>;
	next: number;
	measure: Measure;
}

// Pretty-printed size of JSON values, computed once per array or object. Iterative, so that
// arbitrarily deep values neither overflow the stack nor get serialized once per level.
class SizeCache {
	private readonly cache = new WeakMap<object, Measure>();

	// Characters JSON.stringify(value, null, 2) takes when nested `depth` levels deep.
	of(value: unknown, depth: number): number {
		const { chars, lines } = this.measure(value);
		return chars + lines * depth * INDENT;
	}

	private measure(value: unknown): Measure {
		if (value === null || typeof value !== 'object') return measureLeaf(value);
		const cached = this.cache.get(value);
		if (cached !== undefined) return cached;
		const root = frame(value);
		const stack = [root];
		while (stack.length > 0) {
			const current = stack[stack.length - 1];
			if (current.next === current.entries.length) {
				this.cache.set(current.node, current.measure);
				stack.pop();
				continue;
			}
			const [key, entry] = current.entries[current.next];
			const child = entry !== null && typeof entry === 'object' ? this.cache.get(entry) : measureLeaf(entry);
			if (child === undefined) {
				stack.push(frame(entry as object));
				continue;
			}
			// Each line of a nested value is indented once more.
			current.measure.chars += INDENT + (key !== undefined ? JSON.stringify(key).length + KEY_SEPARATOR_CHARS : 0) + child.chars + child.lines * INDENT;
			current.measure.lines += child.lines;
			current.next += 1;
		}
		return root.measure;
	}
}

function frame(node: object): MeasureFrame {
	// Like JSON.stringify: undefined, functions, symbols and holes are null in arrays and omitted in objects.
	const entries: MeasureFrame['entries'] = Array.isArray(node)
		? Array.from(node, (item) => [undefined, isSerializable(item) ? item : null])
		: Object.entries(node).filter(([, entry]) => isSerializable(entry));
	const count = entries.length;
	return {
		node,
		entries,
		next: 0,
		measure: count === 0 ? { chars: EMPTY_CONTAINER_CHARS, lines: 0 } : { chars: CONTAINER_CHARS + ENTRY_SEPARATOR_CHARS * (count - 1), lines: count + 1 },
	};
}

function isSerializable(value: unknown): boolean {
	return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

function measureLeaf(value: unknown): Measure {
	return { chars: JSON.stringify(value)?.length ?? 0, lines: 0 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
