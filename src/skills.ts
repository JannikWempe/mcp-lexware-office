import { memorySkillFiles, SkillsExtension, type SkillCatalog } from '@modelcontextprotocol/server/ext/skills';

import { renderPrompt, workflowPrompts, type PromptContext, type WorkflowPrompt } from './prompts.js';

// The workflow prompts as MCP Skills (SEP-2640, io.modelcontextprotocol/skills): one SKILL.md per prompt at
// skill://lexware-office/<name>/SKILL.md. A skill has no arguments, so the body is the prompt rendered without
// any; the prompt text then tells the model to ask the user for what is missing.

export const SKILL_PREFIX = 'lexware-office';

// JSON strings are YAML double-quoted scalars, so descriptions with ': ' stay valid frontmatter.
export const renderSkill = (prompt: WorkflowPrompt, context: PromptContext): string => [
	'---',
	`name: ${prompt.name}`,
	`description: ${JSON.stringify(prompt.description)}`,
	'---',
	'',
	`# ${prompt.title}`,
	'',
	renderPrompt(prompt, prompt.argsSchema.parse({}), context),
	'',
].join('\n');

export const workflowSkillFiles = (context: PromptContext): Record<string, string> =>
	Object.fromEntries(workflowPrompts.map((prompt) => [`${prompt.name}/SKILL.md`, renderSkill(prompt, context)]));

// strict: a skill the SDK would skip (bad name, description over 1024 characters) fails startup and the tests instead.
export const loadWorkflowSkills = (context: PromptContext): Promise<SkillCatalog> =>
	SkillsExtension.load(memorySkillFiles(workflowSkillFiles(context)), { prefix: SKILL_PREFIX, strict: true });
