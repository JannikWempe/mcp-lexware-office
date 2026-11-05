import { z } from 'zod';

import type { LexwareExecuteMethod } from './lexware-client.js';
import { lexwareSpec, type HttpMethod } from './lexware-spec.js';
import { writeAllowViolation, type WriteAllowRule } from './write-policy.js';

// MCP prompts for recurring workflows. The text is rendered from spec.workflows and
// spec.info.financeReportingSemantics, so prompts and catalog cannot drift apart.

export interface PromptContext {
	writesEnabled: boolean;
	// Writes allowed when writesEnabled; undefined allows every write.
	writeAllow?: WriteAllowRule[];
}

interface PromptWrite {
	method: LexwareExecuteMethod;
	path: string;
	finalize?: boolean;
}

export interface WorkflowPrompt<Args extends z.ZodObject = z.ZodObject> {
	name: string;
	title: string;
	description: string;
	// Completes "Use when …" in the skill description, so hosts pick this skill over others with similar names.
	useWhen: string;
	argsSchema: Args;
	// Writes the workflow sends; empty for read-only workflows. renderPrompt puts the write mode in front of them.
	writes: PromptWrite[];
	// The task and workflow text; the method syntax lets typed args widen to WorkflowPrompt.
	render(args: z.infer<Args>): string;
}

// Infers the typed render args per prompt; the list below widens them so index.ts registers every prompt alike.
const definePrompt = <Args extends z.ZodObject>(prompt: WorkflowPrompt<Args>): WorkflowPrompt => prompt;

// Clients may send '' for an argument the user left empty; treat it like an omitted one, so the model asks for it.
const given = (value: string | undefined) => {
	const trimmed = value?.trim();
	return trimmed === '' ? undefined : trimmed;
};
const blankAsOmitted = z.string().optional().transform(given);
const textArg = (description: string) => blankAsOmitted.describe(description);
const enumArg = <const Values extends [string, ...string[]]>(values: Values, description: string) =>
	blankAsOmitted.pipe(z.enum(values).optional()).describe(description);

const dateArg = (bound: string) => textArg(`${bound} of the voucherDate period, yyyy-MM-dd. Omitted: ask the user.`);
const modeArg = enumArg(['apply', 'preview'], 'apply (default): send the writes once the checks pass. preview: plan the writes with execute dryRun: true and send none.');

// Throws on a key the catalog doesn't have, so a renamed entry fails the tests instead of rendering "undefined".
const lookup = <T>(record: Record<string, T>, key: string, kind: string): T => {
	const entry = record[key];
	if (entry === undefined) throw new Error(`Unknown ${kind} ${key}`);
	return entry;
};

const renderWorkflow = (key: string): string => {
	const { summary, steps, notes } = lookup(lexwareSpec.workflows, key, 'workflow');
	return [
		`## ${summary} (spec.workflows.${key})`,
		...steps.map((step, index) => `${index + 1}. ${step}`),
		...(notes !== undefined && notes.length > 0 ? ['', 'Notes:', ...notes.map((note) => `- ${note}`)] : []),
	].join('\n');
};

const toolsIntro = 'Use the lexware-office tools: `execute` runs the steps below as sandboxed JavaScript with the lexware SDK, `search` has the details of every operation (e.g. describe(\'GET\', \'/v1/voucherlist\')). First confirm that spec.info.account is the organization the user means.';

const describeWrite = ({ method, path, finalize }: PromptWrite) => `${method} ${path}${finalize === true ? '?finalize=true' : ''}`;

const blockedWrites = (writes: PromptWrite[], rules: WriteAllowRule[]) => writes.filter((write) => {
	const operationId = lexwareSpec.paths[write.path]?.[write.method.toLowerCase() as HttpMethod]?.operationId;
	const query = new URLSearchParams(write.finalize === true ? { finalize: 'true' } : {});
	// Bookkeeping vouchers finalize via voucherStatus; other writes ignore it.
	const body = { voucherStatus: write.finalize === true ? 'open' : 'unchecked' };
	return writeAllowViolation(rules, { method: write.method, path: write.path, query, body, operationId }) !== undefined;
});

