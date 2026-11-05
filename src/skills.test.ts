import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPrompt, workflowPrompts } from './prompts.js';
import { loadWorkflowSkills, renderSkill, workflowSkillFiles } from './skills.js';
import { parseWriteAllow } from './write-policy.js';

test('every workflow prompt is a skill at skill://lexware-office/<name>/SKILL.md', async () => {
	// strict: throws on any skill the SDK would skip.
	const catalog = await loadWorkflowSkills({ writesEnabled: true });
	assert.deepEqual(
		catalog.entries.map((skill) => skill.uri),
		workflowPrompts.map((prompt) => `skill://lexware-office/${prompt.name}/SKILL.md`).sort(),
	);
	for (const skill of catalog.entries) {
		const prompt = workflowPrompts.find((candidate) => candidate.name === skill.frontmatter.name);
		assert.equal(skill.frontmatter.description, prompt?.description, skill.uri);
	}
});

test('a skill is its prompt rendered without arguments, under frontmatter and the title', () => {
	const context = { writesEnabled: true };
	for (const prompt of workflowPrompts) {
		const text = renderSkill(prompt, context);
		assert.ok(text.startsWith(`---\nname: ${prompt.name}\ndescription: "`), prompt.name);
		assert.ok(text.endsWith(`\n---\n\n# ${prompt.title}\n\n${renderPrompt(prompt, {}, context)}\n`), prompt.name);
	}
});

test('write skills follow the server write mode', () => {
	const readOnly = workflowSkillFiles({ writesEnabled: false });
	assert.match(readOnly['upload-receipts/SKILL.md'] ?? '', /\n\nThis server is read-only \(spec\.info\.writesEnabled is false\)/);
	assert.doesNotMatch(workflowSkillFiles({ writesEnabled: true })['upload-receipts/SKILL.md'] ?? '', /read-only/);

	const draftsOnly = workflowSkillFiles({ writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/invoices') });
	assert.match(draftsOnly['create-invoice/SKILL.md'] ?? '', /LEXWARE_OFFICE_WRITE_ALLOW blocks POST \/v1\/invoices\?finalize=true/);
});
