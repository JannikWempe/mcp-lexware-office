export interface LexwareApiCatalog {
	info: {
		title: string;
		version: string;
		baseUrl: string;
		docsUrl: string;
		rateLimit: string;
		pagination: LexwarePaginationInfo;
		voucherStatusSemantics: LexwareVoucherStatusSemantics;
		financeReportingSemantics: LexwareFinanceReportingSemantics;
		domainIndex: Record<string, { summary: string; tags: string[]; endpoints: Array<{ method: string; path: string }> }>;
		notes: string[];
		// Injected at runtime by the MCP server: whether POST/PUT/PATCH/DELETE are currently allowed.
		writesEnabled?: boolean;
	};
	paths: Record<string, Partial<Record<HttpMethod, LexwareOperation>>>;
	workflows: Record<string, LexwareWorkflow>;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface LexwareOperation {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	parameters?: LexwareParameter[];
	requestBody?: LexwareRequestBody;
	responses?: Record<string, string>;
	notes?: string[];
	examples?: unknown[];
	capabilities?: LexwareOperationCapabilities;
	docsUrl?: string;
}

export interface LexwareOperationCapabilities {
	write: boolean;
	paginated: boolean;
	multipart: boolean;
	executable: boolean;
}

export interface LexwareParameter {
	name: string;
	in: 'path' | 'query' | 'header';
	required?: boolean;
	type?: string;
	enum?: string[];
	description?: string;
}

export interface LexwareRequestBody {
	contentType: 'application/json' | 'multipart/form-data';
	summary: string;
	required?: string[];
	shape?: unknown;
}

export interface LexwareWorkflow {
	summary: string;
	keywords?: string[];
	steps: string[];
	relatedEndpoints: Array<{ method: string; path: string }>;
	notes?: string[];
	examples?: unknown[];
}

export interface LexwareFinanceReportingSemantics {
	summary: string;
	defaultPolicy: {
		metric: string;
		workflow: string;
		voucherType: string;
		voucherStatus: string;
		amountField: string;
		assumption: string;
		notes: string[];
	};
	ambiguousTerms: Record<string, string>;
	metrics: Record<string, {
		summary: string;
		workflow: string;
		endpoints: Array<{ method: string; path: string }>;
		voucherType?: string;
		voucherStatus?: string;
		amountFields?: string[];
		caveats: string[];
	}>;
	caveats: string[];
	examples: Array<{
		question: string;
		recommendedWorkflow: string;
		assumptions: string;
		query?: Record<string, string>;
		aggregation: string;
		notes?: string[];
	}>;
}

export interface LexwarePaginationInfo {
	summary: string;
	pageShape: string;
	defaultPage: number;
	recommendedSize: number;
	fields: Record<string, string>;
	stopConditions: string[];
	notes: string[];
}

export interface LexwareVoucherStatusSemantics {
	summary: string;
	voucherTypes: Record<string, LexwareVoucherTypeStatusInfo>;
	reportingDefaults: Record<string, LexwareReportingDefault>;
	notes: string[];
}

export interface LexwareVoucherTypeStatusInfo {
	label: string;
	category: 'sales-document' | 'bookkeeping';
	statuses: string[];
	defaultStatuses: string[];
	notes?: string[];
}

export interface LexwareReportingDefault {
	voucherType: string;
	voucherStatus: string;
	summary: string;
	notes?: string[];
}

const idParam = (description = 'Resource UUID'): LexwareParameter => ({
	name: 'id',
	in: 'path',
	required: true,
	type: 'uuid',
	description,
});

const pageParams: LexwareParameter[] = [
	{ name: 'page', in: 'query', type: 'integer', description: 'Zero-based page number. Use 0 for the first page. Paged responses normally include content plus last/totalPages/number metadata.' },
	{ name: 'size', in: 'query', type: 'integer', description: 'Page size. Endpoint-specific maximums apply; lexware.paginate defaults to 250 unless you provide a different size.' },
];

const finalizeParam: LexwareParameter = {
	name: 'finalize',
	in: 'query',
	type: 'boolean',
	description: 'If true, create and immediately finalize/publish the sales document. Finalized documents are locked for editing.',
};

const precedingSalesVoucherParam: LexwareParameter = {
	name: 'precedingSalesVoucherId',
	in: 'query',
	type: 'uuid',
	description: 'Optional/required predecessor sales voucher id, depending on document type/workflow.',
};

const salesVoucherBody: LexwareRequestBody = {
	contentType: 'application/json',
	summary: 'Sales voucher JSON. Common fields: voucherDate, address/contactId, lineItems, totalPrice.currency, taxConditions, shippingConditions, paymentConditions, title, introduction, remark.',
	required: ['voucherDate', 'address', 'lineItems', 'taxConditions'],
	shape: {
		voucherDate: 'YYYY-MM-DD',
		address: { contactId: 'UUID or inline name/address object' },
		lineItems: [{ type: 'custom|material|service', name: 'string', quantity: 1, unitName: 'Stück', unitPrice: { currency: 'EUR', netAmount: 100, taxRatePercentage: 19 } }],
		totalPrice: { currency: 'EUR' },
		taxConditions: { taxType: 'net|gross|vatfree' },
		paymentConditions: 'optional payment target/discount object',
	},
};

const documentResponses = {
	'200': 'JSON document detail or action result',
	'400': 'Validation error',
	'401': 'Missing or invalid API key',
	'403': 'Insufficient permissions',
	'404': 'Resource not found',
	'409': 'Optimistic locking version conflict',
	'429': 'Rate limit exceeded',
};

const pagedResponseShape = 'LexwarePage<T>: { content: T[]; page?: number; size?: number; totalPages?: number; totalElements?: number; number?: number; last?: boolean }. Page numbers are zero-based when present.';
const pagedResponse = (itemName: string): Record<string, string> => ({
	...documentResponses,
	'200': `Paged JSON list of ${itemName}. ${pagedResponseShape}`,
});
const pagedNotes = [
	`Pagination contract: ${pagedResponseShape}`,
	'Use lexware.paginate({ path, query }) for complete list traversal. It defaults page=0 and size=250, collects response.data.content, and stops on last=true, page+1 >= totalPages, or empty content.',
];

const bookkeepingVoucherStatuses = ['unchecked', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit'];
const bookkeepingReportingStatuses = ['unchecked', 'open', 'paid', 'paidoff', 'transferred', 'sepadebit'];

const voucherStatusSemantics: LexwareVoucherStatusSemantics = {
	summary: 'Structured voucherStatus values and recommended defaults for GET /v1/voucherlist. voucherStatus is a comma-separated list of status tokens; valid tokens depend on voucherType.',
	voucherTypes: {
		invoice: {
			label: 'Invoice sales documents',
			category: 'sales-document',
			statuses: ['draft', 'open', 'paid', 'voided'],
			defaultStatuses: ['open', 'paid'],
			notes: ['For accrual/invoiced revenue, use open,paid.', 'For paid/cash revenue, use paid.', 'Exclude draft and voided from revenue unless explicitly requested.', 'Invoices have no paidoff status; paidoff belongs to credit notes and bookkeeping vouchers.', 'Open invoices past their dueDate come back with the transient status overdue, even when filtering voucherStatus=open.'],
		},
		downpaymentinvoice: {
			label: 'Down-payment invoice sales documents',
			category: 'sales-document',
			statuses: ['draft', 'open', 'paid', 'voided'],
			defaultStatuses: ['open', 'paid'],
			notes: ['Read-only via the API: list via voucherlist, retrieve details with GET /v1/down-payment-invoices/{id}.'],
		},
		quotation: {
			label: 'Quotation sales documents',
			category: 'sales-document',
			statuses: ['draft', 'open', 'accepted', 'rejected'],
			defaultStatuses: ['draft', 'open', 'accepted', 'rejected'],
			notes: ['Use draft,open for active quotation pipeline.', 'Use accepted/rejected for outcome analysis.', 'Quotations have no voided status.'],
		},
		orderconfirmation: {
			label: 'Order confirmation sales documents',
			category: 'sales-document',
			statuses: ['draft', 'open'],
			defaultStatuses: ['open'],
			notes: ['Use open for committed non-draft order confirmations.', 'Order confirmations have only draft and open; there is no fulfilled or voided status.'],
		},
		creditnote: {
			label: 'Credit note sales documents',
			category: 'sales-document',
			statuses: ['draft', 'open', 'paidoff', 'voided'],
			defaultStatuses: ['open', 'paidoff'],
			notes: ['Settled credit notes use paidoff (fully paid back to the customer), not paid.', 'Credit notes can reduce revenue/refunds; do not mix them into invoice revenue totals unless the user asked for net sales including credits.', 'Exclude draft and voided by default.'],
		},
		deliverynote: {
			label: 'Delivery note sales documents',
			category: 'sales-document',
			statuses: ['draft', 'open'],
			defaultStatuses: ['open'],
			notes: ['Delivery notes are logistics documents, not revenue. Use invoices for revenue calculations.', 'Delivery notes have only draft and open; there is no fulfilled or voided status.'],
		},
		purchaseinvoice: {
			label: 'Purchase invoice bookkeeping vouchers / expenses',
			category: 'bookkeeping',
			statuses: bookkeepingVoucherStatuses,
			defaultStatuses: bookkeepingReportingStatuses,
			notes: ['Use for expense/cost reporting. Exclude voided by default.'],
		},
		purchasecreditnote: {
			label: 'Purchase credit note bookkeeping vouchers / expense reductions',
			category: 'bookkeeping',
			statuses: bookkeepingVoucherStatuses,
			defaultStatuses: bookkeepingReportingStatuses,
			notes: ['Usually reduces expenses. Ask or state assumptions before combining with purchase invoices. Exclude voided by default.'],
		},
		salesinvoice: {
			label: 'Sales invoice bookkeeping vouchers / income vouchers',
			category: 'bookkeeping',
			statuses: bookkeepingVoucherStatuses,
			defaultStatuses: bookkeepingReportingStatuses,
			notes: ['Bookkeeping voucher status set from the legacy MCP implementation. For sales-document invoices, prefer voucherType=invoice.'],
		},
		salescreditnote: {
			label: 'Sales credit note bookkeeping vouchers / income reductions',
			category: 'bookkeeping',
			statuses: bookkeepingVoucherStatuses,
			defaultStatuses: bookkeepingReportingStatuses,
			notes: ['Usually reduces income/revenue. For sales-document credit notes, prefer voucherType=creditnote when appropriate. Exclude voided by default.'],
		},
	},
	reportingDefaults: {
		invoicedAccrualRevenue: {
			voucherType: 'invoice',
			voucherStatus: 'open,paid',
			summary: 'Gross invoiced/accrual revenue: finalized/open plus paid invoices; excludes draft and voided invoices.',
			notes: ['Includes unpaid open invoices.', 'Returned rows may carry the transient status overdue for open invoices past due; treat overdue as open.', 'State this assumption if the user says earnings/revenue without specifying paid vs invoiced.'],
		},
		paidCashRevenue: {
			voucherType: 'invoice',
			voucherStatus: 'paid',
			summary: 'Paid/cash revenue: only fully paid invoices; excludes open, draft, and voided invoices.',
			notes: ['Voucher date is not necessarily payment date; fetch payments when payment timing matters.'],
		},
		draftPipeline: {
			voucherType: 'invoice',
			voucherStatus: 'draft',
			summary: 'Draft pipeline: draft invoices only; not revenue.',
		},
		invoiceAuditIncludingVoided: {
			voucherType: 'invoice',
			voucherStatus: 'open,draft,paid,voided',
			summary: 'Audit/listing mode: include every known invoice status, including draft and voided.',
			notes: ['Use only when the user asks for all invoices or canceled/voided documents.'],
		},
		bookkeepingExpenses: {
			voucherType: 'purchaseinvoice,purchasecreditnote',
			voucherStatus: bookkeepingReportingStatuses.join(','),
			summary: 'Expense/cost reporting from bookkeeping voucher summaries, excluding voided vouchers by default.',
			notes: ['Purchase credit notes usually reduce expenses; state how you handle them.'],
		},
	},
	notes: [
		'voucherStatus is required by /v1/voucherlist and is passed as comma-separated tokens, not as a JSON array.',
		'Both voucherType and voucherStatus also accept the wildcard value any.',
		'overdue is a transient status for open/sepadebit vouchers past their dueDate. It cannot be combined with other voucherStatus filters, and rows returned when filtering open/sepadebit may carry voucherStatus=overdue.',
		'Do not count voided documents as revenue unless the user explicitly asks for canceled/voided documents.',
		'Do not count draft documents as revenue; draft is useful for pipeline/draft-listing workflows only.',
		'When a user says earnings/revenue/sales without more detail, prefer the invoicedAccrualRevenue default or ask whether they mean paid/cash revenue or net/profit.',
	],
};

const financeReportingSemantics: LexwareFinanceReportingSemantics = {
	summary: 'Finance/reporting questions are domain-ambiguous. Decide whether the user means invoiced vs paid, gross vs net, and revenue vs profit; if not specified, ask or state a conservative default before calculating.',
	defaultPolicy: {
		metric: 'gross invoiced/accrual revenue',
		workflow: 'calculateInvoicedRevenue',
		voucherType: 'invoice',
		voucherStatus: 'open,paid',
		amountField: 'totalAmount from voucherlist summaries',
		assumption: 'Includes finalized/open unpaid invoices plus paid/settled invoices; excludes draft and voided invoices; reports voucherlist summary totals, not VAT-aware net revenue or profit.',
		notes: ['Use this default only when the user asks broad terms like earnings/revenue/sales/Umsatz and does not specify paid/cash, net, or profit.', 'State the assumption in the final answer.', 'Do not default missing financial amount fields to zero; missing fields usually indicate a wrong endpoint or schema drift.'],
	},
	ambiguousTerms: {
		earnings: 'Ambiguous: can mean gross invoiced revenue, paid/cash revenue, net revenue excluding VAT, or profit after expenses. Ask or state the chosen assumption.',
		revenue: 'Usually invoice revenue, but clarify gross vs net and invoiced/accrual vs paid/cash when material.',
		income: 'Often revenue in user language; not necessarily profit. State whether expenses are excluded.',
		profit: 'Requires expense/cost vouchers in addition to invoice revenue; do not answer from invoices alone unless explicitly framed as revenue.',
		Umsatz: 'Usually sales/turnover. Clarify bruto/netto and Soll/Ist (invoiced vs paid) if the result is finance-critical.',
	},
	metrics: {
		grossInvoicedRevenue: {
			summary: 'Fast sales/revenue total from invoice voucher summaries.',
			workflow: 'calculateInvoicedRevenue',
			endpoints: [{ method: 'GET', path: '/v1/voucherlist' }],
			voucherType: 'invoice',
			voucherStatus: 'open,paid',
			amountFields: ['totalAmount', 'openAmount'],
			caveats: ['Sum totalAmount for the revenue total; openAmount is the outstanding/unpaid amount, not an additional revenue field.', 'Includes unpaid open invoices.', 'Excludes drafts and voided invoices by default.', 'Voucherlist has no VAT-aware net amount field; use invoice details for net revenue.'],
		},
		paidRevenue: {
			summary: 'Cash/paid revenue from paid and settled invoice summaries.',
			workflow: 'calculatePaidRevenue',
			endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'GET', path: '/v1/payments/{voucherId}' }],
			voucherType: 'invoice',
			voucherStatus: 'paid',
			amountFields: ['totalAmount', 'openAmount'],
			caveats: ['Sum totalAmount only for paid/settled summaries; openAmount is outstanding/unpaid amount, not revenue.', 'Voucher date filters may not equal payment-date filters.', 'Use /v1/payments/{voucherId} when exact payment timing or partial payments matter.'],
		},
		netRevenue: {
			summary: 'VAT-aware net revenue from invoice details after voucherlist discovery.',
			workflow: 'calculateNetRevenueFromInvoiceDetails',
			endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'GET', path: '/v1/invoices/{id}' }],
			voucherType: 'invoice',
			voucherStatus: 'open,paid',
			amountFields: ['net line item or tax summary fields from actual invoice detail payload'],
			caveats: ['Requires fetching invoice details and respecting the actual tax/line-item shape returned by the API.', 'Never estimate net revenue by dividing gross by 1.19 unless the user explicitly accepts an approximation.'],
		},
		profitLikeAnalysis: {
			summary: 'Profit/P&L-like analysis needs revenue and expenses, not invoices alone.',
			workflow: 'listBookkeepingExpenses',
			endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'GET', path: '/v1/vouchers/{id}' }, { method: 'GET', path: '/v1/posting-categories' }],
			voucherType: 'invoice + purchaseinvoice,purchasecreditnote',
			voucherStatus: 'invoice=open,paid; expenses exclude voided by default',
			amountFields: ['invoice voucherlist totalAmount', 'bookkeeping voucher totals/categories'],
			caveats: ['Ask how to treat purchase credit notes and sales credit notes.', 'Profit requires expense/cost categorization and may require tax/accounting treatment outside voucherlist summaries.'],
		},
	},
	caveats: [
		'Simple revenue summaries should be composed with search + execute: search voucherlist/reporting workflows, paginate /v1/voucherlist, then aggregate the needed fields in sandbox code.',
		'/v1/voucherlist is suitable for fast listing and summary aggregation with totalAmount/openAmount, but it does not contain VAT-aware net revenue fields.',
		'Observed voucherlist summary amount fields: totalAmount (summary total) and openAmount (outstanding amount). Voucherlist summaries do not include VAT-aware net/gross detail totals; those belong to sales-document detail payloads, not voucherlist rows.',
		'Net revenue requires GET /v1/invoices/{id} fan-out and summing line items/tax totals according to the actual detail payload.',
		'“Earnings” is ambiguous; ask whether the user means gross/net and invoiced/paid, or explicitly state the chosen default.',
		'Do not approximate net revenue as gross / 1.19 unless the user explicitly accepts a rough estimate.',
		'Profit-like answers require expenses/costs; invoice revenue alone is not profit.',
	],
	examples: [
		{
			question: 'What did I earn in 2026?',
			recommendedWorkflow: 'calculateInvoicedRevenue',
			assumptions: 'Gross invoiced/accrual revenue, excluding draft and voided invoices, including unpaid open invoices.',
			query: { voucherType: 'invoice', voucherStatus: 'open,paid', voucherDateFrom: '2026-01-01', voucherDateTo: '2026-12-31' },
			aggregation: 'Paginate /v1/voucherlist and sum totalAmount with strict missing-field checks.',
			notes: ['If the user expected paid or net revenue, rerun with the corresponding workflow.'],
		},
		{
			question: 'What paid revenue did I receive in 2026?',
			recommendedWorkflow: 'calculatePaidRevenue',
			assumptions: 'Paid/cash revenue from invoices with paid status; voucher date period unless payment-date details are fetched.',
			query: { voucherType: 'invoice', voucherStatus: 'paid', voucherDateFrom: '2026-01-01', voucherDateTo: '2026-12-31' },
			aggregation: 'Paginate /v1/voucherlist and sum totalAmount with strict missing-field checks; inspect /v1/payments/{voucherId} if exact payment dates matter.',
		},
		{
			question: 'What was my net revenue in 2026?',
			recommendedWorkflow: 'calculateNetRevenueFromInvoiceDetails',
			assumptions: 'VAT-aware/tax-exclusive revenue, not a gross/1.19 approximation.',
			query: { voucherType: 'invoice', voucherStatus: 'open,paid', voucherDateFrom: '2026-01-01', voucherDateTo: '2026-12-31' },
			aggregation: 'Use voucherlist to discover invoice ids, fetch each /v1/invoices/{id}, and sum net fields from the actual detail payload.',
		},
	],
};