const writeModeSection = (writes: PromptWrite[], mode: 'apply' | 'preview', context: PromptContext): string => {
	const needed = writes.map(describeWrite).join(', ');
	if (!context.writesEnabled) {
		return `This server is read-only (spec.info.writesEnabled is false) and rejects the writes this workflow needs (${needed}). Do the read-only steps, preview the writes with execute dryRun: true, and tell the user that sending them needs the server started with LEXWARE_OFFICE_ALLOW_WRITES=true and without LEXWARE_OFFICE_READ_ONLY=true.`;
	}
	const blocked = context.writeAllow !== undefined ? blockedWrites(writes, context.writeAllow) : [];
	const policy = blocked.length > 0
		? `LEXWARE_OFFICE_WRITE_ALLOW blocks ${blocked.map(describeWrite).join(', ')} (see spec.info.writePolicy.allow). Preview those writes with execute dryRun: true and tell the user they need to be allowed first.\n\n`
		: '';
	return mode === 'preview'
		? `${policy}Write mode preview: run every execute call that writes with dryRun: true and report its plannedWrites. Send no writes.`
		: `${policy}Send the writes once the checks pass and the user agreed to them; preview a write with execute dryRun: true first when the user should review it.`;
};

const periodLine = (dateFrom: string | undefined, dateTo: string | undefined) => {
	if (dateFrom !== undefined && dateTo !== undefined) return `Period: voucherDate ${dateFrom} to ${dateTo}.`;
	if (dateFrom !== undefined) return `Period: voucherDate from ${dateFrom}. Ask the user for the end date (yyyy-MM-dd) unless it is clear from the conversation.`;
	if (dateTo !== undefined) return `Period: voucherDate to ${dateTo}. Ask the user for the start date (yyyy-MM-dd) unless it is clear from the conversation.`;
	return 'Ask the user for the period (voucherDate from and to, yyyy-MM-dd) unless it is clear from the conversation.';
};

const semantics = lexwareSpec.info.financeReportingSemantics;

const renderReportingSemantics = (terms: string[], metrics: string[]): string => [
	'## Reporting semantics (spec.info.financeReportingSemantics)',
	semantics.summary,
	`Default when the user does not specify: ${semantics.defaultPolicy.metric}. ${semantics.defaultPolicy.assumption}`,
	...semantics.defaultPolicy.notes.map((note) => `- ${note}`),
	'',
	'Ambiguous terms:',
	...terms.map((term) => `- ${term}: ${lookup(semantics.ambiguousTerms, term, 'ambiguous term')}`),
	'',
	'Metrics:',
	...metrics.flatMap((key) => {
		const metric = lookup(semantics.metrics, key, 'metric');
		return [`- ${key}: ${metric.summary} (workflow ${metric.workflow})`, ...metric.caveats.map((caveat) => `  - ${caveat}`)];
	}),
].join('\n');

const sections = (...parts: string[]) => parts.join('\n\n');

const uploadReceipts = definePrompt({
	name: 'upload-receipts',
	title: 'Upload receipts (Belege)',
	description: 'Upload receipts to Lexware Office: check for duplicates, upload, wait for text recognition, correct fields and categories without dropping the file, and report per receipt.',
	useWhen: 'the user wants to upload, book or reconcile receipts or supplier invoices (Belege) in Lexware Office (lexoffice).',
	argsSchema: z.object({
		files: textArg('Absolute paths of the receipts on the server machine, comma- or newline-separated. Omitted: ask the user.'),
		mode: modeArg,
	}),
	writes: [{ method: 'POST', path: '/v1/files' }, { method: 'PUT', path: '/v1/vouchers/{id}' }],
	render(args) {
		const files = args.files?.split(/[,\n]/).map((file) => file.trim()).filter((file) => file.length > 0) ?? [];
		return sections(
			files.length > 0
				? `Task: upload these receipts to Lexware Office:\n${files.map((file) => `- ${file}`).join('\n')}`
				: 'Task: upload receipts to Lexware Office. Ask the user for the absolute paths of the files on the server machine (contentPath needs LEXWARE_OFFICE_UPLOAD_DIRS).',
			toolsIntro,
			renderWorkflow('uploadReceipts'),
			renderWorkflow('reconcileBeforeUpload'),
		);
	},
});

const revenueBases = { invoiced: 'grossInvoicedRevenue', paid: 'paidRevenue', net: 'netRevenue' } as const;

