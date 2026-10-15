// Checks the catalog against the live Lexware docs page (network required, not part of `pnpm test`):
// - every `docsUrl` anchor in `lexwareSpec` exists on the page
// - the changelog has no entries newer than `latestChangelogEntry` in lexware-docs-baseline.json
// After syncing the catalog with new changelog entries, bump the baseline date.
import { readFileSync } from 'node:fs';

import { lexwareSpec } from '../build/lexware-spec.js';

const DOCS_URL = 'https://developers.lexware.io/docs/';
const baselinePath = new URL('./lexware-docs-baseline.json', import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).latestChangelogEntry;

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

const changelogStart = html.indexOf("id='change-log'");
if (changelogStart === -1) {
	problems.push('changelog section (#change-log) not found on docs page');
} else {
	const changelog = html.slice(changelogStart, html.indexOf('</ul>', changelogStart));
	const newEntries = [...changelog.matchAll(/<li>(\d{2})\.(\d{2})\.(\d{4}) - ([\s\S]*?)<\/li>/g)]
		.map(([, day, month, year, text]) => ({ date: `${year}-${month}-${day}`, text: text.replace(/<[^>]+>/g, '') }))
		.filter((entry) => entry.date > baseline);
	for (const entry of newEntries) {
		problems.push(`new changelog entry ${entry.date}: ${entry.text}`);
	}
}

if (problems.length > 0) {
	console.error(`Catalog is out of sync with ${DOCS_URL}:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
	process.exit(1);
}
console.log(`${docsUrls.length} docsUrl anchors resolve; no changelog entries after ${baseline}.`);