export const lexwareSpec: LexwareApiCatalog = {
	info: {
		title: 'Lexware Office Public API',
		version: 'openapi-lite-v0',
		baseUrl: 'https://api.lexware.io',
		docsUrl: 'https://developers.lexware.io/docs/#lexware-api-documentation',
		rateLimit: '2 requests/second across all resource endpoints',
		pagination: {
			summary: 'Paged list endpoints return a LexwarePage<T> JSON object. Use lexware.paginate for complete traversal instead of probing live page shape or inventing arbitrary page caps.',
			pageShape: pagedResponseShape,
			defaultPage: 0,
			recommendedSize: 250,
			fields: {
				content: 'Array of items for the current page.',
				page: 'Zero-based page number when returned by the endpoint.',
				number: 'Alternative zero-based page number field used by some paged responses.',
				size: 'Page size returned by the endpoint.',
				totalPages: 'Total page count when available.',
				totalElements: 'Total item count when available.',
				last: 'True when this is the final page.',
			},
			stopConditions: ['data.last === true', 'page + 1 >= data.totalPages when totalPages is numeric', 'data.content.length === 0', 'the execute tool maxRequests guard is reached', 'optional lexware.paginate options.maxPages is reached'],
			notes: ['Do not cap pagination arbitrarily unless you state it. For finance/reporting, prefer fetching all pages needed for the requested date/status filter.', 'The API caps list traversal at 10,000 entries per filter; beyond that it fails with "Maximum search window size exceeded". Narrow date ranges or other filters and traverse in chunks when a result set can exceed 10,000 entries.', 'Date filters are supplied as query parameters; confirm inclusivity with official docs or state assumptions if the exact boundary semantics matter.'],
		},
		voucherStatusSemantics,
		financeReportingSemantics,
		domainIndex: {
			contacts: { summary: 'Customers, vendors, companies, and people.', tags: ['contacts', 'customers', 'vendors'], endpoints: [{ method: 'GET', path: '/v1/contacts' }, { method: 'POST', path: '/v1/contacts' }, { method: 'GET', path: '/v1/contacts/{id}' }, { method: 'PUT', path: '/v1/contacts/{id}' }] },
			articles: { summary: 'Product/service catalog entries.', tags: ['articles', 'catalog'], endpoints: [{ method: 'GET', path: '/v1/articles' }, { method: 'POST', path: '/v1/articles' }, { method: 'GET', path: '/v1/articles/{id}' }, { method: 'PUT', path: '/v1/articles/{id}' }, { method: 'DELETE', path: '/v1/articles/{id}' }] },
			invoices: { summary: 'Sales invoices: create via /v1/invoices, list via voucherlist, retrieve details/files by id.', tags: ['invoices', 'sales-documents'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'POST', path: '/v1/invoices' }, { method: 'GET', path: '/v1/invoices/{id}' }, { method: 'GET', path: '/v1/invoices/{id}/file' }] },
			quotations: { summary: 'Quotations/offers (Angebote): create via /v1/quotations, list via voucherlist with voucherType=quotation.', tags: ['quotations', 'offers', 'angebote', 'sales-documents'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'POST', path: '/v1/quotations' }, { method: 'GET', path: '/v1/quotations/{id}' }, { method: 'GET', path: '/v1/quotations/{id}/file' }] },
			'order-confirmations': { summary: 'Order confirmations (Auftragsbestätigungen): create via /v1/order-confirmations, list via voucherlist with voucherType=orderconfirmation.', tags: ['order-confirmations', 'auftragsbestaetigungen', 'sales-documents'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'POST', path: '/v1/order-confirmations' }, { method: 'GET', path: '/v1/order-confirmations/{id}' }, { method: 'GET', path: '/v1/order-confirmations/{id}/file' }] },
			'credit-notes': { summary: 'Sales credit notes (Gutschriften): create via /v1/credit-notes, list via voucherlist with voucherType=creditnote.', tags: ['credit-notes', 'gutschriften', 'refunds', 'sales-documents'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'POST', path: '/v1/credit-notes' }, { method: 'GET', path: '/v1/credit-notes/{id}' }, { method: 'GET', path: '/v1/credit-notes/{id}/file' }] },
			'delivery-notes': { summary: 'Delivery notes (Lieferscheine): create via /v1/delivery-notes, list via voucherlist with voucherType=deliverynote.', tags: ['delivery-notes', 'lieferscheine', 'logistics', 'sales-documents'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'POST', path: '/v1/delivery-notes' }, { method: 'GET', path: '/v1/delivery-notes/{id}' }, { method: 'GET', path: '/v1/delivery-notes/{id}/file' }] },
			dunnings: { summary: 'Dunning notices (Mahnungen) for overdue invoices. No list endpoint; find ids via the invoice relatedVouchers.', tags: ['dunnings', 'mahnungen', 'reminders', 'sales-documents'], endpoints: [{ method: 'POST', path: '/v1/dunnings' }, { method: 'GET', path: '/v1/dunnings/{id}' }, { method: 'GET', path: '/v1/dunnings/{id}/file' }] },
			'down-payment-invoices': { summary: 'Down-payment invoices (Abschlagsrechnungen), read-only: list via voucherlist with voucherType=downpaymentinvoice.', tags: ['down-payment-invoices', 'abschlagsrechnungen', 'sales-documents'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }, { method: 'GET', path: '/v1/down-payment-invoices/{id}' }, { method: 'GET', path: '/v1/down-payment-invoices/{id}/file' }] },
			'recurring-templates': { summary: 'Recurring invoice templates (wiederkehrende Rechnungen), read-only.', tags: ['recurring-templates', 'recurring-invoices', 'subscriptions', 'invoices'], endpoints: [{ method: 'GET', path: '/v1/recurring-templates' }, { method: 'GET', path: '/v1/recurring-templates/{id}' }] },
			voucherlist: { summary: 'Aggregation-friendly voucher summaries for reporting, sales, revenue/Umsatz, and expenses.', tags: ['voucherlist', 'reporting', 'finance'], endpoints: [{ method: 'GET', path: '/v1/voucherlist' }] },
			vouchers: { summary: 'Bookkeeping vouchers and expense documents.', tags: ['vouchers', 'bookkeeping'], endpoints: [{ method: 'GET', path: '/v1/vouchers' }, { method: 'POST', path: '/v1/vouchers' }, { method: 'GET', path: '/v1/vouchers/{id}' }, { method: 'PUT', path: '/v1/vouchers/{id}' }] },
			files: { summary: 'File upload/download and document PDFs/XML. Binary downloads return metadata by default.', tags: ['files', 'documents'], endpoints: [{ method: 'POST', path: '/v1/files' }, { method: 'GET', path: '/v1/files/{id}' }, { method: 'POST', path: '/v1/vouchers/{id}/files' }] },
			payments: { summary: 'Payment information for a voucher/invoice.', tags: ['payments', 'voucher-payments'], endpoints: [{ method: 'GET', path: '/v1/payments/{voucherId}' }] },
			'payment-conditions': { summary: 'Payment terms / Zahlungsbedingungen reference data for sales documents.', tags: ['payment-conditions', 'payment-terms', 'zahlungsbedingungen', 'reference-data'], endpoints: [{ method: 'GET', path: '/v1/payment-conditions' }] },
			webhooks: { summary: 'Webhook/event subscription management.', tags: ['event-subscriptions', 'webhooks'], endpoints: [{ method: 'GET', path: '/v1/event-subscriptions' }, { method: 'POST', path: '/v1/event-subscriptions' }, { method: 'GET', path: '/v1/event-subscriptions/{subscriptionId}' }, { method: 'DELETE', path: '/v1/event-subscriptions/{subscriptionId}' }] },
			'reference-data': { summary: 'Company profile, countries, posting categories, payment conditions, print layouts.', tags: ['reference-data', 'profile', 'countries', 'posting-categories', 'print-layouts'], endpoints: [{ method: 'GET', path: '/v1/profile' }, { method: 'GET', path: '/v1/countries' }, { method: 'GET', path: '/v1/posting-categories' }, { method: 'GET', path: '/v1/payment-conditions' }, { method: 'GET', path: '/v1/print-layouts' }] },
		},
		notes: [
			'Lexware does not publish a complete official OpenAPI document; this catalog is curated from official docs plus the legacy MCP implementation.',
			'The documented API host is https://api.lexware.io; the pre-rebranding https://api.lexoffice.io gateway was sunset in December 2025.',
			'Responses are normally JSON. File endpoints can return PDF/XML/binary and need special handling to avoid token bloat.',
			'Pagination is zero-based: page=0 is the first page. Paged list endpoints return response.data.content plus metadata such as last, totalPages, totalElements, number/page, and size; use lexware.paginate for complete traversal.',
			'Voucherlist status semantics and reporting defaults live in spec.info.voucherStatusSemantics. Use them before choosing voucherStatus for finance/reporting workflows.',
			'Finance/reporting caveats and examples live in spec.info.financeReportingSemantics. Use them before answering ambiguous earnings/revenue/Umsatz/profit questions.',
			'Updates use optimistic locking via a version field; on HTTP 409, re-fetch the resource and retry with the current version.',
			'spec.info.writesEnabled reports whether this server currently allows POST/PUT/PATCH/DELETE; check it before planning writes or uploads.',
			'File uploads go through the multipart request field of lexware.request (contentPath for local files, contentBase64 for base64 bytes) — see the fileHandling workflow.',
		],
	},
	paths: {
		'/v1/articles': {
			get: {
				operationId: 'listArticles',
				tags: ['articles', 'catalog', 'read'],
				summary: 'List/filter articles',
				description: 'Returns a paged list of product/service articles matching all provided filters.',
				parameters: [
					...pageParams,
					{ name: 'articleNumber', in: 'query', type: 'string', description: 'Exact article number filter.' },
					{ name: 'gtin', in: 'query', type: 'string', description: 'GTIN filter.' },
					{ name: 'type', in: 'query', type: 'string', enum: ['PRODUCT', 'SERVICE'], description: 'Article type filter.' },
				],
				responses: pagedResponse('articles'),
				notes: pagedNotes,
				docsUrl: 'https://developers.lexware.io/docs/#articles-endpoint-filtering-articles',
			},
			post: {
				operationId: 'createArticle',
				tags: ['articles', 'catalog', 'write'],
				summary: 'Create an article',
				requestBody: {
					contentType: 'application/json',
					summary: 'Article JSON with title, type, unitName, and price. Optional: description, articleNumber, gtin, note.',
					required: ['title', 'type', 'unitName', 'price'],
					shape: { title: 'string', type: 'PRODUCT|SERVICE', unitName: 'Stück|hour|...', price: { netPrice: 100, grossPrice: 119, leadingPrice: 'NET|GROSS', taxRate: 19 } },
				},
				examples: [{ title: 'Consulting', type: 'SERVICE', unitName: 'hour', price: { netPrice: 100, leadingPrice: 'NET', taxRate: 19 } }],
				responses: documentResponses,
				docsUrl: 'https://developers.lexware.io/docs/#articles-endpoint-create-an-article',
			},
		},
		'/v1/articles/{id}': {
			get: {
				operationId: 'getArticle',
				tags: ['articles', 'catalog', 'read'],
				summary: 'Retrieve one article',
				parameters: [idParam('Article UUID')],
				responses: documentResponses,
				docsUrl: 'https://developers.lexware.io/docs/#articles-endpoint-retrieve-an-article',
			},
			put: {
				operationId: 'updateArticle',
				tags: ['articles', 'catalog', 'write'],
				summary: 'Update an article',
				parameters: [idParam('Article UUID')],
				requestBody: { contentType: 'application/json', summary: 'Full article JSON including current version for optimistic locking.', required: ['title', 'type', 'unitName', 'price', 'version'] },
				responses: documentResponses,
				notes: ['On 409 conflict, retrieve the article again and retry with its current version.'],
				docsUrl: 'https://developers.lexware.io/docs/#articles-endpoint-update-an-article',
			},
			delete: {
				operationId: 'deleteArticle',
				tags: ['articles', 'catalog', 'write'],
				summary: 'Delete an article',
				parameters: [idParam('Article UUID')],
				responses: { ...documentResponses, '204': 'Deleted successfully' },
				docsUrl: 'https://developers.lexware.io/docs/#articles-endpoint-delete-an-article',
			},
		},
		'/v1/contacts': {
			get: {
				operationId: 'listContacts',
				tags: ['contacts', 'customers', 'vendors', 'read'],
				summary: 'List/filter contacts',
				description: 'Returns contacts where all provided filters match.',
				parameters: [
					...pageParams,
					{ name: 'email', in: 'query', type: 'string', description: 'Matches emailAddresses and company contactPersons. Minimum 3 characters. Supports % and _ wildcards; escape them with backslash for literal matching.' },
					{ name: 'name', in: 'query', type: 'string', description: 'Matches company/person name. Minimum 3 characters. Supports % and _ wildcards.' },
					{ name: 'number', in: 'query', type: 'integer', description: 'Customer or vendor number.' },
					{ name: 'customer', in: 'query', type: 'boolean', description: 'true: only customer contacts; false: contacts without customer role.' },
					{ name: 'vendor', in: 'query', type: 'boolean', description: 'true: only vendor contacts; false: contacts without vendor role.' },
				],
				responses: pagedResponse('contacts'),
				notes: pagedNotes,
				docsUrl: 'https://developers.lexware.io/docs/#contacts-endpoint-filtering-contacts',
			},
			post: {
				operationId: 'createContact',
				tags: ['contacts', 'customers', 'vendors', 'write'],
				summary: 'Create a contact',
				requestBody: {
					contentType: 'application/json',
					summary: 'Contact JSON with version:0, roles.customer and/or roles.vendor, and either company or person data.',
					required: ['version', 'roles'],
					shape: { version: 0, roles: { customer: {}, vendor: {} }, company: { name: 'Company name' }, person: { firstName: 'Ada', lastName: 'Lovelace' }, emailAddresses: { business: ['ada@example.org'] } },
				},
				examples: [{ version: 0, roles: { customer: {} }, person: { firstName: 'Ada', lastName: 'Lovelace' }, emailAddresses: { business: ['ada@example.org'] } }],
				responses: documentResponses,
				notes: ['Each contact must have at least one role: customer or vendor.', 'For a company contact, company.name is required. For a person contact, person.lastName is required.'],
				docsUrl: 'https://developers.lexware.io/docs/#contacts-endpoint-create-a-contact',
			},
		},
		'/v1/contacts/{id}': {
			get: {
				operationId: 'getContact',
				tags: ['contacts', 'customers', 'vendors', 'read'],
				summary: 'Retrieve one contact',
				parameters: [idParam('Contact UUID')],
				responses: documentResponses,
				docsUrl: 'https://developers.lexware.io/docs/#contacts-endpoint-retrieve-a-contact',
			},
			put: {
				operationId: 'updateContact',
				tags: ['contacts', 'customers', 'vendors', 'write'],
				summary: 'Update a contact',
				parameters: [idParam('Contact UUID')],
				requestBody: { contentType: 'application/json', summary: 'Full contact JSON including current version for optimistic locking.', required: ['version', 'roles'] },
				responses: documentResponses,
				notes: ['List-valued properties are overwritten as a whole: addresses.*, emailAddresses.*, phoneNumbers.*, company.contactPersons.', 'On 409 conflict, re-fetch the contact and retry with the current version.'],
				docsUrl: 'https://developers.lexware.io/docs/#contacts-endpoint-update-a-contact',
			},
		},
		'/v1/voucherlist': {
			get: {
				operationId: 'listVoucherSummaries',
				tags: ['voucherlist', 'reporting', 'finance', 'revenue', 'sales', 'earnings', 'income', 'turnover', 'umsatz', 'expenses', 'sales-documents', 'invoices', 'quotations', 'order-confirmations', 'credit-notes', 'delivery-notes', 'bookkeeping', 'read'],
				summary: 'List voucher summaries for reporting, invoices, sales, revenue, turnover/Umsatz, income/earnings, and expenses',
				description: 'Primary aggregation-friendly endpoint for finance/reporting workflows. Use it to list invoices, calculate invoiced or paid revenue from summary totals, inspect sales/turnover/Umsatz, and list bookkeeping expense voucher summaries. Do not assume GET /v1/invoices lists invoices; list invoices with voucherType=invoice here and retrieve details from /v1/invoices/{id}.',
				parameters: [
					...pageParams,
					{ name: 'voucherType', in: 'query', required: true, type: 'string', description: `Comma-separated voucher/document types, or the wildcard value any. Valid tokens: ${Object.keys(voucherStatusSemantics.voucherTypes).join(', ')}. Dunnings are not listable here. Inspect spec.info.voucherStatusSemantics.voucherTypes for valid voucherStatus values per voucherType.` },
					{ name: 'voucherStatus', in: 'query', required: true, type: 'string', description: 'Comma-separated status tokens, or the wildcard value any. Valid tokens: draft, open, overdue, paid, paidoff, voided, transferred, sepadebit, accepted, rejected, unchecked. Valid values depend on voucherType; see spec.info.voucherStatusSemantics. overdue is transient (open/sepadebit past dueDate) and cannot be combined with other status tokens. Reporting defaults: invoiced revenue=open,paid; paid revenue=paid; draft pipeline=draft; exclude voided from revenue unless explicitly requested.' },
					{ name: 'voucherDateFrom', in: 'query', type: 'date', description: 'Lower voucher date bound, format yyyy-MM-dd. References a full day in CET/CEST.' },
					{ name: 'voucherDateTo', in: 'query', type: 'date', description: 'Upper voucher date bound, format yyyy-MM-dd. References a full day in CET/CEST.' },
					{ name: 'createdDateFrom', in: 'query', type: 'date', description: 'Lower bound on the date the voucher was created, format yyyy-MM-dd.' },
					{ name: 'createdDateTo', in: 'query', type: 'date', description: 'Upper bound on the date the voucher was created, format yyyy-MM-dd.' },
					{ name: 'updatedDateFrom', in: 'query', type: 'date', description: 'Lower bound on the date the voucher was last modified, format yyyy-MM-dd.' },
					{ name: 'updatedDateTo', in: 'query', type: 'date', description: 'Upper bound on the date the voucher was last modified, format yyyy-MM-dd.' },
					{ name: 'contactId', in: 'query', type: 'uuid', description: 'Filter by contact id.' },
					{ name: 'voucherNumber', in: 'query', type: 'string', description: 'Filter by the voucher number.' },
					{ name: 'archived', in: 'query', type: 'boolean', description: 'Filter by archived flag.' },
					{ name: 'sort', in: 'query', type: 'string', description: 'Sort property: voucherDate, voucherNumber, createdDate, or updatedDate; direction appended after a comma, e.g. voucherDate,DESC.' },
				],
				responses: pagedResponse('voucher summaries'),
				notes: [
					...pagedNotes,
					'For complete reporting, paginate every matching page rather than stopping after an arbitrary cap. Prefer lexware.paginate unless you need per-page metadata.',
					'The API refuses to traverse beyond 10,000 matching entries ("Maximum search window size exceeded"); split the period into smaller voucherDateFrom/voucherDateTo chunks when a filter can match more.',
					'Rows returned when filtering voucherStatus=open or sepadebit may carry the transient status overdue (past dueDate); treat overdue rows as open when aggregating.',
					'Common page fields observed/documented for agents: content contains voucher summary rows; last tells you when traversal is complete; totalPages/totalElements may be present for completeness checks.',
					'Use spec.info.voucherStatusSemantics before choosing voucherStatus. For gross invoiced/accrual revenue, use voucherType=invoice&voucherStatus=open,paid. For paid/cash revenue, use paid. For all-invoice audits, include draft and voided only when requested.',
					'Observed voucherlist summary amount fields: totalAmount (summary total) and openAmount (outstanding amount). openAmount is not additional revenue.',
					'Voucherlist summaries do not include VAT-aware net amount fields; fetch /v1/invoices/{id} details when net/tax-exclusive revenue is required.',
					'Do not default missing financial amount fields to zero; missing fields usually indicate a wrong endpoint or schema drift.',
				],
				examples: [
					{ purpose: 'Gross invoiced/accrual revenue default', path: '/v1/voucherlist?voucherType=invoice&voucherStatus=open,paid&page=0&size=250' },
					{ purpose: 'All invoice statuses for audit/listing', path: '/v1/voucherlist?voucherType=invoice&voucherStatus=open,draft,paid,voided&page=0&size=25' },
				],
				docsUrl: 'https://developers.lexware.io/docs/#voucherlist-endpoint-retrieve-and-filter-voucherlist',
			},
		},
		'/v1/invoices': {
			post: {
				operationId: 'createInvoice',
				tags: ['invoices', 'sales-documents', 'write'],
				summary: 'Create a draft or finalized invoice',
				parameters: [finalizeParam, precedingSalesVoucherParam],
				requestBody: salesVoucherBody,
				responses: documentResponses,
				notes: ['Use /v1/voucherlist?voucherType=invoice... to list invoices.', 'Use finalize=true to immediately publish/finalize the invoice.'],
				docsUrl: 'https://developers.lexware.io/docs/#invoices-endpoint-create-an-invoice',
			},
		},
		'/v1/invoices/{id}': {
			get: {
				operationId: 'getInvoice',
				tags: ['invoices', 'sales-documents', 'read'],
				summary: 'Retrieve one invoice',
				parameters: [idParam('Invoice UUID')],
				responses: documentResponses,
				docsUrl: 'https://developers.lexware.io/docs/#invoices-endpoint-retrieve-an-invoice',
			},
		},
		'/v1/invoices/{id}/document': {
			get: { operationId: 'getInvoiceDocumentMetadata', tags: ['invoices', 'documents', 'read'], summary: 'Retrieve invoice document metadata / render reference', parameters: [idParam('Invoice UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#invoices-endpoint-retrieve-an-invoice-document' },
		},
		'/v1/invoices/{id}/file': {
			get: { operationId: 'downloadInvoicePdf', tags: ['invoices', 'files', 'documents', 'read'], summary: 'Download finalized invoice PDF', parameters: [idParam('Invoice UUID')], responses: { '200': 'PDF/binary file', '404': 'Not found or PDF not rendered/finalized yet' }, notes: ['May fail if the PDF has not been rendered/finalized. Avoid returning huge base64 payloads directly to the model.'], docsUrl: 'https://developers.lexware.io/docs/#invoices-endpoint-retrieve-an-invoice-file' },
		},
		'/v1/quotations': {
			post: { operationId: 'createQuotation', tags: ['quotations', 'sales-documents', 'write'], summary: 'Create a draft or finalized quotation', parameters: [finalizeParam], requestBody: { ...salesVoucherBody, summary: 'Quotation JSON. Common sales voucher fields plus optional expirationDate.' }, responses: documentResponses, notes: ['Use /v1/voucherlist?voucherType=quotation... to list quotations.'], docsUrl: 'https://developers.lexware.io/docs/#quotations-endpoint-create-a-quotation' },
		},
		'/v1/quotations/{id}': {
			get: { operationId: 'getQuotation', tags: ['quotations', 'sales-documents', 'read'], summary: 'Retrieve one quotation', parameters: [idParam('Quotation UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#quotations-endpoint-retrieve-a-quotation' },
		},
		'/v1/quotations/{id}/document': {
			get: { operationId: 'getQuotationDocumentMetadata', tags: ['quotations', 'documents', 'read'], summary: 'Retrieve quotation document metadata / render reference', parameters: [idParam('Quotation UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#quotations-endpoint-retrieve-a-quotation-document' },
		},
		'/v1/quotations/{id}/file': {
			get: { operationId: 'downloadQuotationPdf', tags: ['quotations', 'files', 'documents', 'read'], summary: 'Download finalized quotation PDF', parameters: [idParam('Quotation UUID')], responses: { '200': 'PDF/binary file' }, docsUrl: 'https://developers.lexware.io/docs/#quotations-endpoint-retrieve-a-quotation-file' },
		},
		'/v1/order-confirmations': {
			post: { operationId: 'createOrderConfirmation', tags: ['order-confirmations', 'sales-documents', 'write'], summary: 'Create a draft or finalized order confirmation', parameters: [finalizeParam, precedingSalesVoucherParam], requestBody: salesVoucherBody, responses: documentResponses, notes: ['Use /v1/voucherlist?voucherType=orderconfirmation... to list order confirmations.'], docsUrl: 'https://developers.lexware.io/docs/#order-confirmations-endpoint-create-an-order-confirmation' },
		},
		'/v1/order-confirmations/{id}': {
			get: { operationId: 'getOrderConfirmation', tags: ['order-confirmations', 'sales-documents', 'read'], summary: 'Retrieve one order confirmation', parameters: [idParam('Order confirmation UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#order-confirmations-endpoint-retrieve-an-order-confirmation' },
		},
		'/v1/order-confirmations/{id}/document': {
			get: { operationId: 'getOrderConfirmationDocumentMetadata', tags: ['order-confirmations', 'documents', 'read'], summary: 'Retrieve order confirmation document metadata / render reference', parameters: [idParam('Order confirmation UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#order-confirmations-endpoint-retrieve-an-order-confirmation-document' },
		},
		'/v1/order-confirmations/{id}/file': {
			get: { operationId: 'downloadOrderConfirmationPdf', tags: ['order-confirmations', 'files', 'documents', 'read'], summary: 'Download finalized order confirmation PDF', parameters: [idParam('Order confirmation UUID')], responses: { '200': 'PDF/binary file' }, docsUrl: 'https://developers.lexware.io/docs/#order-confirmations-endpoint-retrieve-an-order-confirmation-file' },
		},
		'/v1/credit-notes': {
			post: { operationId: 'createCreditNote', tags: ['credit-notes', 'sales-documents', 'write'], summary: 'Create a draft or finalized credit note', parameters: [finalizeParam, precedingSalesVoucherParam], requestBody: salesVoucherBody, responses: documentResponses, notes: ['Use /v1/voucherlist?voucherType=creditnote... to list credit notes. With precedingSalesVoucherId, the referenced voucher must be valid for credit-note creation.'], docsUrl: 'https://developers.lexware.io/docs/#credit-notes-endpoint-create-a-credit-note' },
		},
		'/v1/credit-notes/{id}': {
			get: { operationId: 'getCreditNote', tags: ['credit-notes', 'sales-documents', 'read'], summary: 'Retrieve one credit note', parameters: [idParam('Credit note UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#credit-notes-endpoint-retrieve-a-credit-note' },
		},
		'/v1/credit-notes/{id}/document': {
			get: { operationId: 'getCreditNoteDocumentMetadata', tags: ['credit-notes', 'documents', 'read'], summary: 'Retrieve credit note document metadata / render reference', parameters: [idParam('Credit note UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#credit-notes-endpoint-retrieve-a-credit-note-document' },
		},
		'/v1/credit-notes/{id}/file': {
			get: { operationId: 'downloadCreditNotePdf', tags: ['credit-notes', 'files', 'documents', 'read'], summary: 'Download finalized credit note PDF', parameters: [idParam('Credit note UUID')], responses: { '200': 'PDF/binary file' }, docsUrl: 'https://developers.lexware.io/docs/#credit-notes-endpoint-retrieve-a-credit-note-file' },
		},
		'/v1/delivery-notes': {
			post: { operationId: 'createDeliveryNote', tags: ['delivery-notes', 'sales-documents', 'write'], summary: 'Create a draft or finalized delivery note', parameters: [finalizeParam, precedingSalesVoucherParam], requestBody: { ...salesVoucherBody, summary: 'Delivery note JSON. Line items usually omit unitPrice because this is a logistics document.' }, responses: documentResponses, notes: ['Use /v1/voucherlist?voucherType=deliverynote... to list delivery notes.'], docsUrl: 'https://developers.lexware.io/docs/#delivery-notes-endpoint-create-a-delivery-note' },
		},
		'/v1/delivery-notes/{id}': {
			get: { operationId: 'getDeliveryNote', tags: ['delivery-notes', 'sales-documents', 'read'], summary: 'Retrieve one delivery note', parameters: [idParam('Delivery note UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#delivery-notes-endpoint-retrieve-a-delivery-note' },
		},
		'/v1/delivery-notes/{id}/document': {
			get: { operationId: 'getDeliveryNoteDocumentMetadata', tags: ['delivery-notes', 'documents', 'read'], summary: 'Retrieve delivery note document metadata / render reference', parameters: [idParam('Delivery note UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#delivery-notes-endpoint-retrieve-a-delivery-note-document' },
		},
		'/v1/delivery-notes/{id}/file': {
			get: { operationId: 'downloadDeliveryNotePdf', tags: ['delivery-notes', 'files', 'documents', 'read'], summary: 'Download finalized delivery note PDF', parameters: [idParam('Delivery note UUID')], responses: { '200': 'PDF/binary file' }, docsUrl: 'https://developers.lexware.io/docs/#delivery-notes-endpoint-retrieve-a-delivery-note-file' },
		},
		'/v1/dunnings': {
			post: { operationId: 'createDunning', tags: ['dunnings', 'sales-documents', 'write'], summary: 'Create a dunning notice for an invoice', parameters: [{ ...precedingSalesVoucherParam, required: true }, finalizeParam], requestBody: salesVoucherBody, responses: documentResponses, notes: ['The API does not support listing dunnings.', 'Dunning creation requires an invoice as precedingSalesVoucherId.', 'Legacy MCP observation: Lexware returns voucherStatus:"draft" for dunnings regardless of finalize=true, while a PDF is generated immediately.'], docsUrl: 'https://developers.lexware.io/docs/#dunnings-endpoint-create-a-dunning' },
		},
		'/v1/dunnings/{id}': {
			get: { operationId: 'getDunning', tags: ['dunnings', 'sales-documents', 'read'], summary: 'Retrieve one dunning notice', parameters: [idParam('Dunning UUID')], responses: documentResponses, notes: ['No list endpoint exists. Find dunning ids through relatedVouchers on the referenced invoice.'], docsUrl: 'https://developers.lexware.io/docs/#dunnings-endpoint-retrieve-a-dunning' },
		},
		'/v1/dunnings/{id}/document': {
			get: { operationId: 'getDunningDocumentMetadata', tags: ['dunnings', 'documents', 'read'], summary: 'Retrieve dunning document metadata / render reference', parameters: [idParam('Dunning UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#dunnings-endpoint-retrieve-a-dunning-document' },
		},
		'/v1/dunnings/{id}/file': {
			get: { operationId: 'downloadDunningPdf', tags: ['dunnings', 'files', 'documents', 'read'], summary: 'Download dunning PDF', parameters: [idParam('Dunning UUID')], responses: { '200': 'PDF/binary file' }, docsUrl: 'https://developers.lexware.io/docs/#dunnings-endpoint-retrieve-a-dunning-file' },
		},
		'/v1/down-payment-invoices/{id}': {
			get: { operationId: 'getDownPaymentInvoice', tags: ['down-payment-invoices', 'sales-documents', 'read'], summary: 'Retrieve one down-payment invoice', parameters: [idParam('Down-payment invoice UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#down-payment-invoices-endpoint-retrieve-a-down-payment-invoice' },
		},
		'/v1/down-payment-invoices/{id}/file': {
			get: { operationId: 'downloadDownPaymentInvoicePdf', tags: ['down-payment-invoices', 'files', 'documents', 'read'], summary: 'Download down-payment invoice PDF', parameters: [idParam('Down-payment invoice UUID')], responses: { '200': 'PDF/binary file' }, docsUrl: 'https://developers.lexware.io/docs/#down-payment-invoices-endpoint-retrieve-a-down-payment-invoice-file' },
		},
		'/v1/vouchers': {
			get: {
				operationId: 'filterVouchers',
				tags: ['vouchers', 'bookkeeping', 'read'],
				summary: 'Filter bookkeeping vouchers by voucher number',
				parameters: [{ name: 'voucherNumber', in: 'query', type: 'string', description: 'Voucher number filter.' }, ...pageParams],
				responses: pagedResponse('bookkeeping vouchers'),
				notes: pagedNotes,
				docsUrl: 'https://developers.lexware.io/docs/#vouchers-endpoint-filtering-vouchers',
			},
			post: {
				operationId: 'createVoucher',
				tags: ['vouchers', 'bookkeeping', 'write'],
				summary: 'Create a bookkeeping voucher',
				requestBody: { contentType: 'application/json', summary: 'Bookkeeping voucher JSON. Common fields: type, voucherDate, voucherNumber, contactId, totalGrossAmount, totalTaxAmount, taxType, voucherItems[].categoryId.', required: ['type', 'voucherDate', 'totalGrossAmount', 'totalTaxAmount', 'taxType', 'voucherItems'], shape: { type: 'purchaseinvoice|salesinvoice|...', voucherDate: 'YYYY-MM-DD', totalGrossAmount: 119, totalTaxAmount: 19, taxType: 'net|gross|vatfree', voucherItems: [{ amount: 100, taxAmount: 19, taxRatePercent: 19, categoryId: 'posting category UUID' }] } },
				examples: [{ type: 'purchaseinvoice', voucherDate: '2026-01-31', totalGrossAmount: 119, totalTaxAmount: 19, taxType: 'gross', voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: '...' }] }],
				responses: documentResponses,
				notes: ['Use /v1/posting-categories to find valid voucherItems[].categoryId values.'],
				docsUrl: 'https://developers.lexware.io/docs/#vouchers-endpoint-create-a-voucher',
			},
		},
		'/v1/vouchers/{id}': {
			get: { operationId: 'getVoucher', tags: ['vouchers', 'bookkeeping', 'read'], summary: 'Retrieve one bookkeeping voucher', parameters: [idParam('Voucher UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#vouchers-endpoint-retrieve-a-voucher' },
			put: { operationId: 'updateVoucher', tags: ['vouchers', 'bookkeeping', 'write'], summary: 'Update a bookkeeping voucher', parameters: [idParam('Voucher UUID')], requestBody: { contentType: 'application/json', summary: 'Full voucher JSON including current version for optimistic locking.', required: ['version', 'type', 'voucherDate', 'totalGrossAmount', 'totalTaxAmount', 'taxType', 'voucherItems'] }, responses: documentResponses, notes: ['On 409 conflict, re-fetch the voucher and retry with its current version.'], docsUrl: 'https://developers.lexware.io/docs/#vouchers-endpoint-update-a-voucher' },
		},
		'/v1/vouchers/{id}/files': {
			post: { operationId: 'uploadFileToVoucher', tags: ['vouchers', 'files', 'bookkeeping', 'write', 'upload'], summary: 'Upload and attach a file to a voucher', parameters: [idParam('Voucher UUID')], requestBody: { contentType: 'multipart/form-data', summary: 'Multipart file upload. Field: file.' }, responses: documentResponses, notes: ['Upload via the multipart request field of lexware.request, e.g. multipart: [{ name: "file", contentType: "application/pdf", contentPath: "/absolute/path/doc.pdf" }]. Use contentPath for files on the server machine, contentBase64 for bytes held as base64.'], examples: [{ multipart: [{ name: 'file', contentType: 'application/pdf', contentPath: '/absolute/path/to/receipt.pdf' }] }], docsUrl: 'https://developers.lexware.io/docs/#vouchers-endpoint-upload-a-file-to-a-voucher' },
		},
		'/v1/posting-categories': {
			get: { operationId: 'listPostingCategories', tags: ['posting-categories', 'bookkeeping', 'reference-data', 'read'], summary: 'List bookkeeping posting categories', responses: documentResponses, notes: ['Use returned category ids when creating/updating bookkeeping vouchers.'], docsUrl: 'https://developers.lexware.io/docs/#posting-categories-endpoint' },
		},
		'/v1/files': {
			post: { operationId: 'uploadFile', tags: ['files', 'documents', 'write', 'upload', 'beleg'], summary: 'Upload a file', requestBody: { contentType: 'multipart/form-data', summary: 'Multipart upload. Form fields: file (the binary file) and type (e.g. voucher). Both are multipart form fields, not query parameters.', required: ['file', 'type'], shape: { file: 'binary file content', type: 'voucher' } }, responses: documentResponses, notes: ['type=voucher is a multipart form field, not a query parameter. Send both file and type as form fields.', 'Upload via the multipart request field of lexware.request — never hand-roll boundaries or inline file bytes in code. For a file on the server machine use contentPath (absolute path; host reads it from disk). For bytes you already hold as base64 use contentBase64.', 'The response includes sent: { bytes, parts: [{ name, filename, bytes, sha256 }] } echoing the uploaded binary payload for integrity checks.'], examples: [{ multipart: [{ name: 'file', contentType: 'application/pdf', contentPath: '/absolute/path/to/receipt.pdf' }, { name: 'type', value: 'voucher' }] }], docsUrl: 'https://developers.lexware.io/docs/#files-endpoint-upload-a-file' },
		},
		'/v1/files/{id}': {
			get: { operationId: 'downloadFile', tags: ['files', 'documents', 'read'], summary: 'Download a file by file id', parameters: [idParam('File UUID')], responses: { '200': 'Binary/PDF/XML file content', '404': 'File not found' }, notes: ['Accept can be application/pdf, application/xml, or */*. Return as resource/blob, not as large inline text.'], docsUrl: 'https://developers.lexware.io/docs/#files-endpoint-retrieve-a-file' },
		},
		'/v1/payments/{voucherId}': {
			get: { operationId: 'getPayments', tags: ['payments', 'invoices', 'vouchers', 'read'], summary: 'Get payment information for a voucher/invoice', parameters: [{ name: 'voucherId', in: 'path', required: true, type: 'uuid', description: 'Voucher or invoice UUID.' }], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#payments-endpoint' },
		},
		'/v1/payment-conditions': {
			get: { operationId: 'listPaymentConditions', tags: ['payment-conditions', 'payment-terms', 'zahlungsbedingungen', 'reference-data', 'read'], summary: 'List payment conditions / payment terms (Zahlungsbedingungen)', responses: documentResponses, notes: ['Use /v1/payment-conditions for payment terms / Zahlungsbedingungen. Do not confuse with /v1/countries, which lists tax-classification reference data.', 'Use payment condition data as reference when creating invoices and other sales documents.'], docsUrl: 'https://developers.lexware.io/docs/#payment-conditions-endpoint' },
		},
		'/v1/recurring-templates': {
			get: { operationId: 'listRecurringTemplates', tags: ['recurring-templates', 'invoices', 'read'], summary: 'List recurring invoice templates', parameters: [...pageParams, { name: 'sort', in: 'query', type: 'string', description: 'Sort expression, e.g. createdDate,DESC or nextExecutionDate,ASC.' }], responses: pagedResponse('recurring invoice templates'), notes: pagedNotes, docsUrl: 'https://developers.lexware.io/docs/#recurring-templates-endpoint-retrieve-and-filter-recurring-templates' },
		},
		'/v1/recurring-templates/{id}': {
			get: { operationId: 'getRecurringTemplate', tags: ['recurring-templates', 'invoices', 'read'], summary: 'Retrieve one recurring invoice template', parameters: [idParam('Recurring template UUID')], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#recurring-templates-endpoint-retrieve-a-recurring-template' },
		},
		'/v1/event-subscriptions': {
			get: { operationId: 'listEventSubscriptions', tags: ['event-subscriptions', 'webhooks', 'read'], summary: 'List webhook event subscriptions', responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#event-subscriptions-endpoint-retrieve-event-subscriptions' },
			post: { operationId: 'createEventSubscription', tags: ['event-subscriptions', 'webhooks', 'write'], summary: 'Create a webhook event subscription', requestBody: { contentType: 'application/json', summary: 'Subscription JSON with eventType and callbackUrl.', required: ['eventType', 'callbackUrl'] }, responses: documentResponses, examples: [{ eventType: 'contact.changed', callbackUrl: 'https://example.org/webhook' }], docsUrl: 'https://developers.lexware.io/docs/#event-subscriptions-endpoint-create-an-event-subscription' },
		},
		'/v1/event-subscriptions/{subscriptionId}': {
			get: { operationId: 'getEventSubscription', tags: ['event-subscriptions', 'webhooks', 'read'], summary: 'Retrieve one webhook event subscription', parameters: [{ name: 'subscriptionId', in: 'path', required: true, type: 'uuid', description: 'Subscription UUID.' }], responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#event-subscriptions-endpoint-retrieve-an-event-subscription' },
			delete: { operationId: 'deleteEventSubscription', tags: ['event-subscriptions', 'webhooks', 'write'], summary: 'Delete a webhook event subscription', parameters: [{ name: 'subscriptionId', in: 'path', required: true, type: 'uuid', description: 'Subscription UUID.' }], responses: { ...documentResponses, '204': 'Deleted successfully' }, docsUrl: 'https://developers.lexware.io/docs/#event-subscriptions-endpoint-delete-an-event-subscription' },
		},
		'/v1/profile': {
			get: { operationId: 'getProfile', tags: ['profile', 'company', 'reference-data', 'read'], summary: 'Get company profile', responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#profile-endpoint' },
		},
		'/v1/countries': {
			get: { operationId: 'listCountries', tags: ['countries', 'reference-data', 'read'], summary: 'List countries and tax classifications', responses: documentResponses, notes: ['taxClassification values include de, intraCommunity, thirdPartyCountry.'], docsUrl: 'https://developers.lexware.io/docs/#countries-endpoint' },
		},
		'/v1/print-layouts': {
			get: { operationId: 'listPrintLayouts', tags: ['print-layouts', 'documents', 'reference-data', 'read'], summary: 'List available print layouts', responses: documentResponses, docsUrl: 'https://developers.lexware.io/docs/#print-layouts-endpoint' },
		},
	},
	workflows: {
		chooseVoucherStatusForVoucherlist: {
			summary: 'Choose valid voucherStatus values and reporting defaults for GET /v1/voucherlist by voucherType',
			keywords: ['voucherStatus', 'voucher status', 'status values', 'invoice statuses', 'quotation statuses', 'paid', 'paidoff', 'voided', 'draft', 'open', 'overdue', 'reporting defaults'],
			steps: [
				'Inspect spec.info.voucherStatusSemantics.voucherTypes[voucherType].statuses before building a voucherlist query.',
				'For gross invoiced/accrual revenue use spec.info.voucherStatusSemantics.reportingDefaults.invoicedAccrualRevenue: voucherType=invoice and voucherStatus=open,paid.',
				'For paid/cash revenue use reportingDefaults.paidCashRevenue: voucherType=invoice and voucherStatus=paid.',
				'For draft pipeline use voucherStatus=draft only; for audit/all-invoice lists include draft and voided only when explicitly requested.',
				'For profit-like analysis, revenue-only invoice statuses are not enough; combine revenue with purchase/bookkeeping expense vouchers and state assumptions.',
			],
			relatedEndpoints: [{ method: 'GET', path: '/v1/voucherlist' }],
			notes: ['Do not count voided documents as revenue by default.', 'Do not count draft documents as revenue.', 'voucherStatus is sent as comma-separated status tokens, for example open,paid.'],
		},
		listInvoices: {
			summary: 'List invoices for sales/revenue reporting, turnover/Umsatz, income, or earnings questions',
			keywords: ['invoice', 'invoices', 'list invoices', 'sales', 'revenue', 'turnover', 'Umsatz', 'income', 'earnings', 'reporting'],
			steps: [
				'Call GET /v1/voucherlist with voucherType=invoice and suitable voucherStatus values from spec.info.voucherStatusSemantics.voucherTypes.invoice.statuses.',
				'For most reporting/listing questions, start with spec.info.voucherStatusSemantics.reportingDefaults.invoicedAccrualRevenue (voucherStatus=open,paid) to exclude drafts and voided invoices unless the user asks otherwise.',
				'Use voucherDateFrom/voucherDateTo for period filters and lexware.paginate to traverse the zero-based LexwarePage<T> response completely.',
				'Use returned ids with GET /v1/invoices/{id} for full invoice details.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/voucherlist' },
				{ method: 'GET', path: '/v1/invoices/{id}' },
			],
			notes: ['Do not list invoices via GET /v1/invoices; the documented listing path is voucherlist.', 'Voucherlist summaries are the fastest starting point for invoice lists and high-level sales/revenue aggregation with totalAmount/openAmount.', 'Voucherlist summaries do not include VAT-aware net amount fields; use invoice details for net revenue.'],
		},
		calculateInvoicedRevenue: {
			summary: 'Calculate invoiced revenue/sales/turnover/Umsatz/earnings by period from invoice voucher summaries',
			keywords: ['earnings', 'revenue', 'sales', 'turnover', 'Umsatz', 'income', 'invoiced revenue', 'accrual revenue', 'gross revenue', 'gross sales', 'invoice total'],
			steps: [
				'Call lexware.paginate with path=/v1/voucherlist, voucherType=invoice, voucherStatus=open,paid (spec.info.voucherStatusSemantics.reportingDefaults.invoicedAccrualRevenue), and voucherDateFrom/voucherDateTo for the requested period.',
				'lexware.paginate starts at page=0 by default, uses size=250 by default, and stops on last=true, page+1 >= totalPages, or empty content; increase execute maxRequests if the filtered period has many pages.',
				'Sum totalAmount returned by voucherlist entries for a fast invoiced-revenue answer; openAmount is the outstanding/unpaid amount, not additional revenue.',
				'State the assumption clearly: invoiced revenue excludes draft and voided invoices and includes unpaid open invoices.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/voucherlist' },
				{ method: 'GET', path: '/v1/invoices/{id}' },
			],
			notes: ['Use this workflow first for broad finance/reporting questions such as “earnings 2026”, “revenue”, “sales”, “turnover”, or “Umsatz” when the user did not ask for VAT-aware net revenue or profit.', 'Voucherlist is aggregation-friendly for totalAmount/openAmount; invoice detail fan-out is needed when summary fields are insufficient or VAT-aware net revenue is requested.', 'Do not default missing amount fields to zero.'],
			examples: [{ question: 'What did I earn in 2026?', query: { voucherType: 'invoice', voucherStatus: 'open,paid', voucherDateFrom: '2026-01-01', voucherDateTo: '2026-12-31' }, aggregation: 'Sum totalAmount over all paginated voucher summaries with strict missing-field checks.', assumption: 'Gross invoiced/accrual revenue; excludes draft and voided invoices; includes unpaid open invoices.' }],
		},
		calculatePaidRevenue: {
			summary: 'Calculate paid/cash revenue from paid invoice voucher summaries',
			keywords: ['paid revenue', 'cash revenue', 'cash basis', 'paid invoices', 'payments', 'received payments', 'paid sales', 'paid Umsatz', 'income received'],
			steps: [
				'Call lexware.paginate with path=/v1/voucherlist, voucherType=invoice, and voucherStatus=paid (spec.info.voucherStatusSemantics.reportingDefaults.paidCashRevenue) for the requested voucher date period.',
				'Paginate through all pages and sum totalAmount for paid/settled invoice summaries; openAmount is the outstanding/unpaid amount, not additional revenue.',
				'If the user needs exact payment dates, payment timing, or partial-payment treatment, inspect GET /v1/payments/{voucherId} for the relevant invoices.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/voucherlist' },
				{ method: 'GET', path: '/v1/payments/{voucherId}' },
				{ method: 'GET', path: '/v1/invoices/{id}' },
			],
			notes: ['Paid revenue is narrower than invoiced/accrual revenue: it normally excludes open, draft, and voided invoices.', 'Voucher date filters are not necessarily payment-date filters; use payment details when the distinction matters.', 'Do not default missing amount fields to zero.'],
			examples: [{ question: 'How much revenue was actually paid in 2026?', query: { voucherType: 'invoice', voucherStatus: 'paid', voucherDateFrom: '2026-01-01', voucherDateTo: '2026-12-31' }, aggregation: 'Sum totalAmount over paid/settled invoice summaries with strict missing-field checks; fetch payments for exact payment dates or partial payment details.' }],
		},
		calculateNetRevenueFromInvoiceDetails: {
			summary: 'Calculate VAT-aware net revenue by fetching invoice details after voucherlist discovery',
			keywords: ['net revenue', 'net sales', 'net turnover', 'net Umsatz', 'VAT', 'tax', 'invoice details', 'line items', 'gross vs net'],
			steps: [
				'Use lexware.paginate on GET /v1/voucherlist with voucherType=invoice and reporting statuses/date filters to discover all matching invoice ids; voucherlist has no VAT-aware net amount field.',
				'Fetch each invoice with GET /v1/invoices/{id}; this N+1 fan-out can exceed the default execute.maxRequests=10, so deliberately increase maxRequests or narrow the date range when many invoices match.',
				'Inspect the actual invoice detail payload before summing. Common Lexware sales-document detail totals may be under totalPrice.totalNetAmount, but strict code must throw if the expected field is absent.',
				'Sum net amounts from the actual invoice detail shape returned by the API, respecting tax conditions and line items.',
				'Do not estimate net revenue by dividing gross totals by 1.19 unless the user explicitly accepts that approximation.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/voucherlist' },
				{ method: 'GET', path: '/v1/invoices/{id}' },
			],
			notes: ['Use this workflow when the user explicitly asks for net revenue, VAT-aware revenue, tax-exclusive sales, or gross-vs-net breakdowns.', 'It is more API-call intensive than voucherlist aggregation and may require raising execute.maxRequests above the default of 10.', 'Never use a blanket gross / 1.19 estimate unless the user explicitly accepts an approximation.', 'Strict example: const detail = await lexware.json({ path: `/v1/invoices/${invoice.id}` }); const net = detail?.totalPrice?.totalNetAmount; if (typeof net !== \'number\') throw new Error(`Invoice ${invoice.id} has no numeric totalPrice.totalNetAmount; available totalPrice fields: ${Object.keys(detail?.totalPrice ?? {}).join(\', \')}`);'],
			examples: [{ question: 'What was my net revenue in 2026?', discoveryQuery: { voucherType: 'invoice', voucherStatus: 'open,paid', voucherDateFrom: '2026-01-01', voucherDateTo: '2026-12-31' }, aggregation: 'Discover invoice ids via voucherlist, fetch each invoice detail, then sum actual net/tax-exclusive fields from the returned detail payload without silent zero defaults.' }],
		},
		listBookkeepingExpenses: {
			summary: 'List bookkeeping expenses/costs for expense, purchase, profit, or P&L-style analysis',
			keywords: ['expenses', 'costs', 'purchases', 'purchase invoices', 'bookkeeping', 'vouchers', 'profit', 'P&L', 'profit and loss', 'expenses by year'],
			steps: [
				'For expense summaries, start with lexware.paginate on GET /v1/voucherlist using spec.info.voucherStatusSemantics.reportingDefaults.bookkeepingExpenses (purchaseinvoice,purchasecreditnote with voided excluded) and period filters.',
				'Use GET /v1/vouchers or GET /v1/vouchers/{id} when bookkeeping voucher details or posting-category allocations are required.',
				'Use GET /v1/posting-categories to interpret voucherItems[].categoryId values.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/voucherlist' },
				{ method: 'GET', path: '/v1/vouchers' },
				{ method: 'GET', path: '/v1/vouchers/{id}' },
				{ method: 'GET', path: '/v1/posting-categories' },
			],
			notes: ['Revenue-only invoice workflows are not enough for profit-like questions; profit requires expenses/costs as well as revenue.', 'Confirm with the user whether purchase credit notes should reduce expenses in the requested analysis.'],
			examples: [{ question: 'What was my profit in 2026?', approach: 'Do not answer from invoices alone. Combine invoice revenue with purchase/bookkeeping expenses and state tax/accounting assumptions, or ask the user to clarify the required profit definition.' }],
		},
		createAndFinalizeSalesDocument: {
			summary: 'Create a draft or finalized sales document',
			steps: [
				'Build the sales voucher JSON with address/contactId, lineItems, totalPrice.currency, taxConditions, and required date/condition fields.',
				'POST to /v1/invoices, /v1/quotations, /v1/order-confirmations, /v1/credit-notes, or /v1/delivery-notes.',
				'Add query finalize=true only when the user wants an immediately finalized/published document.',
				'For follow-up documents, pass precedingSalesVoucherId when the specific endpoint supports or requires it.',
			],
			relatedEndpoints: [
				{ method: 'POST', path: '/v1/invoices' },
				{ method: 'POST', path: '/v1/quotations' },
				{ method: 'POST', path: '/v1/order-confirmations' },
				{ method: 'POST', path: '/v1/credit-notes' },
				{ method: 'POST', path: '/v1/delivery-notes' },
			],
			notes: ['Finalized sales documents are locked. Prefer drafts unless the user explicitly asks to finalize.'],
		},
		dunningLifecycle: {
			summary: 'Create and retrieve dunning notices',
			steps: [
				'Find or receive the invoice id to dun.',
				'POST /v1/dunnings with precedingSalesVoucherId set to that invoice id.',
				'Retrieve later with GET /v1/dunnings/{id}; there is no dunnings list endpoint.',
				'If the id is unknown, inspect relatedVouchers on the associated invoice.',
			],
			relatedEndpoints: [
				{ method: 'POST', path: '/v1/dunnings' },
				{ method: 'GET', path: '/v1/dunnings/{id}' },
				{ method: 'GET', path: '/v1/invoices/{id}' },
			],
			notes: ['Lexware may return voucherStatus:"draft" for dunnings regardless of finalize=true; this is expected according to the legacy MCP notes.'],
		},
		updateWithOptimisticLocking: {
			summary: 'Safely update versioned resources',
			steps: [
				'Retrieve the current resource details and note its version.',
				'Send the update with that version field included.',
				'If the API returns 409, re-fetch details, merge changes carefully, and retry with the new version.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/contacts/{id}' },
				{ method: 'PUT', path: '/v1/contacts/{id}' },
				{ method: 'GET', path: '/v1/vouchers/{id}' },
				{ method: 'PUT', path: '/v1/vouchers/{id}' },
				{ method: 'GET', path: '/v1/articles/{id}' },
				{ method: 'PUT', path: '/v1/articles/{id}' },
			],
			notes: ['PUT requests generally replace list-valued fields; avoid dropping data by including existing list values unless intentionally removing them.'],
		},
		fileHandling: {
			summary: 'Upload and download files/documents (Belege)',
			keywords: ['upload', 'beleg', 'receipt', 'pdf', 'multipart', 'contentPath', 'file'],
			steps: [
				'Check spec.info.writesEnabled first — uploads are writes and are blocked when it is false.',
				'For bookkeeping file upload, POST to /v1/files using the multipart request field with parts file and type=voucher (see example).',
				'For a file on the server machine, set contentPath to its absolute path — the host reads the file from disk, so never inline file bytes or base64 in the code string.',
				'For bytes you already hold as base64, use contentBase64 instead of contentPath.',
				'Verify the upload via response.sent (bytes and sha256 per binary part) and the returned file id.',
				'To attach a file directly to a voucher, POST the same multipart shape (file part only) to /v1/vouchers/{id}/files.',
				'To download a known file, GET /v1/files/{id} with an appropriate Accept header.',
				'To download a sales document PDF, GET /v1/{documentType}/{id}/file after the document is finalized/rendered.',
			],
			relatedEndpoints: [
				{ method: 'POST', path: '/v1/files' },
				{ method: 'GET', path: '/v1/files/{id}' },
				{ method: 'POST', path: '/v1/vouchers/{id}/files' },
				{ method: 'GET', path: '/v1/invoices/{id}/file' },
			],
			notes: [
				'Binary/PDF/XML data should be returned as an MCP resource/blob or compact metadata, not pasted as huge text.',
				'Do not use body/rawBody for multipart endpoints — string bodies are UTF-8 encoded and corrupt binary data. The multipart field is the binary-safe path.',
			],
			examples: [
				{
					description: 'Upload a local PDF as a bookkeeping voucher (Beleg)',
					request: {
						method: 'POST',
						path: '/v1/files',
						multipart: [
							{ name: 'file', contentType: 'application/pdf', contentPath: '/absolute/path/to/receipt.pdf' },
							{ name: 'type', value: 'voucher' },
						],
					},
				},
			],
		},
		findContact: {
			summary: 'Find a contact by email/name/number/role',
			steps: [
				'Call GET /v1/contacts with the most specific filters available.',
				'For email and name, provide at least 3 characters and remember %/_ wildcard behavior.',
				'Use GET /v1/contacts/{id} for full details before updates.',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/contacts' },
				{ method: 'GET', path: '/v1/contacts/{id}' },
			],
		},
		duplicateVoucher: {
			summary: 'Duplicate a bookkeeping voucher (Beleg duplizieren) — copy fields to a new voucher',
			keywords: ['duplicate', 'copy voucher', 'duplicate voucher', 'Beleg duplizieren', 'Beleg kopieren', 'clone voucher'],
			steps: [
				'Fetch the source voucher with GET /v1/vouchers/{id}.',
				'Build the new POST body from source fields: type, taxType, voucherItems, totalGrossAmount, totalTaxAmount, voucherDate (override if the user provides one), dueDate, contactId, remark. Strip id, version, createdDate, updatedDate, and files[] — do not include them.',
				'POST /v1/vouchers with the assembled body and desired voucherStatus (open or unchecked; default to open).',
			],
			relatedEndpoints: [
				{ method: 'GET', path: '/v1/vouchers/{id}' },
				{ method: 'POST', path: '/v1/vouchers' },
			],
			notes: [
				'totalGrossAmount and totalTaxAmount must be included in the POST body even though they are derived; the API rejects requests without them.',
				'contactId and remark may be absent in the source — omit from the POST body rather than sending null.',
				'Omit voucherNumber to let Lexware auto-assign it (recommended for salesinvoice and salescreditnote sequential numbering).',
				'File attachments (source.files[]) cannot be copied here: binary response bodies are dropped by the sandbox (GET /v1/files/{id} returns metadata only). Tell the user to re-attach files manually in the Lexware Office UI.',
			],
		},
	},
};

for (const [path, methods] of Object.entries(lexwareSpec.paths)) {
	for (const [method, operation] of Object.entries(methods) as Array<[HttpMethod, LexwareOperation]>) {
		operation.capabilities ??= inferCapabilities(path, method, operation);
	}
}

function inferCapabilities(path: string, method: HttpMethod, operation: LexwareOperation): LexwareOperationCapabilities {
	const write = method !== 'get';
	const paginated = Boolean(operation.parameters?.some((parameter) => parameter.in === 'query' && parameter.name === 'page'));
	const multipart = operation.requestBody?.contentType === 'multipart/form-data';
	return {
		write,
		paginated,
		multipart,
		executable: path.startsWith('/v1/'),
	};
}

export default lexwareSpec;