const revenueReport = definePrompt({
	name: 'revenue-report',
	title: 'Revenue report (Umsatz)',
	description: 'Report revenue (Umsatz) for a period: invoiced or paid, gross or net, with the assumptions stated.',
	useWhen: 'the user asks for revenue, Umsatz, sales or turnover of a period from Lexware Office (lexoffice).',
	argsSchema: z.object({
		dateFrom: dateArg('Start'),
		dateTo: dateArg('End'),
		basis: enumArg(['invoiced', 'paid', 'net'], 'invoiced: gross invoiced/accrual revenue (the default). paid: paid/cash revenue. net: VAT-aware net revenue from invoice details.'),
	}),
	writes: [],
	render(args) {
		const { basis } = args;
		const metricKey = revenueBases[basis ?? 'invoiced'];
		return sections(
			`Task: report revenue (Umsatz). ${periodLine(args.dateFrom, args.dateTo)}`,
			basis !== undefined
				? `Basis: ${basis} (${semantics.metrics[metricKey].summary})`
				: `If the user did not say which basis, use the default (${semantics.defaultPolicy.metric}) and state the assumption, or ask whether they mean paid or net revenue.`,
			toolsIntro,
			renderReportingSemantics(['revenue', 'Umsatz', 'earnings'], [metricKey]),
			renderWorkflow(semantics.metrics[metricKey].workflow),
			'Return only the totals and the counts per status from execute, not the voucher rows.',
		);
	},
});

const profitReport = definePrompt({
	name: 'profit-report',
	title: 'Profit report',
	description: 'Report a profit-like result for a period: invoiced revenue minus bookkeeping expenses, with the assumptions stated.',
	useWhen: 'the user asks for profit, Gewinn, earnings or revenue minus expenses of a period from Lexware Office (lexoffice).',
	argsSchema: z.object({
		dateFrom: dateArg('Start'),
		dateTo: dateArg('End'),
	}),
	writes: [],
	render(args) {
		return sections(
			`Task: report profit (revenue minus expenses). ${periodLine(args.dateFrom, args.dateTo)}`,
			toolsIntro,
			renderReportingSemantics(['profit', 'earnings', 'income'], ['grossInvoicedRevenue', 'profitLikeAnalysis']),
			renderWorkflow('calculateInvoicedRevenue'),
			renderWorkflow('listBookkeepingExpenses'),
			'Return only the totals and the counts per voucherType and status from execute, not the voucher rows.',
		);
	},
});

const createInvoice = definePrompt({
	name: 'create-invoice',
	title: 'Create an invoice',
	description: 'Create an invoice: find the contact, build and review a draft, and finalize it only when the user asks.',
	useWhen: 'the user wants to create, draft or finalize an invoice (Rechnung) in Lexware Office (lexoffice).',
	argsSchema: z.object({
		customer: textArg('Customer name, email or customer number. Omitted: ask the user.'),
		details: textArg('What to invoice: line items, quantities, prices, dates, preceding quotation or order.'),
		mode: modeArg,
	}),
	writes: [{ method: 'POST', path: '/v1/invoices' }, { method: 'POST', path: '/v1/invoices', finalize: true }],
	render(args) {
		const { customer, details } = args;
		return sections(
			[
				'Task: create an invoice (POST /v1/invoices).',
				customer !== undefined ? `Customer: ${customer}` : 'Ask the user for the customer.',
				details !== undefined ? `Details: ${details}` : 'Ask the user what to invoice: line items, quantities, prices and dates.',
			].join('\n'),
			'Review before sending: build the body, preview it with execute dryRun: true, and show the user customer, line items, tax conditions and totals. Create a draft unless the user explicitly asks to finalize: a finalized invoice is locked.',
			toolsIntro,
			renderWorkflow('findContact'),
			renderWorkflow('createAndFinalizeSalesDocument'),
		);
	},
});

export const workflowPrompts: WorkflowPrompt[] = [uploadReceipts, revenueReport, profitReport, createInvoice];

// The prompt text for prompts/get. Write prompts start with the server's write mode, so the model doesn't plan writes it can't send.
export const renderPrompt = (prompt: WorkflowPrompt, args: z.infer<WorkflowPrompt['argsSchema']>, context: PromptContext): string =>
	prompt.writes.length > 0 ? sections(writeModeSection(prompt.writes, args.mode === 'preview' ? 'preview' : 'apply', context), prompt.render(args)) : prompt.render(args);
