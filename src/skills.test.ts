import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPrompt, workflowPrompts } from './prompts.js';
import { loadWorkflowSkills, renderSkill, skillDescription } from './skills.js';

test('every workflow prompt is a skill at skill://lexware-office/<name>/SKILL.md', async () => {
	// strict: throws on any skill the SDK would skip.
	const catalog = await loadWorkflowSkills({ writesEnabled: true });
	assert.deepEqual(
		catalog.entries.map((skill) => skill.uri),
		workflowPrompts.map((prompt) => `skill://lexware-office/${prompt.name}/SKILL.md`).sort(),
	);
	for (const skill of catalog.entries) {
		const prompt = workflowPrompts.find((candidate) => candidate.name === skill.frontmatter.name);
		assert.ok(prompt, skill.uri);
		assert.equal(skill.frontmatter.description, skillDescription(prompt), skill.uri);
		assert.match(skill.frontmatter.description, /\. Use when .*Lexware Office/, skill.uri);
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
