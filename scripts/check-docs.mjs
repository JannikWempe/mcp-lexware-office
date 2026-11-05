// Checks the catalog against the live Lexware docs page (network required, not part of `pnpm test`):
// - every `docsUrl` anchor in `lexwareSpec` exists on the page
// - the changelog has no entries newer than `latestChangelogEntry` in lexware-docs-baseline.json
// - the text of every top-level docs section still has the hash stored in `sections`, which catches silent
//   edits the changelog only calls "minor documentation updates"
// After syncing the catalog with the docs, run `node scripts/check-docs.mjs --update-baseline` to store
// the current changelog date and section hashes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { lexwareSpec } from '../build/lexware-spec.js';

const DOCS_URL = 'https://developers.lexware.io/docs/';
const baselinePath = new URL('./lexware-docs-baseline.json', import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const updateBaseline = process.argv.includes('--update-baseline');

const response = await fetch(DOCS_URL);
if (!response.ok) {
	console.error(`GET ${DOCS_URL} failed: ${response.status}`);
	process.exit(1);
}
const html = await response.text();
const problems = [];

const anchors = new Set([...html.matchAll(/\sid=['"]([^'"]+)['"]/g)].map((match) => match[1]));
const docsUrls = [];
const collect = (value, path) => {
	if (Array.isArray(value)) {
		value.forEach((item, index) => collect(item, `${path}[${index}]`));
	} else if (value !== null && typeof value === 'object') {
		for (const [key, child] of Object.entries(value)) {
			if (key === 'docsUrl' && typeof child === 'string') {
				docsUrls.push({ path: `${path}.${key}`, url: child });
			} else {
				collect(child, `${path}.${key}`);
			}
		}
	}
};
collect(lexwareSpec, 'lexwareSpec');

for (const { path, url } of docsUrls) {
	if (!url.startsWith(`${DOCS_URL}#`)) {
		problems.push(`${path}: ${url} does not point into ${DOCS_URL}`);
	} else if (!anchors.has(url.slice(DOCS_URL.length + 1))) {
		problems.push(`${path}: anchor not found on docs page: ${url}`);
	}
}

// One hash per top-level (h1) section, e.g. #invoices-endpoint with its property tables and operations, covering the
// visible text only. The changelog has its own check above.
const topSections = [...html.matchAll(/<h1[^>]*\sid=['"]([^'"]+)['"][^>]*>/g)].map((match) => ({ id: match[1], start: match.index }));
const sections = {};
topSections.forEach((section, index) => {
	if (section.id === 'change-log') return;
	const text = html
		.slice(section.start, topSections[index + 1]?.start ?? html.length)
		.replace(/<script[\s\S]*?<\/script>/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	sections[section.id] = createHash('sha256').update(text).digest('hex').slice(0, 16);
});
if (!updateBaseline) {
	for (const [anchor, hash] of Object.entries(sections)) {
		const stored = baseline.sections?.[anchor];
		if (stored === undefined) {
			problems.push(`section #${anchor} is new or has no stored hash; review it, then run with --update-baseline`);
		} else if (stored !== hash) {
			problems.push(`section #${anchor} changed since the baseline; diff it against the catalog: ${DOCS_URL}#${anchor}`);
		}
	}
	for (const anchor of Object.keys(baseline.sections ?? {}).filter((anchor) => sections[anchor] === undefined)) {
		problems.push(`section #${anchor} is gone from the docs page`);
	}
}

const changelogStart = html.indexOf("id='change-log'");
let changelogEntries = [];
if (changelogStart === -1) {
	problems.push('changelog section (#change-log) not found on docs page');
} else {
	const changelog = html.slice(changelogStart, html.indexOf('</ul>', changelogStart));
	changelogEntries = [...changelog.matchAll(/<li>(\d{2})\.(\d{2})\.(\d{4}) - ([\s\S]*?)<\/li>/g)]
		.map(([, day, month, year, text]) => ({ date: `${year}-${month}-${day}`, text: text.replace(/<[^>]+>/g, '') }));
	if (!updateBaseline) {
		for (const entry of changelogEntries.filter((entry) => entry.date > baseline.latestChangelogEntry)) {
			problems.push(`new changelog entry ${entry.date}: ${entry.text}`);
		}
	}
}

if (updateBaseline && problems.length === 0) {
	const latestChangelogEntry = changelogEntries.map((entry) => entry.date).sort().at(-1) ?? baseline.latestChangelogEntry;
	writeFileSync(baselinePath, `${JSON.stringify({ latestChangelogEntry, sections }, null, '\t')}\n`);
	console.log(`Stored ${Object.keys(sections).length} section hashes and changelog date ${latestChangelogEntry} in ${baselinePath.pathname}.`);
}

if (problems.length > 0) {
	console.error(`Catalog is out of sync with ${DOCS_URL}:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
	process.exit(1);
}
if (!updateBaseline) {
	console.log(`${docsUrls.length} docsUrl anchors resolve; ${Object.keys(sections).length} sections unchanged; no changelog entries after ${baseline.latestChangelogEntry}.`);
}
