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

export interface WorkflowPrompt<Args extends z.ZodObject = z.ZodObject<Record<string, z.ZodOptional<z.ZodString | z.ZodEnum>>>> {
	name: string;
	title: string;
	description: string;
	argsSchema: Args;
	// Writes the workflow sends; empty for read-only workflows.
	writes: PromptWrite[];
	render(args: z.infer<Args>, context: PromptContext): string;
}

// Typed render args per prompt; the list below erases them so index.ts can register every prompt alike.
const definePrompt = <Args extends z.ZodObject>(prompt: WorkflowPrompt<Args>) => prompt as unknown as WorkflowPrompt;

const dateArg = (bound: string) => z.string().optional().describe(`${bound} of the voucherDate period, yyyy-MM-dd. Omitted: ask the user.`);
const modeArg = z.enum(['apply', 'preview']).optional().describe('apply (default): send the writes once the checks pass. preview: plan the writes with execute dryRun: true and send none.');

const workflow = (key: string) => {
	const entry = lexwareSpec.workflows[key];
	if (entry === undefined) throw new Error(`Unknown workflow ${key}`);
	return entry;
};

const renderWorkflow = (key: string): string => {
	const { summary, steps, notes } = workflow(key);
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
	return writeAllowViolation(rules, { method: write.method, path: write.path, query, operationId }) !== undefined;
});

// Said up front, so the model doesn't plan writes the server will reject.
const writeModeSection = (writes: PromptWrite[], mode: 'apply' | 'preview' | undefined, context: PromptContext): string => {
	const needed = writes.map(describeWrite).join(', ');
	if (!context.writesEnabled) {
		return `This server is read-only (spec.info.writesEnabled is false) and rejects the writes this workflow needs (${needed}). Do the read-only steps, preview the writes with execute dryRun: true, and tell the user that sending them needs the server started with LEXWARE_OFFICE_ALLOW_WRITES=true.`;
	}
	const blocked = context.writeAllow !== undefined ? blockedWrites(writes, context.writeAllow) : [];
	const policy = blocked.length > 0
		? `LEXWARE_OFFICE_WRITE_ALLOW blocks ${blocked.map(describeWrite).join(', ')} (see spec.info.writePolicy.allow). Preview those writes with execute dryRun: true and tell the user they need to be allowed first.\n\n`
		: '';
	return mode === 'preview'
		? `${policy}Write mode preview: run every execute call that writes with dryRun: true and report its plannedWrites. Send no writes.`
		: `${policy}Write mode apply: send the writes once the checks pass and the user agreed to them; preview a write with execute dryRun: true first when the user should review it.`;
};

const periodLine = (dateFrom: string | undefined, dateTo: string | undefined) =>
	dateFrom !== undefined && dateTo !== undefined
		? `Period: voucherDate ${dateFrom} to ${dateTo}.`
		: 'Ask the user for the period (voucherDate from and to, yyyy-MM-dd) unless it is clear from the conversation.';

const semantics = lexwareSpec.info.financeReportingSemantics;

const renderReportingSemantics = (terms: string[], metrics: string[]): string => [
	'## Reporting semantics (spec.info.financeReportingSemantics)',
	semantics.summary,
	`Default when the user does not specify: ${semantics.defaultPolicy.metric}. ${semantics.defaultPolicy.assumption}`,
	...semantics.defaultPolicy.notes.map((note) => `- ${note}`),
	'',
	'Ambiguous terms:',
	...terms.map((term) => `- ${term}: ${semantics.ambiguousTerms[term]}`),
	'',
	'Metrics:',
	...metrics.flatMap((key) => {
		const metric = semantics.metrics[key];
		return [`- ${key}: ${metric.summary} (workflow ${metric.workflow})`, ...metric.caveats.map((caveat) => `  - ${caveat}`)];
	}),
].join('\n');

const sections = (...parts: Array<string | undefined>) => parts.filter((part) => part !== undefined).join('\n\n');

const uploadWrites: PromptWrite[] = [{ method: 'POST', path: '/v1/files' }, { method: 'PUT', path: '/v1/vouchers/{id}' }];

const uploadReceipts = definePrompt({
	name: 'upload-receipts',
	title: 'Upload receipts (Belege)',
	description: 'Upload receipts to Lexware Office: check for duplicates, upload, wait for text recognition, correct fields and categories without dropping the file, and report per receipt.',
	argsSchema: z.object({
		files: z.string().optional().describe('Absolute paths of the receipts on the server machine, comma- or newline-separated. Omitted: ask the user.'),
		mode: modeArg,
	}),
	writes: uploadWrites,
	render(args, context) {
		const files = args.files?.split(/[,\n]/).map((file) => file.trim()).filter((file) => file.length > 0) ?? [];
		return sections(
			writeModeSection(uploadWrites, args.mode, context),
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
	argsSchema: z.object({
		dateFrom: dateArg('Start'),
		dateTo: dateArg('End'),
		basis: z.enum(['invoiced', 'paid', 'net']).optional().describe('invoiced: gross invoiced/accrual revenue (the default). paid: paid/cash revenue. net: VAT-aware net revenue from invoice details.'),
	}),
	writes: [],
	render(args) {
		const { basis } = args;
		const metricKey = revenueBases[basis ?? 'invoiced'];
		return sections(
			`Task: report revenue (Umsatz). ${periodLine(args.dateFrom, args.dateTo)}`,
			basis !== undefined
				? `Basis: ${basis} (${semantics.metrics[metricKey].summary})`
				: `The user did not choose a basis: use the default (${semantics.defaultPolicy.metric}) and state the assumption, or ask whether they mean paid or net revenue.`,
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

const invoiceWrites: PromptWrite[] = [{ method: 'POST', path: '/v1/invoices' }, { method: 'POST', path: '/v1/invoices', finalize: true }];

const createInvoice = definePrompt({
	name: 'create-invoice',
	title: 'Create an invoice',
	description: 'Create an invoice: find the contact, build and review a draft, and finalize it only when the user asks.',
	argsSchema: z.object({
		customer: z.string().optional().describe('Customer name, email or customer number. Omitted: ask the user.'),
		details: z.string().optional().describe('What to invoice: line items, quantities, prices, dates, preceding quotation or order.'),
		mode: modeArg,
	}),
	writes: invoiceWrites,
	render(args, context) {
		const { customer, details } = args;
		return sections(
			writeModeSection(invoiceWrites, args.mode, context),
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
