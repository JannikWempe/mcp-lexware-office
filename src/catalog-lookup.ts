import type { HttpMethod, LexwareApiCatalog } from './lexware-spec.js';

// The guest-facing `find` and `describe` helpers of the search and execute sandboxes: a ranked,
// compact lookup over the catalog so discovery doesn't return whole spec sections. The
// implementation (createCatalogLookup) is serialized into the guest prelude and runs against the
// sandbox's own `spec` copy; `src/catalog-lookup.test.ts` guards drift with the declaration.

type CatalogMatchKind = 'operation' | 'workflow' | 'semantics';

interface CatalogMatch {
	kind: CatalogMatchKind;
	id: string;
	method?: string;
	path?: string;
	summary: string;
	score: number;
	hint: string;
}

interface CatalogFindOptions {
	limit?: number;
	kinds?: CatalogMatchKind[];
}

// Guest prelude: binds `find` and `describe` to the sandbox's `spec` capability.
export const catalogLookupPrelude = `const { find, describe } = (${createCatalogLookup.toString()})(spec);`;

// Builds `find` and `describe` over a catalog. Runs inside QuickJS via Function.prototype.toString(),
// so it must stay self-contained: no references to imports or module-scope values (type-only
// references are fine). The index is built on the first call, so sandboxes that never search pay nothing.
export function createCatalogLookup(catalog: LexwareApiCatalog) {
	type Field = { weight: number; tokens: string[] };
	// idTokens: the words of the operationId or key; matching more of them breaks ties toward the
	// more specific entry (downloadInvoicePdf over downloadDownPaymentInvoicePdf for 'invoice pdf').
	type Entry = { match: Omit<CatalogMatch, 'score'>; fields: Field[]; idTokens: string[] };

	const DEFAULT_LIMIT = 8;
	const MAX_LIMIT = 25;
	const MAX_SUMMARY_CHARS = 120;
	const MAX_DESCRIPTION_CHARS = 200;
	const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
	const KINDS: CatalogMatchKind[] = ['operation', 'workflow', 'semantics'];
	// Field weights: curated tags and keywords say most about intent, free text least.
	const WEIGHT = { tag: 3, path: 2, id: 2, summary: 2, param: 1, text: 1 };
	// Too common in the catalog to tell entries apart.
	const STOPWORDS = new Set(['a', 'an', 'and', 'or', 'the', 'of', 'to', 'for', 'in', 'on', 'by', 'with', 'from', 'is', 'are', 'be', 'v1', 'id', 'der', 'die', 'das', 'und', 'ein', 'eine', 'mit', 'von', 'für']);
	// German query words mapped to the English words the catalog uses: mostly verbs and nouns the
	// catalog has no German tag for (beleg, umsatz, mahnungen, angebote, … are tagged already).
	const SYNONYMS: Record<string, string[]> = {
		hochladen: ['upload'], herunterladen: ['download'], anlegen: ['create'], erstellen: ['create'], ändern: ['update'], aktualisieren: ['update'],
		bearbeiten: ['update'], löschen: ['delete'], suchen: ['find', 'list'], finden: ['find', 'list'], auflisten: ['list'], abrufen: ['get'],
		kunde: ['contact', 'customer'], kunden: ['contact', 'customer'], kontakt: ['contact'], kontakte: ['contact'], lieferant: ['contact', 'vendor'],
		lieferanten: ['contact', 'vendor'], rechnung: ['invoice'], rechnungen: ['invoice'], artikel: ['article'], ausgaben: ['expense'], kosten: ['cost', 'expense'],
		einnahmen: ['revenue', 'income'], gewinn: ['profit'], steuer: ['tax'], zahlung: ['payment'], zahlungen: ['payment'], datei: ['file'],
		dateien: ['file'], buchungskategorie: ['posting', 'category'], kategorie: ['category'], offen: ['open'], offene: ['open'], bezahlt: ['paid'],
		storniert: ['voided'], entwurf: ['draft'],
	};

	// Folds the English plural, so 'webhook' matches 'webhooks' exactly.
	const stem = (token: string): string => (token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
	// Lowercased words of identifiers, paths and prose: 'listVoucherSummaries' → list, voucher, summary.
	const tokenize = (value: unknown): string[] => {
		if (typeof value !== 'string') return [];
		return value
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.toLowerCase()
			.split(/[^a-z0-9äöüß]+/)
			.filter((token) => token.length > 1 && !STOPWORDS.has(token))
			.map(stem);
	};
	// Compound forms are kept next to their parts, so 'voucherlist' and 'order-confirmations' match whole.
	const compoundTokens = (value: unknown): string[] => {
		if (typeof value !== 'string') return [];
		const whole = value.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '');
		return whole.length > 1 ? [stem(whole), ...tokenize(value)] : tokenize(value);
	};
	const field = (weight: number, values: unknown[], tokenizer = tokenize): Field => ({ weight, tokens: values.flatMap((value) => tokenizer(value)) });
	const shorten = (text: unknown, max: number): string => {
		const value = typeof text === 'string' ? text : '';
		return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value;
	};
	const hasOwn = (object: unknown, key: string) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
	const propertyAccess = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']');
	const paths = catalog.paths ?? {};
	const isMethod = (value: string): value is HttpMethod => (METHODS as string[]).includes(value);

	let index: Entry[] | undefined;
	const buildIndex = (): Entry[] => {
		const entries: Entry[] = [];
		// Domain names and tags (with German synonyms such as 'mahnungen') count as tags of their endpoints.
		const domainTags = new Map<string, string[]>();
		for (const [name, domain] of Object.entries(catalog.info?.domainIndex ?? {})) {
			for (const endpoint of domain.endpoints ?? []) {
				const key = endpoint.method.toUpperCase() + ' ' + endpoint.path;
				domainTags.set(key, [...(domainTags.get(key) ?? []), name, ...(domain.tags ?? [])]);
			}
		}
		for (const [path, methods] of Object.entries(paths)) {
			for (const method of METHODS) {
				const operation = methods[method];
				if (operation === undefined) continue;
				const httpMethod = method.toUpperCase();
				entries.push({
					match: {
						kind: 'operation',
						id: operation.operationId,
						method: httpMethod,
						path,
						summary: shorten(operation.summary, MAX_SUMMARY_CHARS),
						hint: 'describe(' + JSON.stringify(httpMethod) + ', ' + JSON.stringify(path) + ')',
					},
					idTokens: tokenize(operation.operationId),
					fields: [
						field(WEIGHT.tag, [...(operation.tags ?? []), ...(domainTags.get(httpMethod + ' ' + path) ?? [])], compoundTokens),
						field(WEIGHT.path, path.split('/'), compoundTokens),
						field(WEIGHT.id, [operation.operationId]),
						field(WEIGHT.summary, [operation.summary]),
						field(WEIGHT.param, (operation.parameters ?? []).map((parameter) => parameter.name), compoundTokens),
						field(WEIGHT.text, [operation.description]),
					],
				});
			}
		}
		for (const [key, workflow] of Object.entries(catalog.workflows ?? {})) {
			entries.push({
				match: { kind: 'workflow', id: key, summary: shorten(workflow.summary, MAX_SUMMARY_CHARS), hint: 'spec.workflows' + propertyAccess(key) },
				idTokens: tokenize(key),
				fields: [
					field(WEIGHT.tag, workflow.keywords ?? [], compoundTokens),
					field(WEIGHT.id, [key]),
					field(WEIGHT.summary, [workflow.summary]),
					field(WEIGHT.text, workflow.steps ?? []),
				],
			});
		}
		// Semantics: the explanatory objects under spec.info (they carry a summary), indexed by their
		// own keys and the keys one level down, e.g. voucher types, metrics and ambiguous terms.
		for (const [key, value] of Object.entries(catalog.info ?? {})) {
			const summary = value !== null && typeof value === 'object' ? (value as { summary?: unknown }).summary : undefined;
			if (typeof summary !== 'string') continue;
			const nestedKeys = Object.values(value).flatMap((child) => (child !== null && typeof child === 'object' && !Array.isArray(child) ? Object.keys(child) : []));
			entries.push({
				match: { kind: 'semantics', id: key, summary: shorten(summary, MAX_SUMMARY_CHARS), hint: 'spec.info' + propertyAccess(key) },
				idTokens: tokenize(key),
				fields: [
					field(WEIGHT.id, [key]),
					field(WEIGHT.summary, [summary]),
					field(WEIGHT.text, [...Object.keys(value), ...nestedKeys]),
				],
			});
		}
		return entries;
	};

	// Exact token: full weight. A token that extends the query word ('voucher' → 'voucherlist') or
	// that the word extends ('rechnungen' → 'rechnung'), from 5 letters on so 'download' doesn't match 'down': half weight.
	const wordScore = (word: string, entry: Entry): number => {
		let best = 0;
		let exactFields = 0;
		for (const { weight, tokens } of entry.fields) {
			let fieldScore = 0;
			for (const token of tokens) {
				if (token === word) {
					fieldScore = weight;
					exactFields += 1;
					break;
				}
				if (word.length >= 3 && (token.startsWith(word) || (token.length >= 5 && word.startsWith(token)))) fieldScore = Math.max(fieldScore, weight / 2);
			}
			best = Math.max(best, fieldScore);
		}
		// Small tie-breaker for words an entry mentions exactly in several fields.
		return best > 0 ? best + 0.25 * Math.max(exactFields - 1, 0) : 0;
	};
	// A query term scores as its best spelling: itself or one of its English synonyms.
	const spellings = (term: string) => [term, ...(hasOwn(SYNONYMS, term) ? SYNONYMS[term] : [])];
	const termScore = (term: string, entry: Entry) => Math.max(...spellings(term).map((word) => wordScore(word, entry)));

	const find = (query: string, options: CatalogFindOptions = {}): CatalogMatch[] => {
		if (typeof query !== 'string') throw new Error('find(query) expects a string query');
		if (options === null || typeof options !== 'object') throw new Error('find(query, options) expects options to be an object, e.g. { limit: 5 }');
		const { limit = DEFAULT_LIMIT, kinds } = options;
		if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new Error('find: limit must be a finite number');
		const maxResults = Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
		if (kinds !== undefined) {
			if (!Array.isArray(kinds)) throw new Error('find: kinds must be an array, e.g. ["operation", "workflow"]');
			const unknownKinds = kinds.filter((kind) => !KINDS.includes(kind));
			if (unknownKinds.length > 0) throw new Error('find: unknown kinds ' + JSON.stringify(unknownKinds) + '; use ' + KINDS.join(', '));
		}
		const terms = [...new Set(tokenize(query))];
		if (terms.length === 0) return [];
		// The query written as one word ('order confirmation' → 'orderconfirmation') can add to the score but isn't required.
		const compound = compoundTokens(query)[0];
		const optionalTerms = compound !== undefined && !terms.includes(compound) && terms.length > 1 ? [compound] : [];
		// A catalog path in the query ('/v1/vouchers/{id}', 'PUT /v1/vouchers/{id}') points at that operation.
		const pathMatch = /(?:\b(get|post|put|patch|delete)\s+)?(\/v1\/[^\s?]*)/i.exec(query);
		const queryMethod = pathMatch?.[1]?.toUpperCase();
		const queryPath = pathMatch?.[2];
		const words = terms.flatMap(spellings);
		index ??= buildIndex();
		const candidates = index.filter((entry) => kinds === undefined || kinds.includes(entry.match.kind));
		const termScores = candidates.map((entry) => terms.map((term) => termScore(term, entry)));
		// Terms nothing in the catalog matches (a year, a customer name) don't count against coverage.
		const knownTerms = terms.filter((_term, i) => termScores.some((scores) => scores[i] > 0)).length;
		const results: CatalogMatch[] = [];
		candidates.forEach((entry, entryIndex) => {
			const scores = termScores[entryIndex];
			let score = scores.reduce((sum, value) => sum + value, 0);
			for (const term of optionalTerms) score += termScore(term, entry);
			if (score === 0) return;
			// Entries matching more of the query's terms rank above ones matching one term strongly.
			score *= scores.filter((value) => value > 0).length / Math.max(knownTerms, 1);
			if (queryPath !== undefined && entry.match.path === queryPath) score += queryMethod === undefined ? 10 : entry.match.method === queryMethod ? 12 : 8;
			if (entry.idTokens.length > 0) score += 0.5 * entry.idTokens.filter((token) => words.includes(token)).length / entry.idTokens.length;
			results.push({ ...entry.match, score: Math.round(score * 100) / 100 });
		});
		return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
	};

	// Resolves a concrete path such as /v1/vouchers/1234 to its catalog template /v1/vouchers/{id}.
	const resolveTemplate = (path: string): string | undefined => {
		const cleanPath = path.split('?')[0].replace(/(.)\/$/, '$1');
		if (hasOwn(paths, cleanPath)) return cleanPath;
		const segments = cleanPath.split('/');
		return Object.keys(paths).find((template) => {
			const templateSegments = template.split('/');
			return templateSegments.length === segments.length
				&& templateSegments.every((segment, i) => segment === segments[i] || (/^\{[^}]+\}$/.test(segment) && segments[i] !== ''));
		});
	};

	// Compact view of one operation, without tags, capabilities and examples.
	const describe = (method: string, path: string) => {
		if (typeof method !== 'string' || typeof path !== 'string') throw new Error('describe(method, path) expects two strings, e.g. describe("GET", "/v1/voucherlist")');
		const methodKey = method.toLowerCase();
		const template = resolveTemplate(path);
		const operation = template !== undefined && isMethod(methodKey) && hasOwn(paths[template], methodKey) ? paths[template][methodKey] : undefined;
		if (template === undefined || operation === undefined) {
			const methods = template !== undefined ? Object.keys(paths[template]).map((key) => key.toUpperCase()) : [];
			throw new Error(
				'describe: no catalog operation ' + method.toUpperCase() + ' ' + path + '.' +
				(methods.length > 0 ? ' Methods on ' + template + ': ' + methods.join(', ') + '.' : ' Use find("…") to look up paths.'),
			);
		}
		const view: Record<string, unknown> = { operationId: operation.operationId, method: methodKey.toUpperCase(), path: template, summary: operation.summary };
		if (operation.description !== undefined) view.description = operation.description;
		if (operation.parameters !== undefined) {
			view.parameters = operation.parameters.map((parameter) => {
				const compact: Record<string, unknown> = { name: parameter.name, in: parameter.in };
				if (parameter.required !== undefined) compact.required = parameter.required;
				if (parameter.type !== undefined) compact.type = parameter.type;
				if (parameter.enum !== undefined) compact.enum = parameter.enum;
				if (parameter.description !== undefined) compact.description = shorten(parameter.description, MAX_DESCRIPTION_CHARS);
				return compact;
			});
		}
		if (operation.requestBody !== undefined) {
			const { contentType, summary, required } = operation.requestBody;
			view.requestBody = required !== undefined ? { contentType, summary, required } : { contentType, summary };
		}
		if (operation.responses !== undefined) view.responses = operation.responses;
		if (operation.notes !== undefined) view.notes = operation.notes;
		if (operation.docsUrl !== undefined) view.docsUrl = operation.docsUrl;
		view.fullEntry = 'spec.paths[' + JSON.stringify(template) + '].' + methodKey + ' (adds requestBody.shape, examples, capabilities)';
		return view;
	};

	return Object.freeze({ find, describe });
}

// Shown to the model in the search and execute tool descriptions; keep in sync with createCatalogLookup.
export const catalogLookupDeclaration = `// Ranked catalog lookup: the compact first step instead of returning whole spec sections.
declare function find(query: string, options?: { limit?: number /* default 8, max 25 */; kinds?: Array<'operation' | 'workflow' | 'semantics'> }): Array<{
  kind: 'operation' | 'workflow' | 'semantics';
  id: string; // operationId, workflow key, or spec.info key
  method?: string; path?: string; // operations only
  summary: string;
  score: number;
  hint: string; // where to read the full entry, e.g. "spec.workflows.fileHandling"
}>;
// Compact view of one operation: summary, description, parameters, requestBody (without shape), responses, notes, docsUrl,
// and fullEntry: where to read the rest. Concrete paths resolve to their template: describe('GET', '/v1/vouchers/<uuid>').
declare function describe(method: string, path: string): object;`;
