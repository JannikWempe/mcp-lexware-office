import { readFileSync } from 'fs';
import { extname, basename } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeLexwareOfficeRequest, makeLexwareOfficeFileRequest, makeLexwareOfficeWriteRequest, makeLexwareOfficeMultipartRequest } from './helper.js';
import { logger } from './logger.js';

const contactPersonSchema = z.object({
	salutation: z.string().optional(),
	firstName: z.string().optional(),
	lastName: z.string(),
	emailAddress: z.string().optional(),
	phoneNumber: z.string().optional(),
});

const addressEntrySchema = z.object({
	street: z.string().optional(),
	zip: z.string().optional(),
	city: z.string().optional(),
	countryCode: z.string().length(2).optional(),
	supplement: z.string().optional(),
});

function writeErrorResponse(result: { status: number; error: unknown } | null): string {
	if (!result) return 'Request failed due to a network or server error.';
	if (result.status === 404) return 'Record not found.';
	if (result.status === 409) return 'Version conflict — please re-fetch the record and try again.';
	if (result.status === 401 || result.status === 403) return 'Authentication or permission error.';
	return `API error (${result.status}): ${JSON.stringify(result.error, null, 2)}`;
}

const server = new McpServer({
	name: 'lexware-office',
	version: '1.5.0',
});

server.tool(
	'get-invoices',
	'Get a list of natively created invoices from Lexware Office. IMPORTANT: This only returns invoices created directly in Lexware Office. Externally created invoices imported as bookkeeping entries (Ausgangsbelege) are NOT included here — use get-vouchers with voucherType=salesinvoice for those. For a complete picture of what a customer owes, use get-open-receivables instead.',
	{
		status: z
			.array(z.enum(['open', 'draft', 'paid', 'paidoff', 'voided']))
			.optional()
			.default(['open', 'draft', 'paid', 'paidoff', 'voided']),
		contactId: z
			.string()
			.uuid()
			.optional()
			.describe('Filter by contact ID — returns only invoices for this customer/vendor'),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z
			.number()
			.min(1)
			.max(250)
			.optional()
			.default(250)
			.describe('number of invoices to retrieve per page'),
	},
	async ({ status, contactId, page, size }) => {
		let voucherlistUrl = `/v1/voucherlist?voucherType=invoice&voucherStatus=${status.join(',')}&page=${page}&size=${size}`;
		if (contactId) voucherlistUrl += `&contactId=${contactId}`;
		const voucherlistData = await makeLexwareOfficeRequest<any>(voucherlistUrl);
		const vouchers = voucherlistData.content;

		if (!vouchers || vouchers.length === 0) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve invoices',
					},
				],
			};
		}

		const response = `There are ${vouchers.length} invoices in Lexware Office:\n\n${JSON.stringify(
			vouchers,
			null,
			2,
		)}`;

		return {
			content: [
				{
					type: 'text',
					text: response,
				},
			],
		};
	},
);

server.tool(
	'get-invoice-details',
	'Get details of an invoice from Lexware Office',
	{
		id: z.string().uuid().describe('The id of the invoice'),
	},
	async ({ id }) => {
		const invoiceUrl = `/v1/invoices/${id}`;
		const invoiceData = await makeLexwareOfficeRequest<any>(invoiceUrl);

		if (!invoiceData) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve invoice data',
					},
				],
			};
		}

		const response = `Invoice details:\n\n${JSON.stringify(invoiceData, null, 2)}`;

		return {
			content: [
				{
					type: 'text',
					text: response,
				},
			],
		};
	},
);

server.tool(
	'get-contacts',
	'Get contacts from Lexware Office with optional filters that are combined with a logical AND',
	{
		email: z
			.string()
			.min(3)
			.optional()
			.describe(
				'filters contacts where any of their email addresses inside the emailAddresses object or in company contactPersons match the given email value; can be a substring; _ is allowed as wildcard for any character; % is allowed as wildcard for any number of characters; _ and % can be escaped with \\',
			),
		name: z
			.string()
			.min(3)
			.optional()
			.describe(
				'filters contacts whose name matches the given name value; can be a substring; _ is allowed as wildcard for any character; % is allowed as wildcard for any number of characters; _ and % can be escaped with \\',
			),
		number: z
			.number()
			.int()
			.optional()
			.describe(
				'returns the contacts with the specified contact number (customer or vendor number)',
			),
		customer: z
			.boolean()
			.optional()
			.describe(
				'if set to true filters contacts that have the role customer, if set to false filters contacts that do not have the customer role',
			),
		vendor: z
			.boolean()
			.optional()
			.describe(
				'if set to true filters contacts that have the role vendor, if set to false filters contacts that do not have the vendor role',
			),
		page: z.number().min(0).optional().describe('page number to retrieve; starts at 0; mutually exclusive with fetchAll'),
		size: z
			.number()
			.min(1)
			.max(250)
			.optional()
			.default(250)
			.describe('number of contacts to retrieve per page'),
		fetchAll: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'if true, auto-fetches all pages sequentially and returns combined results; mutually exclusive with page; size controls batch size per API call',
			),
	},
	async ({ email, name, number, customer, vendor, page, size, fetchAll }) => {
		// fetchAll + page is a configuration conflict
		if (fetchAll && page !== undefined) {
			return {
				content: [
					{
						type: 'text',
						text: 'fetchAll and page are mutually exclusive. Use fetchAll: true OR page/size, not both.',
					},
				],
			};
		}

		// Filter params only — page/size appended separately per mode to prevent double-append
		const filterParams = new URLSearchParams();
		if (email) filterParams.append('email', email);
		if (name) filterParams.append('name', name);
		if (number) filterParams.append('number', number.toString());
		if (customer !== undefined) filterParams.append('customer', customer.toString());
		if (vendor !== undefined) filterParams.append('vendor', vendor.toString());

		if (!fetchAll) {
			// Normal mode
			const params = new URLSearchParams(filterParams);
			if (page !== undefined) params.append('page', page.toString());
			params.append('size', size.toString());

			const contactsData = await makeLexwareOfficeRequest<any>(`/v1/contacts?${params.toString()}`);

			if (!contactsData) {
				return { content: [{ type: 'text', text: 'Failed to retrieve contacts' }] };
			}

			return {
				content: [{ type: 'text', text: `Contacts:\n\n${JSON.stringify(contactsData, null, 2)}` }],
			};
		}

		// fetchAll mode — sequential pagination, 550ms delay before each page after page 0
		const page0Params = new URLSearchParams(filterParams);
		page0Params.append('page', '0');
		page0Params.append('size', size.toString());

		const page0Data = await makeLexwareOfficeRequest<any>(`/v1/contacts?${page0Params.toString()}`);

		if (!page0Data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve contacts (page 0)' }] };
		}

		const totalPages: number = page0Data.totalPages;
		const allContacts: any[] = [...page0Data.content];
		const warnings: string[] = [];

		const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

		for (let p = 1; p < totalPages; p++) {
			await delay(550); // before fetch — no trailing wait after final page
			try {
				const pageParams = new URLSearchParams(filterParams);
				pageParams.append('page', p.toString());
				pageParams.append('size', size.toString());
				const pageData = await makeLexwareOfficeRequest<any>(`/v1/contacts?${pageParams.toString()}`);
				if (!pageData) {
					warnings.push(`Failed to fetch page ${p}: null response`);
					continue;
				}
				allContacts.push(...pageData.content);
			} catch (err) {
				warnings.push(`Failed to fetch page ${p}: ${String(err)}`);
			}
		}

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(
						{
							totalElements: page0Data.totalElements,
							totalPages,
							contacts: allContacts,
							warnings,
						},
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	'list-posting-categories',
	'Retrieve list of posting categories for bookkeeping vouchers',
	{
		type: z.enum(['income', 'outgo']).optional().describe('Filter posting categories by type'),
	},
	async ({ type }) => {
		const postingCategoriesUrl = `/v1/posting-categories`;
		const postingCategoriesData = await makeLexwareOfficeRequest<any>(postingCategoriesUrl);

		if (!postingCategoriesData) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve posting categories',
					},
				],
			};
		}

		// Filter by type if specified
		let filteredCategories = postingCategoriesData;
		if (type) {
			filteredCategories = postingCategoriesData.filter((category: any) => category.type === type);
		}

		const response = `Posting Categories:\n\n${JSON.stringify(filteredCategories, null, 2)}`;

		return {
			content: [
				{
					type: 'text',
					text: response,
				},
			],
		};
	},
);

server.tool(
	'list-countries',
	'Retrieve list of countries known to lexoffice with their tax classifications. Tax classifications include "de" (Germany), "intraCommunity" (eligible for Innergemeinschaftliche Lieferung within EU), and "thirdPartyCountry" (countries outside the EU).',
	{
		taxClassification: z
			.enum(['de', 'intraCommunity', 'thirdPartyCountry'])
			.optional()
			.describe(
				'Filter countries by tax classification: "de" for Germany, "intraCommunity" for EU countries eligible for Innergemeinschaftliche Lieferung, or "thirdPartyCountry" for non-EU countries',
			),
	},
	async ({ taxClassification }) => {
		const countriesUrl = `/v1/countries`;
		const countriesData = await makeLexwareOfficeRequest<any>(countriesUrl);

		if (!countriesData) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve countries',
					},
				],
			};
		}

		// Filter by taxClassification if specified
		let filteredCountries = countriesData;
		if (taxClassification) {
			filteredCountries = countriesData.filter(
				(country: any) => country.taxClassification === taxClassification,
			);
		}

		const response = `Countries:\n\n${JSON.stringify(filteredCountries, null, 2)}`;

		return {
			content: [
				{
					type: 'text',
					text: response,
				},
			],
		};
	},
);

server.tool(
	'get-vouchers',
	'Get a list of bookkeeping vouchers (Eingangsbelege/Ausgangsbelege) from Lexware Office. These are invoices/receipts that were created externally and imported into Lexware Office for bookkeeping — NOT natively created invoices (use get-invoices for those). Voucher types: purchaseinvoice (Eingangsrechnung/Ausgaben), purchasecreditnote (Eingangsgutschrift), salesinvoice (Ausgangsrechnung/Einnahmen — externally created), salescreditnote (Ausgangsgutschrift). To find open customer receivables from externally created invoices, use voucherType=salesinvoice with voucherStatus=open. For a complete receivables picture across both sources, use get-open-receivables. For direct lookup by invoice number, use the voucherNumber parameter instead of loading all vouchers.',
	{
		voucherType: z
			.array(
				z.enum(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote']),
			)
			.optional()
			.default(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote'])
			.describe('Filter by voucher type'),
		voucherStatus: z
			.array(
				z.enum(['unchecked', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit']),
			)
			.optional()
			.default(['unchecked', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit'])
			.describe('Filter by voucher status'),
		voucherNumber: z
			.string()
			.optional()
			.describe('Filter by voucher number (e.g. "EK-2025-0001"). Use for direct lookup — avoids loading all vouchers. Match semantics (exact vs. partial) depend on Lexware API.'),
		contactId: z
			.string()
			.uuid()
			.optional()
			.describe('Filter by contact ID — returns only vouchers for this customer/vendor'),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z
			.number()
			.min(1)
			.max(250)
			.optional()
			.default(50)
			.describe('number of vouchers to retrieve per page'),
	},
	async ({ voucherType, voucherStatus, contactId, voucherNumber, page, size }) => {
		let voucherlistUrl = `/v1/voucherlist?voucherType=${voucherType.join(',')}&voucherStatus=${voucherStatus.join(',')}&page=${page}&size=${size}`;
		if (contactId) voucherlistUrl += `&contactId=${contactId}`;
		if (voucherNumber) voucherlistUrl += `&voucherNumber=${encodeURIComponent(voucherNumber)}`;
		const voucherlistData = await makeLexwareOfficeRequest<any>(voucherlistUrl);
		const vouchers = voucherlistData?.content;

		if (!vouchers || vouchers.length === 0) {
			return {
				content: [
					{
						type: 'text',
						text: 'No vouchers found',
					},
				],
			};
		}

		const response = `There are ${voucherlistData.totalElements} vouchers in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`;

		return {
			content: [
				{
					type: 'text',
					text: response,
				},
			],
		};
	},
);

server.tool(
	'get-open-receivables',
	'Get all open receivables (offene Forderungen) for a specific customer — combining both natively created invoices AND externally imported Ausgangsbelege (salesinvoice vouchers). Use this when asked: "How much does customer X owe?", "What invoices are open for customer Y?", "What is the outstanding balance for customer Z?". Returns a consolidated summary with total amount due.',
	{
		contactId: z.string().uuid().describe('The ID of the contact (customer) to check receivables for'),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of records per page'),
	},
	async ({ contactId, page, size }) => {
		const [invoicesData, vouchersData] = await Promise.all([
			makeLexwareOfficeRequest<any>(
				`/v1/voucherlist?voucherType=invoice&voucherStatus=open,draft&contactId=${contactId}&page=${page}&size=${size}`,
			),
			makeLexwareOfficeRequest<any>(
				`/v1/voucherlist?voucherType=salesinvoice&voucherStatus=open,unchecked&contactId=${contactId}&page=${page}&size=${size}`,
			),
		]);

		const nativeInvoices = invoicesData?.content ?? [];
		const salesVouchers = vouchersData?.content ?? [];

		if (nativeInvoices.length === 0 && salesVouchers.length === 0) {
			return {
				content: [{ type: 'text', text: 'No open receivables found for this contact.' }],
			};
		}

		const totalNative = nativeInvoices.reduce((sum: number, v: any) => sum + (v.totalAmount ?? 0), 0);
		const totalVouchers = salesVouchers.reduce((sum: number, v: any) => sum + (v.totalAmount ?? 0), 0);
		const grandTotal = totalNative + totalVouchers;

		const lines: string[] = [
			`Open receivables for contact ${contactId}:`,
			``,
			`Native invoices (created in Lexware Office): ${nativeInvoices.length} — ${totalNative.toFixed(2)} €`,
			`Ausgangsbelege (externally created, imported): ${salesVouchers.length} — ${totalVouchers.toFixed(2)} €`,
			``,
			`TOTAL OUTSTANDING: ${grandTotal.toFixed(2)} €`,
		];

		if (nativeInvoices.length > 0) {
			lines.push(`\n--- Native Invoices ---\n${JSON.stringify(nativeInvoices, null, 2)}`);
		}
		if (salesVouchers.length > 0) {
			lines.push(`\n--- Ausgangsbelege (salesinvoice vouchers) ---\n${JSON.stringify(salesVouchers, null, 2)}`);
		}

		return {
			content: [{ type: 'text', text: lines.join('\n') }],
		};
	},
);

server.tool(
	'get-voucher-details',
	'Get details of a bookkeeping voucher from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The id of the voucher'),
	},
	async ({ id }) => {
		const voucherUrl = `/v1/vouchers/${id}`;
		const voucherData = await makeLexwareOfficeRequest<any>(voucherUrl);

		if (!voucherData) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve voucher data',
					},
				],
			};
		}

		const response = `Voucher details:\n\n${JSON.stringify(voucherData, null, 2)}`;

		return {
			content: [
				{
					type: 'text',
					text: response,
				},
			],
		};
	},
);

server.tool(
	'get-file',
	'Download a file (PDF or XML) from Lexware Office by its file ID. Note: the files.documentFileId field is deprecated — prefer get-document-file when you have a document ID. Use this tool only when you have a raw file ID (e.g. from voucher file attachments).',
	{
		id: z.string().uuid().describe('The file ID (not a document ID — use get-document-file for invoices/quotations/etc.)'),
		format: z
			.enum(['pdf', 'xml'])
			.optional()
			.default('pdf')
			.describe("File format to download: 'pdf' (default) or 'xml' (XRechnung, only available for specific invoice types)."),
	},
	async ({ id, format }) => {
		const accept = format === 'xml' ? 'application/xml' : 'application/pdf';
		const fileData = await makeLexwareOfficeFileRequest(`/v1/files/${id}`, accept);

		if (!fileData) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve file',
					},
				],
			};
		}

		return {
			content: [
				{
					type: 'resource',
					resource: {
						uri: `lexware://files/${id}`,
						mimeType: fileData.mimeType,
						blob: fileData.data.toString('base64'),
					},
				},
			],
		};
	},
);

server.tool(
	'get-document-file',
	'Download the PDF file of a finalized document (invoice, quotation, credit note, order confirmation, delivery note, dunning, or down-payment invoice) directly by its document ID. Use this instead of get-file when you have a document ID rather than a file ID.',
	{
		docType: z
			.enum(['invoices', 'credit-notes', 'quotations', 'order-confirmations', 'delivery-notes', 'dunnings', 'down-payment-invoices'])
			.describe('The type of document'),
		id: z.string().uuid().describe('The ID of the document'),
	},
	async ({ docType, id }) => {
		const fileData = await makeLexwareOfficeFileRequest(`/v1/${docType}/${id}/file`, 'application/pdf');

		if (!fileData) {
			return { content: [{ type: 'text', text: 'Failed to retrieve document file. Ensure the document is finalized.' }] };
		}

		return {
			content: [
				{
					type: 'resource',
					resource: {
						uri: `lexware://${docType}/${id}/file`,
						mimeType: fileData.mimeType,
						blob: fileData.data.toString('base64'),
					},
				},
			],
		};
	},
);

server.tool(
	'get-payments',
	'Get payment information for an invoice or voucher from Lexware Office. Returns payment history including amounts, dates, and payment method.',
	{
		id: z.string().uuid().describe('The ID of the invoice or voucher to retrieve payment information for'),
	},
	async ({ id }) => {
		const LEXWARE_OFFICE_API_KEY = process.env.LEXWARE_OFFICE_API_KEY!;
		const response = await fetch(`https://api.lexware.io/v1/payments/${id}`, {
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${LEXWARE_OFFICE_API_KEY}`,
			},
		}).catch(() => null);

		if (!response) {
			return { content: [{ type: 'text', text: 'Network error retrieving payment information' }] };
		}

		let body: unknown;
		try { body = await response.json(); } catch { body = null; }

		if (response.status === 406) {
			return {
				content: [{ type: 'text', text: "Keine Zahlungsinformationen verfügbar — Beleg hat Status 'unchecked'. Zahlungen werden intern von Lexware gesetzt (nach manueller Eingabe oder Bank-Matching)." }],
			};
		}

		if (!response.ok) {
			return {
				content: [{ type: 'text', text: `API error ${response.status}: ${JSON.stringify(body)}` }],
			};
		}

		return {
			content: [{ type: 'text', text: `Payment information:\n\n${JSON.stringify(body, null, 2)}` }],
		};
	},
);

server.tool(
	'get-payment-conditions',
	'Retrieve available payment conditions (Zahlungsbedingungen) from Lexware Office. Use these as reference when creating invoices.',
	{},
	async () => {
		const data = await makeLexwareOfficeRequest<any>('/v1/payment-conditions');

		if (!data) {
			return {
				content: [{ type: 'text', text: 'Failed to retrieve payment conditions' }],
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: `Payment conditions:\n\n${JSON.stringify(data, null, 2)}`,
				},
			],
		};
	},
);

server.tool(
	'create-contact',
	'Create a new contact in Lexware Office. For company contacts: provide companyName and optionally contactPersons (max. 1) with emailAddress. For person contacts: provide firstName/lastName. Supports billing/shipping address, email addresses (business/office/private/other), and phone numbers. Set customer and/or vendor to true. API limit: max. one entry per email/phone list, max. one contactPerson.',
	{
		customer: z.boolean().optional().describe('Set to true to assign the customer role'),
		vendor: z.boolean().optional().describe('Set to true to assign the vendor role'),
		companyName: z.string().optional().describe('Company name — provide either companyName or lastName, not both'),
		taxNumber: z.string().optional().describe('Tax number of the company'),
		vatRegistrationId: z.string().optional().describe('VAT registration ID of the company'),
		firstName: z.string().optional().describe('First name — for person contacts'),
		lastName: z.string().optional().describe('Last name — for person contacts; required if companyName is not provided'),
		salutation: z.string().optional().describe('Salutation for person contacts'),
		note: z.string().optional(),
		billingStreet: z.string().optional().describe('Street and house number of the billing address'),
		billingZip: z.string().optional().describe('Postal code of the billing address'),
		billingCity: z.string().optional().describe('City of the billing address'),
		billingCountryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code, e.g. "DE"'),
		billingSupplement: z.string().optional().describe('Optional address supplement (Adresszusatz)'),
		shippingStreet: z.string().optional().describe('Street and house number of the shipping address'),
		shippingZip: z.string().optional().describe('Postal code of the shipping address'),
		shippingCity: z.string().optional().describe('City of the shipping address'),
		shippingCountryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code, e.g. "DE"'),
		shippingSupplement: z.string().optional().describe('Optional address supplement for shipping'),
		emailBusiness: z.string().optional().describe('Business email address (max. 1 per type — API limit)'),
		emailOffice: z.string().optional().describe('Office email address (max. 1 per type — API limit)'),
		emailPrivate: z.string().optional().describe('Private email address (max. 1 per type — API limit)'),
		emailOther: z.string().optional().describe('Other email address (max. 1 per type — API limit)'),
		phoneBusiness: z.string().optional().describe('Business phone number (max. 1 per type — API limit)'),
		phoneOffice: z.string().optional().describe('Office phone number (max. 1 per type — API limit)'),
		phoneMobile: z.string().optional().describe('Mobile phone number (max. 1 per type — API limit)'),
		phonePrivate: z.string().optional().describe('Private phone number (max. 1 per type — API limit)'),
		phoneFax: z.string().optional().describe('Fax number (max. 1 per type — API limit)'),
		phoneOther: z.string().optional().describe('Other phone number (max. 1 per type — API limit)'),
		contactPersons: z
			.array(
				z.object({
					salutation: z.string().optional(),
					firstName: z.string().optional(),
					lastName: z.string(),
					primary: z.boolean().optional(),
					emailAddress: z.string().optional(),
					phoneNumber: z.string().optional(),
				}),
			)
			.optional()
			.describe('Contact persons for company contacts. Max. 1 entry (API limit).'),
	},
	async ({
		customer, vendor, companyName, taxNumber, vatRegistrationId,
		firstName, lastName, salutation, note,
		billingStreet, billingZip, billingCity, billingCountryCode, billingSupplement,
		shippingStreet, shippingZip, shippingCity, shippingCountryCode, shippingSupplement,
		emailBusiness, emailOffice, emailPrivate, emailOther,
		phoneBusiness, phoneOffice, phoneMobile, phonePrivate, phoneFax, phoneOther,
		contactPersons,
	}) => {
		const hasBillingFields = billingStreet !== undefined || billingZip !== undefined || billingCity !== undefined || billingCountryCode !== undefined || billingSupplement !== undefined;
		const hasShippingFields = shippingStreet !== undefined || shippingZip !== undefined || shippingCity !== undefined || shippingCountryCode !== undefined || shippingSupplement !== undefined;

		const addressesPayload: Record<string, any> = {
			...(hasBillingFields ? { billing: [{
				...(billingSupplement !== undefined ? { supplement: billingSupplement } : {}),
				...(billingStreet !== undefined ? { street: billingStreet } : {}),
				...(billingZip !== undefined ? { zip: billingZip } : {}),
				...(billingCity !== undefined ? { city: billingCity } : {}),
				...(billingCountryCode !== undefined ? { countryCode: billingCountryCode } : {}),
			}] } : {}),
			...(hasShippingFields ? { shipping: [{
				...(shippingSupplement !== undefined ? { supplement: shippingSupplement } : {}),
				...(shippingStreet !== undefined ? { street: shippingStreet } : {}),
				...(shippingZip !== undefined ? { zip: shippingZip } : {}),
				...(shippingCity !== undefined ? { city: shippingCity } : {}),
				...(shippingCountryCode !== undefined ? { countryCode: shippingCountryCode } : {}),
			}] } : {}),
		};

		const emailAddressesPayload: Record<string, any> = {
			...(emailBusiness !== undefined ? { business: [emailBusiness] } : {}),
			...(emailOffice !== undefined ? { office: [emailOffice] } : {}),
			...(emailPrivate !== undefined ? { private: [emailPrivate] } : {}),
			...(emailOther !== undefined ? { other: [emailOther] } : {}),
		};

		const phoneNumbersPayload: Record<string, any> = {
			...(phoneBusiness !== undefined ? { business: [phoneBusiness] } : {}),
			...(phoneOffice !== undefined ? { office: [phoneOffice] } : {}),
			...(phoneMobile !== undefined ? { mobile: [phoneMobile] } : {}),
			...(phonePrivate !== undefined ? { private: [phonePrivate] } : {}),
			...(phoneFax !== undefined ? { fax: [phoneFax] } : {}),
			...(phoneOther !== undefined ? { other: [phoneOther] } : {}),
		};

		const result = await makeLexwareOfficeWriteRequest<any>('/v1/contacts', 'POST', {
			version: 0,
			roles: {
				...(customer ? { customer: {} } : {}),
				...(vendor ? { vendor: {} } : {}),
			},
			...(companyName !== undefined
				? { company: {
					name: companyName,
					...(taxNumber !== undefined ? { taxNumber } : {}),
					...(vatRegistrationId !== undefined ? { vatRegistrationId } : {}),
					...(contactPersons !== undefined ? { contactPersons } : {}),
				} }
				: {}),
			...(lastName !== undefined || firstName !== undefined
				? { person: {
					...(salutation !== undefined ? { salutation } : {}),
					...(firstName !== undefined ? { firstName } : {}),
					...(lastName !== undefined ? { lastName } : {}),
				} }
				: {}),
			...(Object.keys(addressesPayload).length > 0 ? { addresses: addressesPayload } : {}),
			...(Object.keys(emailAddressesPayload).length > 0 ? { emailAddresses: emailAddressesPayload } : {}),
			...(Object.keys(phoneNumbersPayload).length > 0 ? { phoneNumbers: phoneNumbersPayload } : {}),
			...(note !== undefined ? { note } : {}),
		});

		if (!result || !result.ok) {
			return {
				content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }],
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: `Contact created successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
				},
			],
		};
	},
);

server.tool(
	'update-contact',
	'Update an existing contact in Lexware Office. Requires the current version number for optimistic locking (get it from get-contacts). Note: The Lexware API only supports contacts with at most one billing and one shipping address.',
	{
		id: z.string().uuid().describe('The ID of the contact to update'),
		version: z.number().int().describe('Current version of the contact (for optimistic locking)'),
		customer: z.boolean().optional().describe('Set to true to assign the customer role'),
		vendor: z.boolean().optional().describe('Set to true to assign the vendor role'),
		companyName: z.string().optional().describe('Company name'),
		taxNumber: z.string().optional().describe('Tax number of the company'),
		vatRegistrationId: z.string().optional().describe('VAT registration ID of the company'),
		allowTaxFreeInvoices: z.boolean().optional().describe('Allow tax-free invoices for this company'),
		firstName: z.string().optional().describe('First name — for person contacts'),
		lastName: z.string().optional().describe('Last name — for person contacts'),
		salutation: z.string().optional().describe('Salutation for person contacts'),
		note: z.string().optional(),
		billingStreet: z.string().optional().describe('Street and house number of the billing address'),
		billingZip: z.string().optional().describe('Postal code of the billing address'),
		billingCity: z.string().optional().describe('City of the billing address'),
		billingCountryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code, e.g. "DE"'),
		billingSupplement: z.string().optional().describe('Optional address supplement (Adresszusatz)'),
		shippingStreet: z.string().optional().describe('Street and house number of the shipping address'),
		shippingZip: z.string().optional().describe('Postal code of the shipping address'),
		shippingCity: z.string().optional().describe('City of the shipping address'),
		shippingCountryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code, e.g. "DE"'),
		shippingSupplement: z.string().optional().describe('Optional address supplement for shipping'),
		emailBusiness: z.string().optional().describe('Business email address'),
		emailOffice: z.string().optional().describe('Office email address'),
		emailPrivate: z.string().optional().describe('Private email address'),
		emailOther: z.string().optional().describe('Other email address'),
		phoneBusiness: z.string().optional().describe('Business phone number'),
		phoneOffice: z.string().optional().describe('Office phone number'),
		phoneMobile: z.string().optional().describe('Mobile phone number'),
		phonePrivate: z.string().optional().describe('Private phone number'),
		phoneFax: z.string().optional().describe('Fax number'),
		phoneOther: z.string().optional().describe('Other phone number'),
		contactPersons: z
			.array(
				z.object({
					salutation: z.string().optional(),
					firstName: z.string().optional(),
					lastName: z.string(),
					primary: z.boolean().optional(),
					emailAddress: z.string().optional(),
					phoneNumber: z.string().optional(),
				}),
			)
			.optional()
			.describe('List of contact persons for company contacts. Replaces all existing contact persons.'),
	},
	async ({
		id, customer, vendor, companyName, taxNumber, vatRegistrationId, allowTaxFreeInvoices,
		firstName, lastName, salutation, note, version,
		billingStreet, billingZip, billingCity, billingCountryCode, billingSupplement,
		shippingStreet, shippingZip, shippingCity, shippingCountryCode, shippingSupplement,
		emailBusiness, emailOffice, emailPrivate, emailOther,
		phoneBusiness, phoneOffice, phoneMobile, phonePrivate, phoneFax, phoneOther,
		contactPersons,
	}) => {
		if (!customer && !vendor) {
			return {
				content: [{ type: 'text', text: 'Error: Lexoffice requires at least one role. Set customer or vendor to true.' }],
			};
		}

		const existing = await makeLexwareOfficeRequest<any>(`/v1/contacts/${id}`);
		if (!existing) {
			return { content: [{ type: 'text', text: 'Failed to fetch existing contact data' }] };
		}

		const existingRoles: Record<string, any> = existing.roles ?? {};
		const apiRoles = {
			...(customer ? { customer: existingRoles.customer ?? {} } : {}),
			...(vendor ? { vendor: existingRoles.vendor ?? {} } : {}),
		};

		// Addresses — preserve existing, merge new fields
		const hasBillingFields = billingStreet !== undefined || billingZip !== undefined || billingCity !== undefined || billingCountryCode !== undefined || billingSupplement !== undefined;
		const hasShippingFields = shippingStreet !== undefined || shippingZip !== undefined || shippingCity !== undefined || shippingCountryCode !== undefined || shippingSupplement !== undefined;
		const existingBillingArr: Record<string, any>[] = existing.addresses?.billing ?? [];
		const existingShippingArr: Record<string, any>[] = existing.addresses?.shipping ?? [];
		const billingArray: Record<string, any>[] = hasBillingFields
			? [{
				...(existingBillingArr[0] ?? {}),
				...(billingSupplement !== undefined ? { supplement: billingSupplement } : {}),
				...(billingStreet !== undefined ? { street: billingStreet } : {}),
				...(billingZip !== undefined ? { zip: billingZip } : {}),
				...(billingCity !== undefined ? { city: billingCity } : {}),
				...(billingCountryCode !== undefined ? { countryCode: billingCountryCode } : {}),
			}]
			: existingBillingArr;
		const shippingArray: Record<string, any>[] = hasShippingFields
			? [{
				...(existingShippingArr[0] ?? {}),
				...(shippingSupplement !== undefined ? { supplement: shippingSupplement } : {}),
				...(shippingStreet !== undefined ? { street: shippingStreet } : {}),
				...(shippingZip !== undefined ? { zip: shippingZip } : {}),
				...(shippingCity !== undefined ? { city: shippingCity } : {}),
				...(shippingCountryCode !== undefined ? { countryCode: shippingCountryCode } : {}),
			}]
			: existingShippingArr;

		// Emails — preserve existing arrays, override specified keys
		const existingEmails: Record<string, any> = existing.emailAddresses ?? {};
		const emailAddressesPayload: Record<string, any> = {
			...existingEmails,
			...(emailBusiness !== undefined ? { business: [emailBusiness] } : {}),
			...(emailOffice !== undefined ? { office: [emailOffice] } : {}),
			...(emailPrivate !== undefined ? { private: [emailPrivate] } : {}),
			...(emailOther !== undefined ? { other: [emailOther] } : {}),
		};

		// Phones — preserve existing arrays, override specified keys
		const existingPhones: Record<string, any> = existing.phoneNumbers ?? {};
		const phoneNumbersPayload: Record<string, any> = {
			...existingPhones,
			...(phoneBusiness !== undefined ? { business: [phoneBusiness] } : {}),
			...(phoneOffice !== undefined ? { office: [phoneOffice] } : {}),
			...(phoneMobile !== undefined ? { mobile: [phoneMobile] } : {}),
			...(phonePrivate !== undefined ? { private: [phonePrivate] } : {}),
			...(phoneFax !== undefined ? { fax: [phoneFax] } : {}),
			...(phoneOther !== undefined ? { other: [phoneOther] } : {}),
		};

		// Company — preserve existing fields, merge updates
		const existingCompany: Record<string, any> = existing.company ?? {};
		const companyPayload: Record<string, any> | undefined =
			companyName !== undefined || existing.company
				? {
					...existingCompany,
					...(companyName !== undefined ? { name: companyName } : {}),
					...(taxNumber !== undefined ? { taxNumber } : {}),
					...(vatRegistrationId !== undefined ? { vatRegistrationId } : {}),
					...(allowTaxFreeInvoices !== undefined ? { allowTaxFreeInvoices } : {}),
					...(contactPersons !== undefined ? { contactPersons } : {}),
				}
				: undefined;

		// Person — preserve existing fields, merge updates
		const existingPerson: Record<string, any> = existing.person ?? {};
		const personPayload: Record<string, any> | undefined =
			firstName !== undefined || lastName !== undefined || salutation !== undefined || existing.person
				? {
					...existingPerson,
					...(salutation !== undefined ? { salutation } : {}),
					...(firstName !== undefined ? { firstName } : {}),
					...(lastName !== undefined ? { lastName } : {}),
				}
				: undefined;

		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/contacts/${id}`, 'PUT', {
			version,
			roles: apiRoles,
			...(companyPayload ? { company: companyPayload } : {}),
			...(personPayload ? { person: personPayload } : {}),
			...(note !== undefined ? { note } : (existing.note !== undefined ? { note: existing.note } : {})),
			addresses: { billing: billingArray, shipping: shippingArray },
			...(Object.keys(emailAddressesPayload).length > 0 ? { emailAddresses: emailAddressesPayload } : {}),
			...(Object.keys(phoneNumbersPayload).length > 0 ? { phoneNumbers: phoneNumbersPayload } : {}),
		});

		if (!result || !result.ok) {
			return {
				content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }],
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: `Contact updated successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
				},
			],
		};
	},
);

server.tool(
	'get-contact-details',
	'Get details of a single contact from Lexware Office by its ID. Returns full contact data including roles, address, and contact persons.',
	{
		id: z.string().uuid().describe('The ID of the contact'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/contacts/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve contact data' }] };
		}

		return {
			content: [{ type: 'text', text: `Contact details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

const unitPriceSchema = z.object({
	currency: z.literal('EUR'),
	netAmount: z.string().describe('Net amount as string, e.g. "9.99"'),
	taxRatePercentage: z.number().describe('Tax rate, e.g. 19 for 19%'),
});

const lineItemSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('material'),
		id: z.string().uuid().describe('Article ID from Lexware article catalog — required for material type; use get-articles to look up IDs'),
		name: z.string().describe('Line item name (can override the article name on the document)'),
		description: z.string().optional().describe('Additional description text shown below the item name on the document'),
		quantity: z.number().describe('Quantity'),
		unitName: z.string().describe('Unit name, e.g. "Stunden", "Stück"'),
		unitPrice: unitPriceSchema,
		discountPercentage: z.number().min(0).max(100).optional(),
	}),
	z.object({
		type: z.literal('service'),
		id: z.string().uuid().describe('Service/article ID from Lexware article catalog — required for service type; use get-articles to look up IDs'),
		name: z.string().describe('Line item name (can override the article name on the document)'),
		description: z.string().optional().describe('Additional description text shown below the item name on the document'),
		quantity: z.number().describe('Quantity'),
		unitName: z.string().describe('Unit name, e.g. "Stunden", "Stück"'),
		unitPrice: unitPriceSchema,
		discountPercentage: z.number().min(0).max(100).optional(),
	}),
	z.object({
		type: z.literal('custom'),
		name: z.string().describe('Line item name/title'),
		description: z.string().optional().describe('Additional description text shown below the item name on the document'),
		quantity: z.number().describe('Quantity'),
		unitName: z.string().describe('Unit name, e.g. "Stunden", "Stück"'),
		unitPrice: unitPriceSchema,
		discountPercentage: z.number().min(0).max(100).optional(),
	}),
	z.object({
		type: z.literal('text'),
		name: z.string().describe('Free text line (no price or quantity)'),
	}),
]);

const invoiceAddressSchema = z.union([
	z.object({
		contactId: z.string().uuid().describe('Reference to an existing contact'),
	}),
	z.object({
		name: z.string(),
		street: z.string().optional(),
		zip: z.string().optional(),
		city: z.string().optional(),
		countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2, e.g. "DE"'),
	}),
]);

const invoiceSchema = {
	voucherDate: z.string().describe('Invoice date in ISO 8601 format, e.g. "2026-03-22T00:00:00.000+01:00"'),
	address: invoiceAddressSchema,
	lineItems: z.array(lineItemSchema).min(1),
	taxConditions: z.object({
		taxType: z.enum(['net', 'gross', 'vatfree']).describe('"net" = Netto, "gross" = Brutto, "vatfree" = steuerfrei'),
	}),
	shippingConditions: z.object({
		shippingDate: z.string().describe('Service/delivery date in ISO 8601 format'),
		shippingEndDate: z.string().optional().describe('End date for period types (serviceperiod/deliveryperiod)'),
		shippingType: z
			.enum(['service', 'delivery', 'serviceperiod', 'deliveryperiod'])
			.describe('"service" = Leistungsdatum, "delivery" = Lieferdatum, "serviceperiod" = Leistungszeitraum, "deliveryperiod" = Lieferzeitraum'),
	}).describe('Service/delivery conditions — required by Lexoffice API'),
	paymentConditions: z
		.object({
			paymentTermLabel: z.string().min(1).optional().describe('Custom payment term label shown on the document. When provided, paymentTermLabelLanguage is also required. Omit to let Lexoffice generate the default label from paymentTermDuration.'),
			paymentTermLabelLanguage: z.enum(['de', 'en']).optional().describe('Language for the paymentTermLabel — required when paymentTermLabel is set'),
			paymentTermDuration: z.number().int().describe('Payment term in days'),
			paymentDiscountConditions: z
				.object({
					discountPercentage: z.number(),
					discountRange: z.number().int().describe('Days within which discount applies'),
				})
				.optional(),
		})
		.optional(),
	introduction: z.string().optional().describe('Introductory text before line items'),
	remark: z.string().optional().describe('Closing text after line items'),
};

async function handleInvoiceRequest(
	params: Record<string, unknown>,
	finalize: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
	const path = finalize ? '/v1/invoices?finalize=true' : '/v1/invoices';
	const body = {
		...params,
		totalPrice: { currency: 'EUR' },
	};
	const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', body);

	if (!result || !result.ok) {
		return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
	}

	const action = finalize ? 'created and finalized' : 'created as draft';
	return {
		content: [
			{
				type: 'text',
				text: `Invoice ${action} successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
			},
		],
	};
}

server.tool(
	'create-invoice',
	'Create a new invoice as a draft in Lexware Office. The invoice will not be sent to the customer. Use finalize-invoice to create and immediately finalize.',
	invoiceSchema,
	async (params) => handleInvoiceRequest(params, false),
);

server.tool(
	'finalize-invoice',
	'Create and immediately finalize (publish) an invoice in Lexware Office. The invoice will be locked and cannot be edited. Use create-invoice to create a draft first.',
	invoiceSchema,
	async (params) => handleInvoiceRequest(params, true),
);

const dunningSchema = {
	precedingSalesVoucherId: z
		.string()
		.uuid()
		.describe('ID of the invoice this dunning is for (from get-invoices or get-invoice-details)'),
	voucherDate: z.string().describe('Dunning date in ISO 8601 format, e.g. "2026-03-22T00:00:00.000+01:00"'),
	address: invoiceAddressSchema,
	lineItems: z.array(lineItemSchema).min(1),
	taxConditions: z.object({
		taxType: z.enum(['net', 'gross', 'vatfree']),
	}),
	shippingConditions: z.object({
		shippingDate: z.string().describe('Service/delivery date in ISO 8601 format'),
		shippingEndDate: z.string().optional(),
		shippingType: z.enum(['service', 'delivery', 'serviceperiod', 'deliveryperiod']),
	}).describe('Required by Lexoffice API'),
	introduction: z.string().optional(),
	remark: z.string().optional(),
};

async function handleDunningRequest(
	params: Record<string, unknown>,
	finalize: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
	const { precedingSalesVoucherId, ...rest } = params;
	const queryParams = new URLSearchParams({
		precedingSalesVoucherId: precedingSalesVoucherId as string,
		...(finalize ? { finalize: 'true' } : {}),
	});
	const path = `/v1/dunnings?${queryParams.toString()}`;
	const body = {
		...rest,
		totalPrice: { currency: 'EUR' },
	};
	const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', body);

	if (!result || !result.ok) {
		return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
	}

	const action = finalize ? 'created and finalized' : 'created as draft';
	return {
		content: [
			{
				type: 'text',
				text: `Dunning ${action} successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
			},
		],
	};
}

server.tool(
	'create-dunning',
	'Create a dunning notice (Mahnung) in Lexware Office for an existing invoice. Note: the Lexware Office API always returns voucherStatus "draft" for dunnings regardless of finalization — this is expected API behaviour. A PDF is generated immediately upon creation.',
	dunningSchema,
	async (params) => handleDunningRequest(params, false),
);

server.tool(
	'finalize-dunning',
	'Create a dunning notice (Mahnung) in Lexware Office for an existing invoice (alias for create-dunning). Note: the Lexware Office API always returns voucherStatus "draft" for dunnings — this is expected API behaviour, not an error. A PDF is generated immediately upon creation.',
	dunningSchema,
	async (params) => handleDunningRequest(params, true),
);

server.tool(
	'get-dunnings',
	'Note: The Lexware Office API does not support listing dunnings. Use get-dunning-details with a known dunning ID instead. Dunning IDs can be found in the relatedVouchers field of an invoice (get-invoice-details).',
	{},
	async () => {
		return {
			content: [{
				type: 'text',
				text: 'The Lexware Office API does not support listing dunnings. To retrieve a dunning, use get-dunning-details with a known dunning ID. You can find dunning IDs in the relatedVouchers field of the associated invoice (use get-invoice-details).',
			}],
		};
	},
);

server.tool(
	'get-dunning-details',
	'Get details of a dunning notice (Mahnung) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the dunning'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/dunnings/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve dunning data' }] };
		}

		return {
			content: [{ type: 'text', text: `Dunning details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'create-voucher',
	'Create a new bookkeeping voucher (Buchungsbeleg) in Lexware Office. Set voucherStatus: "open" to finalize immediately; omit for unchecked (default). Use list-posting-categories for valid categoryId values. §13b Reverse Charge (Drittland/non-EU supplier): use taxType: "vatfree", taxRatePercent: 19, taxAmount: 0 — §13b-specific posting categories (splitAllowed: false) have undocumented validation rules and may reject; use a standard equivalent category until confirmed.',
	{
		type: z
			.enum(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote'])
			.describe(
				'Voucher type: purchaseinvoice (Eingangsrechnung), purchasecreditnote (Eingangsgutschrift), salesinvoice (Ausgangsrechnung), salescreditnote (Ausgangsgutschrift)',
			),
		voucherDate: z.string().describe('Voucher date in ISO 8601 format, e.g. "2026-03-22T00:00:00.000+01:00"'),
		voucherNumber: z.string().optional().describe("The supplier's invoice number as printed on the document"),
		dueDate: z.string().optional().describe('Due date in ISO 8601 format'),
		contactId: z.string().uuid().optional().describe('Reference to an existing contact (Lieferant/Kunde)'),
		remark: z.string().optional().describe('Internal note'),
		taxType: z
			.enum(['net', 'gross', 'vatfree'])
			.describe('"net" = Netto, "gross" = Brutto, "vatfree" = steuerfrei'),
		voucherItems: z
			.array(
				z.object({
					amount: z.number().describe('Gross amount, e.g. 119.00'),
					taxAmount: z.number().describe('Tax amount, e.g. 19.00'),
					taxRatePercent: z.number().describe('Tax rate: 0, 7, or 19'),
					categoryId: z
						.string()
						.uuid()
						.describe('Posting category ID from list-posting-categories'),
				}),
			)
			.min(1),
		voucherStatus: z.enum(['unchecked', 'open']).optional().describe("Set the voucher status. 'open' finalizes immediately. Omit to create as 'unchecked'."),
	},
	async (params) => {
		const totalGrossAmount = params.voucherItems.reduce((sum, item) => sum + item.amount, 0);
		const totalTaxAmount = params.voucherItems.reduce((sum, item) => sum + item.taxAmount, 0);
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/vouchers', 'POST', {
			...params,
			totalGrossAmount,
			totalTaxAmount,
		});

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [
				{
					type: 'text',
					text: `Voucher created successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
				},
			],
		};
	},
);

server.tool(
	'update-voucher',
	'Update an existing bookkeeping voucher in Lexware Office. Requires the current version number (get it from get-voucher-details). Set voucherStatus: "open" to finalize (unchecked → open). File attachments are preserved automatically. §13b Reverse Charge (Drittland/non-EU supplier): use taxType: "vatfree", taxRatePercent: 19, taxAmount: 0 — §13b-specific posting categories (splitAllowed: false) have undocumented validation rules and may reject; use a standard equivalent category until confirmed.',
	{
		id: z.string().uuid().describe('The ID of the voucher to update'),
		version: z.number().int().describe('Current version of the voucher (for optimistic locking)'),
		type: z.enum(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote']),
		voucherDate: z.string().describe('Voucher date in ISO 8601 format'),
		voucherNumber: z.string().optional().describe("The supplier's invoice number as printed on the document"),
		dueDate: z.string().optional(),
		contactId: z.string().uuid().optional(),
		remark: z.string().optional(),
		taxType: z.enum(['net', 'gross', 'vatfree']),
		voucherItems: z
			.array(
				z.object({
					amount: z.number().describe('Gross amount, e.g. 119.00'),
					taxAmount: z.number().describe('Tax amount, e.g. 19.00'),
					taxRatePercent: z.number(),
					categoryId: z.string().uuid(),
				}),
			)
			.min(1),
		voucherStatus: z.enum(['unchecked', 'open']).optional().describe("Set the voucher status. 'open' finalizes the voucher (unchecked → open)."),
	},
	async ({ id, ...body }) => {
		const LEXOFFICE_API_BASE = 'https://api.lexware.io';
		const LEXWARE_OFFICE_API_KEY = process.env.LEXWARE_OFFICE_API_KEY!;

		// Save file IDs before PUT — Lexware API silently drops all attachments on PUT
		const currentVoucher = await makeLexwareOfficeRequest<any>(`/v1/vouchers/${id}`);
		if (!currentVoucher) {
			return { content: [{ type: 'text', text: 'Failed to fetch current voucher before update — aborting to prevent file loss. Check connectivity and try again.' }] };
		}
		const savedFileIds: string[] = Array.isArray(currentVoucher.files) ? currentVoucher.files : [];

		const totalGrossAmount = body.voucherItems.reduce((sum, item) => sum + item.amount, 0);
		const totalTaxAmount = body.voucherItems.reduce((sum, item) => sum + item.taxAmount, 0);
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/vouchers/${id}`, 'PUT', {
			...body,
			totalGrossAmount,
			totalTaxAmount,
		});

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		// Re-attach files that were present before the PUT
		const reattachWarnings: string[] = [];
		for (const fileId of savedFileIds) {
			try {
				// Raw fetch: makeLexwareOfficeFileRequest type-constrains Accept to PDF/XML and is
				// designed for the get-file MCP response path, not for internal file transfers.
				const downloadResponse = await fetch(`${LEXOFFICE_API_BASE}/v1/files/${fileId}`, {
					headers: {
						'Accept': '*/*',
						'Authorization': `Bearer ${LEXWARE_OFFICE_API_KEY}`,
					},
				});
				if (!downloadResponse.ok) {
					reattachWarnings.push(`${fileId} (download failed: ${downloadResponse.status})`);
					continue;
				}
				const contentType = downloadResponse.headers.get('content-type') ?? 'application/pdf';
				const contentDisposition = downloadResponse.headers.get('content-disposition') ?? '';
				const filename = contentDisposition.match(/filename="?([^";\n]+)"?/)?.[1] ?? `${fileId}.pdf`;
				const fileBuffer = await downloadResponse.arrayBuffer();
				const blob = new Blob([fileBuffer], { type: contentType });
				const formData = new FormData();
				formData.append('file', blob, filename);
				const uploadResult = await makeLexwareOfficeMultipartRequest<any>(`/v1/vouchers/${id}/files`, formData);
				if (!uploadResult || !uploadResult.ok) {
					reattachWarnings.push(`${fileId} (upload failed)`);
				}
			} catch {
				reattachWarnings.push(`${fileId} (error)`);
			}
		}

		const warningText = reattachWarnings.length > 0
			? `\n\nWarning: could not re-attach file(s): ${reattachWarnings.join(', ')} — re-attach manually using upload-file-to-voucher.`
			: '';

		return {
			content: [
				{
					type: 'text',
					text: `Voucher updated successfully:\n\n${JSON.stringify(result.data, null, 2)}${warningText}`,
				},
			],
		};
	},
);

server.tool(
	'duplicate-voucher',
	'Duplicates an existing bookkeeping voucher including all file attachments. Equivalent to "Beleg duplizieren" in Lexware Office UI.',
	{
		sourceVoucherId: z.string().uuid().describe('ID of the voucher to duplicate'),
		voucherNumber: z.string().optional().describe("New voucher number (e.g. 'INV-2024-05'). If omitted, Lexware auto-assigns (useful for sales vouchers with sequential numbering)."),
		voucherDate: z.string().optional().describe('Voucher date in ISO 8601 format. If omitted, copied from source.'),
		dueDate: z.string().optional().describe('Due date in ISO 8601 format. If omitted, copied from source.'),
		voucherStatus: z.enum(['unchecked', 'open']).optional().default('open').describe("Status of the new voucher. Default: 'open'."),
	},
	async ({ sourceVoucherId, voucherNumber, voucherDate, dueDate, voucherStatus }) => {
		const LEXOFFICE_API_BASE = 'https://api.lexware.io';
		const LEXWARE_OFFICE_API_KEY = process.env.LEXWARE_OFFICE_API_KEY!;

		const source = await makeLexwareOfficeRequest<any>(`/v1/vouchers/${sourceVoucherId}`);
		if (!source) {
			return { content: [{ type: 'text', text: `Failed to fetch source voucher ${sourceVoucherId} — not found or inaccessible.` }] };
		}

		const body: Record<string, unknown> = {
			type: source.type,
			taxType: source.taxType,
			voucherItems: source.voucherItems,
			totalGrossAmount: source.totalGrossAmount,
			totalTaxAmount: source.totalTaxAmount,
			voucherDate: voucherDate ?? source.voucherDate,
			voucherStatus,
		};
		if (voucherNumber !== undefined) body.voucherNumber = voucherNumber;
		if (dueDate !== undefined) body.dueDate = dueDate;
		else if (source.dueDate !== undefined) body.dueDate = source.dueDate;
		if (source.contactId !== undefined) body.contactId = source.contactId;
		if (source.remark !== undefined) body.remark = source.remark;

		const result = await makeLexwareOfficeWriteRequest<any>('/v1/vouchers', 'POST', body);
		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}
		const newId: string = result.data.id;

		const sourceFileIds: string[] = Array.isArray(source.files) ? source.files : [];
		const fileWarnings: string[] = [];
		let attachedFiles = 0;

		for (const fileId of sourceFileIds) {
			try {
				const downloadResponse = await fetch(`${LEXOFFICE_API_BASE}/v1/files/${fileId}`, {
					headers: {
						'Accept': '*/*',
						'Authorization': `Bearer ${LEXWARE_OFFICE_API_KEY}`,
					},
				});
				if (!downloadResponse.ok) {
					fileWarnings.push(`${fileId} (download failed: ${downloadResponse.status})`);
					continue;
				}
				const contentType = downloadResponse.headers.get('content-type') ?? 'application/pdf';
				const contentDisposition = downloadResponse.headers.get('content-disposition') ?? '';
				const filename = contentDisposition.match(/filename="?([^";\n]+)"?/)?.[1] ?? `${fileId}.pdf`;
				const fileBuffer = await downloadResponse.arrayBuffer();
				const blob = new Blob([fileBuffer], { type: contentType });
				const formData = new FormData();
				formData.append('file', blob, filename);
				const uploadResult = await makeLexwareOfficeMultipartRequest<any>(`/v1/vouchers/${newId}/files`, formData);
				if (!uploadResult || !uploadResult.ok) {
					fileWarnings.push(`${fileId} (upload failed)`);
				} else {
					attachedFiles++;
				}
			} catch {
				fileWarnings.push(`${fileId} (error)`);
			}
		}

		const summary: Record<string, unknown> = {
			id: newId,
			voucherNumber: result.data.voucherNumber,
			voucherDate: result.data.voucherDate ?? body.voucherDate,
			totalGrossAmount: result.data.totalGrossAmount,
			attachedFiles,
			sourceVoucherId,
		};
		if (fileWarnings.length > 0) summary.fileWarnings = fileWarnings;

		return {
			content: [{ type: 'text', text: `Voucher duplicated successfully:\n\n${JSON.stringify(summary, null, 2)}` }],
		};
	},
);

server.tool(
	'get-quotations',
	'Get a list of quotations (Angebote) from Lexware Office',
	{
		status: z
			.array(z.enum(['draft', 'open', 'accepted', 'rejected', 'voided']))
			.optional()
			.default(['draft', 'open', 'accepted', 'rejected', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ status, page, size }) => {
		const url = `/v1/voucherlist?voucherType=quotation&voucherStatus=${status.join(',')}&page=${page}&size=${size}`;
		const data = await makeLexwareOfficeRequest<any>(url);
		const vouchers = data?.content;

		if (!vouchers || vouchers.length === 0) {
			return { content: [{ type: 'text', text: 'No quotations found' }] };
		}

		return {
			content: [{
				type: 'text',
				text: `There are ${data.totalElements} quotations in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-quotation-details',
	'Get details of a quotation (Angebot) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the quotation'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/quotations/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve quotation data' }] };
		}

		return {
			content: [{ type: 'text', text: `Quotation details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-credit-notes',
	'Get a list of credit notes (Gutschriften) from Lexware Office',
	{
		status: z
			.array(z.enum(['draft', 'open', 'paid', 'voided']))
			.optional()
			.default(['draft', 'open', 'paid', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ status, page, size }) => {
		const url = `/v1/voucherlist?voucherType=creditnote&voucherStatus=${status.join(',')}&page=${page}&size=${size}`;
		const data = await makeLexwareOfficeRequest<any>(url);
		const vouchers = data?.content;

		if (!vouchers || vouchers.length === 0) {
			return { content: [{ type: 'text', text: 'No credit notes found' }] };
		}

		return {
			content: [{
				type: 'text',
				text: `There are ${data.totalElements} credit notes in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-credit-note-details',
	'Get details of a credit note (Gutschrift) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the credit note'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/credit-notes/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve credit note data' }] };
		}

		return {
			content: [{ type: 'text', text: `Credit note details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-order-confirmations',
	'Get a list of order confirmations (Auftragsbestätigungen) from Lexware Office',
	{
		status: z
			.array(z.enum(['draft', 'open', 'fulfilled', 'voided']))
			.optional()
			.default(['draft', 'open', 'fulfilled', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ status, page, size }) => {
		const url = `/v1/voucherlist?voucherType=orderconfirmation&voucherStatus=${status.join(',')}&page=${page}&size=${size}`;
		const data = await makeLexwareOfficeRequest<any>(url);
		const vouchers = data?.content;

		if (!vouchers || vouchers.length === 0) {
			return { content: [{ type: 'text', text: 'No order confirmations found' }] };
		}

		return {
			content: [{
				type: 'text',
				text: `There are ${data.totalElements} order confirmations in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-order-confirmation-details',
	'Get details of an order confirmation (Auftragsbestätigung) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the order confirmation'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/order-confirmations/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve order confirmation data' }] };
		}

		return {
			content: [{ type: 'text', text: `Order confirmation details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-delivery-notes',
	'Get a list of delivery notes (Lieferscheine) from Lexware Office',
	{
		status: z
			.array(z.enum(['draft', 'open', 'fulfilled', 'voided']))
			.optional()
			.default(['draft', 'open', 'fulfilled', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ status, page, size }) => {
		const url = `/v1/voucherlist?voucherType=deliverynote&voucherStatus=${status.join(',')}&page=${page}&size=${size}`;
		const data = await makeLexwareOfficeRequest<any>(url);
		const vouchers = data?.content;

		if (!vouchers || vouchers.length === 0) {
			return { content: [{ type: 'text', text: 'No delivery notes found' }] };
		}

		return {
			content: [{
				type: 'text',
				text: `There are ${data.totalElements} delivery notes in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-delivery-note-details',
	'Get details of a delivery note (Lieferschein) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the delivery note'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/delivery-notes/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve delivery note data' }] };
		}

		return {
			content: [{ type: 'text', text: `Delivery note details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-down-payment-invoices',
	'Get a list of down payment invoices (Anzahlungsrechnungen) from Lexware Office',
	{
		status: z
			.array(z.enum(['draft', 'open', 'paid', 'voided']))
			.optional()
			.default(['draft', 'open', 'paid', 'voided']),
		contactId: z.string().uuid().optional().describe('Filter by contact ID'),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ status, contactId, page, size }) => {
		let url = `/v1/voucherlist?voucherType=downpaymentinvoice&voucherStatus=${status.join(',')}&page=${page}&size=${size}`;
		if (contactId) url += `&contactId=${contactId}`;
		const data = await makeLexwareOfficeRequest<any>(url);
		const vouchers = data?.content;

		if (!vouchers || vouchers.length === 0) {
			return { content: [{ type: 'text', text: 'No down payment invoices found' }] };
		}

		return {
			content: [{
				type: 'text',
				text: `There are ${data.totalElements} down payment invoices in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-down-payment-invoice-details',
	'Get details of a down payment invoice (Anzahlungsrechnung) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the down payment invoice'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/down-payment-invoices/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve down payment invoice data' }] };
		}

		return {
			content: [{ type: 'text', text: `Down payment invoice details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-profile',
	'Get the company profile (Unternehmensprofil) from Lexware Office, including company name, address, tax settings, and contact information',
	{},
	async () => {
		const data = await makeLexwareOfficeRequest<any>('/v1/profile');

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve profile data' }] };
		}

		return {
			content: [{ type: 'text', text: `Company profile:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'list-print-layouts',
	'Retrieve available print layouts (Drucklayouts) from Lexware Office. Use these IDs when creating invoices or other documents to control the visual appearance.',
	{},
	async () => {
		const data = await makeLexwareOfficeRequest<any>('/v1/print-layouts');

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve print layouts' }] };
		}

		return {
			content: [{ type: 'text', text: `Print layouts:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-recurring-templates',
	'Get a list of recurring invoice templates (Wiederkehrende Vorlagen) from Lexware Office',
	{
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ page, size }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/recurring-templates?page=${page}&size=${size}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve recurring templates' }] };
		}

		return {
			content: [{ type: 'text', text: `Recurring templates:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-articles',
	'Get a list of articles (Artikel/Produkte) from Lexware Office with optional filters',
	{
		articleNumber: z.string().optional().describe('Filter by article number (Artikelnummer)'),
		name: z.string().optional().describe('Filter by article name (substring search)'),
		type: z.enum(['PRODUCT', 'SERVICE']).optional().describe('Filter by article type'),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('number of results per page'),
	},
	async ({ articleNumber, name, type, page, size }) => {
		const params = new URLSearchParams({ page: String(page), size: String(size) });
		if (articleNumber) params.append('articleNumber', articleNumber);
		if (name) params.append('name', name);
		if (type) params.append('type', type);

		const data = await makeLexwareOfficeRequest<any>(`/v1/articles?${params.toString()}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve articles' }] };
		}

		return {
			content: [{ type: 'text', text: `Articles:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-article-details',
	'Get details of an article (Artikel/Produkt) from Lexware Office by its ID',
	{
		id: z.string().uuid().describe('The ID of the article'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/articles/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve article data' }] };
		}

		return {
			content: [{ type: 'text', text: `Article details:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

const quotationSchema = {
	...invoiceSchema,
	expirationDate: z.string().optional().describe('Expiration date of the quotation in ISO 8601 format, e.g. "2026-05-22T00:00:00.000+01:00"'),
};

async function handleQuotationRequest(
	params: Record<string, unknown>,
	finalize: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
	const path = finalize ? '/v1/quotations?finalize=true' : '/v1/quotations';
	const body = {
		...params,
		totalPrice: { currency: 'EUR' },
	};
	const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', body);

	if (!result || !result.ok) {
		return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
	}

	const action = finalize ? 'created and finalized' : 'created as draft';
	return {
		content: [
			{
				type: 'text',
				text: `Quotation ${action} successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
			},
		],
	};
}

server.tool(
	'create-quotation',
	'Create a new quotation (Angebot) as a draft in Lexware Office. The quotation will not be sent to the customer. Use finalize-quotation to create and immediately finalize.',
	quotationSchema,
	async (params) => handleQuotationRequest(params, false),
);

server.tool(
	'finalize-quotation',
	'Create and immediately finalize (publish) a quotation (Angebot) in Lexware Office. The quotation will be locked and cannot be edited. Use create-quotation to create a draft first.',
	quotationSchema,
	async (params) => handleQuotationRequest(params, true),
);

const creditNoteSchema = {
	...invoiceSchema,
	precedingSalesVoucherId: z
		.string()
		.uuid()
		.optional()
		.describe('ID of the original invoice this credit note refers to (optional)'),
};

async function handleCreditNoteRequest(
	params: Record<string, unknown>,
	finalize: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
	const path = finalize ? '/v1/credit-notes?finalize=true' : '/v1/credit-notes';
	const body = {
		...params,
		totalPrice: { currency: 'EUR' },
	};
	const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', body);

	if (!result || !result.ok) {
		return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
	}

	const action = finalize ? 'created and finalized' : 'created as draft';
	return {
		content: [
			{
				type: 'text',
				text: `Credit note ${action} successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
			},
		],
	};
}

server.tool(
	'create-credit-note',
	'Create a new credit note (Gutschrift) as a draft in Lexware Office. Use finalize-credit-note to create and immediately finalize.',
	creditNoteSchema,
	async (params) => handleCreditNoteRequest(params, false),
);

server.tool(
	'finalize-credit-note',
	'Create and immediately finalize a credit note (Gutschrift) in Lexware Office. The credit note will be locked and cannot be edited.',
	creditNoteSchema,
	async (params) => handleCreditNoteRequest(params, true),
);

async function handleOrderConfirmationRequest(
	params: Record<string, unknown>,
	finalize: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
	const path = finalize ? '/v1/order-confirmations?finalize=true' : '/v1/order-confirmations';
	const body = {
		...params,
		totalPrice: { currency: 'EUR' },
	};
	const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', body);

	if (!result || !result.ok) {
		return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
	}

	const action = finalize ? 'created and finalized' : 'created as draft';
	return {
		content: [
			{
				type: 'text',
				text: `Order confirmation ${action} successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
			},
		],
	};
}

server.tool(
	'create-order-confirmation',
	'Create a new order confirmation (Auftragsbestätigung) as a draft in Lexware Office. Use finalize-order-confirmation to create and immediately finalize.',
	invoiceSchema,
	async (params) => handleOrderConfirmationRequest(params, false),
);

server.tool(
	'finalize-order-confirmation',
	'Create and immediately finalize an order confirmation (Auftragsbestätigung) in Lexware Office. The document will be locked and cannot be edited.',
	invoiceSchema,
	async (params) => handleOrderConfirmationRequest(params, true),
);

const deliveryNoteLineItemSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('material'),
		id: z.string().uuid().describe('Article ID from Lexware article catalog — required for material type'),
		name: z.string().describe('Line item name'),
		description: z.string().optional().describe('Additional description text shown below the item name'),
		quantity: z.number().describe('Quantity'),
		unitName: z.string().describe('Unit name, e.g. "Stück", "kg"'),
	}),
	z.object({
		type: z.literal('service'),
		id: z.string().uuid().describe('Service/article ID from Lexware article catalog — required for service type'),
		name: z.string().describe('Line item name'),
		description: z.string().optional().describe('Additional description text shown below the item name'),
		quantity: z.number().describe('Quantity'),
		unitName: z.string().describe('Unit name, e.g. "Stück", "kg"'),
	}),
	z.object({
		type: z.literal('custom'),
		name: z.string().describe('Line item name'),
		description: z.string().optional().describe('Additional description text shown below the item name'),
		quantity: z.number().describe('Quantity'),
		unitName: z.string().describe('Unit name, e.g. "Stück", "kg"'),
	}),
	z.object({
		type: z.literal('text'),
		name: z.string().describe('Free text line'),
	}),
]);

const deliveryNoteSchema = {
	voucherDate: z.string().describe('Delivery note date in ISO 8601 format, e.g. "2026-03-22T00:00:00.000+01:00"'),
	address: invoiceAddressSchema,
	lineItems: z.array(deliveryNoteLineItemSchema).min(1),
	taxConditions: z.object({
		taxType: z
			.enum(['net', 'gross', 'vatfree'])
			.describe('"net" = Netto, "gross" = Brutto, "vatfree" = steuerfrei'),
	}).describe('Tax conditions — required by Lexoffice API even for delivery notes'),
	shippingConditions: z.object({
		shippingDate: z.string().describe('Delivery date in ISO 8601 format'),
		shippingEndDate: z.string().optional().describe('End date for period types'),
		shippingType: z
			.enum(['service', 'delivery', 'serviceperiod', 'deliveryperiod'])
			.describe('"delivery" = Lieferdatum, "deliveryperiod" = Lieferzeitraum'),
	}).describe('Shipping/delivery conditions — required by Lexoffice API'),
	introduction: z.string().optional().describe('Introductory text before line items'),
	remark: z.string().optional().describe('Closing text after line items'),
};

async function handleDeliveryNoteRequest(
	params: Record<string, unknown>,
	finalize: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
	const path = finalize ? '/v1/delivery-notes?finalize=true' : '/v1/delivery-notes';
	const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', params);

	if (!result || !result.ok) {
		return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
	}

	const action = finalize ? 'created and finalized' : 'created as draft';
	return {
		content: [
			{
				type: 'text',
				text: `Delivery note ${action} successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
			},
		],
	};
}

server.tool(
	'create-delivery-note',
	'Create a new delivery note (Lieferschein) as a draft in Lexware Office. Delivery notes are logistics documents without pricing. Use finalize-delivery-note to create and immediately finalize.',
	deliveryNoteSchema,
	async (params) => handleDeliveryNoteRequest(params, false),
);

server.tool(
	'finalize-delivery-note',
	'Create and immediately finalize a delivery note (Lieferschein) in Lexware Office. The document will be locked and cannot be edited.',
	deliveryNoteSchema,
	async (params) => handleDeliveryNoteRequest(params, true),
);

const articlePriceSchema = z.object({
	leadingPrice: z.enum(['NET', 'GROSS']).describe('"NET" to specify net price, "GROSS" to specify gross price'),
	netPrice: z.number().optional().describe('Net price, e.g. 90.00 — required when leadingPrice is "NET"'),
	grossPrice: z.number().optional().describe('Gross price incl. tax — required when leadingPrice is "GROSS"'),
	taxRate: z.number().describe('Tax rate percentage, e.g. 19 for 19%, 7 for 7%, 0 for tax-free'),
});

server.tool(
	'create-article',
	'Create a new article (Artikel/Produkt) in Lexware Office. Articles can be reused when creating invoices, quotations, and other documents.',
	{
		type: z.enum(['PRODUCT', 'SERVICE']).describe('Article type: PRODUCT (Ware) or SERVICE (Dienstleistung)'),
		title: z.string().describe('Article name/title'),
		description: z.string().optional().describe('Article description'),
		articleNumber: z.string().optional().describe('Article number (Artikelnummer)'),
		unitName: z.string().optional().describe('Unit name, e.g. "Stunden", "Stück"'),
		price: articlePriceSchema.optional().describe('Selling price of the article'),
	},
	async ({ type, title, description, articleNumber, unitName, price }) => {
		const body: Record<string, unknown> = { type, title };
		if (description) body.description = description;
		if (articleNumber) body.articleNumber = articleNumber;
		if (unitName) body.unitName = unitName;
		if (price) body.price = price;

		const result = await makeLexwareOfficeWriteRequest<any>('/v1/articles', 'POST', body);

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [
				{
					type: 'text',
					text: `Article created successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
				},
			],
		};
	},
);

server.tool(
	'update-article',
	'Update an existing article (Artikel/Produkt) in Lexware Office. Requires the current version number for optimistic locking (get it from get-article-details).',
	{
		id: z.string().uuid().describe('The ID of the article to update'),
		version: z.number().int().describe('Current version of the article (for optimistic locking)'),
		type: z.enum(['PRODUCT', 'SERVICE']).describe('Article type: PRODUCT (Ware) or SERVICE (Dienstleistung)'),
		title: z.string().describe('Article name/title'),
		description: z.string().optional().describe('Article description'),
		articleNumber: z.string().optional().describe('Article number (Artikelnummer)'),
		unitName: z.string().optional().describe('Unit name, e.g. "Stunden", "Stück"'),
		price: articlePriceSchema.optional().describe('Selling price of the article'),
	},
	async ({ id, version, type, title, description, articleNumber, unitName, price }) => {
		const body: Record<string, unknown> = { version, type, title };
		if (description) body.description = description;
		if (articleNumber) body.articleNumber = articleNumber;
		if (unitName) body.unitName = unitName;
		if (price) body.price = price;

		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/articles/${id}`, 'PUT', body);

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [
				{
					type: 'text',
					text: `Article updated successfully:\n\n${JSON.stringify(result.data, null, 2)}`,
				},
			],
		};
	},
);

server.tool(
	'delete-article',
	'Delete an article (Artikel/Produkt) from Lexware Office. This action is irreversible. To prevent accidental deletion, this tool can be blocked via denyTools in settings.json.',
	{
		id: z.string().uuid().describe('The ID of the article to delete'),
	},
	async ({ id }) => {
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/articles/${id}`, 'DELETE');

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [{ type: 'text', text: `Article ${id} deleted successfully.` }],
		};
	},
);

const EVENT_TYPES = [
	'article.created', 'article.changed', 'article.deleted',
	'contact.created', 'contact.changed', 'contact.deleted',
	'credit-note.created', 'credit-note.changed', 'credit-note.deleted', 'credit-note.status.changed',
	'delivery-note.created', 'delivery-note.changed', 'delivery-note.deleted', 'delivery-note.status.changed',
	'down-payment-invoice.created', 'down-payment-invoice.changed', 'down-payment-invoice.deleted', 'down-payment-invoice.status.changed',
	'dunning.created', 'dunning.changed', 'dunning.deleted',
	'invoice.created', 'invoice.changed', 'invoice.deleted', 'invoice.status.changed',
	'order-confirmation.created', 'order-confirmation.changed', 'order-confirmation.deleted', 'order-confirmation.status.changed',
	'payment.changed',
	'quotation.created', 'quotation.changed', 'quotation.deleted', 'quotation.status.changed',
	'recurring-template.created', 'recurring-template.changed', 'recurring-template.deleted',
	'voucher.created', 'voucher.changed', 'voucher.deleted', 'voucher.status.changed',
] as const;

server.tool(
	'list-event-subscriptions',
	'Retrieve all webhook event subscriptions from Lexware Office.',
	{},
	async () => {
		const data = await makeLexwareOfficeRequest<any>('/v1/event-subscriptions');

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve event subscriptions' }] };
		}

		return {
			content: [{ type: 'text', text: `Event subscriptions:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'get-event-subscription',
	'Retrieve a specific webhook event subscription from Lexware Office by its ID.',
	{
		id: z.string().uuid().describe('The ID of the event subscription'),
	},
	async ({ id }) => {
		const data = await makeLexwareOfficeRequest<any>(`/v1/event-subscriptions/${id}`);

		if (!data) {
			return { content: [{ type: 'text', text: 'Failed to retrieve event subscription' }] };
		}

		return {
			content: [{ type: 'text', text: `Event subscription:\n\n${JSON.stringify(data, null, 2)}` }],
		};
	},
);

server.tool(
	'create-event-subscription',
	'Create a webhook event subscription in Lexware Office. Lexware will send a POST request to the callbackUrl whenever the specified event occurs.',
	{
		eventType: z.enum(EVENT_TYPES).describe('The event type to subscribe to'),
		callbackUrl: z.string().url().describe('The webhook URL that will receive event notifications'),
	},
	async ({ eventType, callbackUrl }) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/event-subscriptions', 'POST', {
			eventType,
			callbackUrl,
		});

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [{ type: 'text', text: `Event subscription created successfully:\n\n${JSON.stringify(result.data, null, 2)}` }],
		};
	},
);

server.tool(
	'delete-event-subscription',
	'Delete a webhook event subscription from Lexware Office by its ID.',
	{
		id: z.string().uuid().describe('The ID of the event subscription to delete'),
	},
	async ({ id }) => {
		const result = await makeLexwareOfficeWriteRequest<void>(`/v1/event-subscriptions/${id}`, 'DELETE');

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [{ type: 'text', text: `Event subscription ${id} deleted successfully.` }],
		};
	},
);

function resolveMimeType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const map: Record<string, string> = {
		'.pdf': 'application/pdf',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.png': 'image/png',
		'.xml': 'application/xml',
	};
	const mime = map[ext];
	if (!mime) throw new Error(`Unsupported file extension "${ext}". Supported: .pdf, .jpg, .jpeg, .png, .xml`);
	return mime;
}

server.tool(
	'upload-file',
	'Upload a file (PDF, JPG, PNG, or XML) to Lexware Office for bookkeeping purposes. Returns a file ID. Max file size: 5 MB. For XML (e-invoice), the "E-Rechnung" feature must be enabled in Lexware Office settings.',
	{
		filePath: z.string().describe('Absolute path to the file on the server (max 5 MB). Supported: .pdf, .jpg, .jpeg, .png, .xml'),
	},
	async ({ filePath }) => {
		const mimeType = resolveMimeType(filePath);
		const fileBuffer = readFileSync(filePath);
		const blob = new Blob([fileBuffer], { type: mimeType });
		const formData = new FormData();
		formData.append('file', blob, basename(filePath));
		formData.append('type', 'voucher');

		const result = await makeLexwareOfficeMultipartRequest<any>('/v1/files', formData);

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [{ type: 'text', text: `File uploaded successfully:\n\n${JSON.stringify(result.data, null, 2)}` }],
		};
	},
);

server.tool(
	'upload-file-to-voucher',
	'Upload and assign a file (PDF, JPG, PNG, or XML) directly to an existing voucher (Beleg) in Lexware Office. Use this to attach a receipt image or invoice PDF to a bookkeeping entry.',
	{
		voucherId: z.string().uuid().describe('The ID of the voucher to attach the file to'),
		filePath: z.string().describe('Absolute path to the file on the server (max 5 MB). Supported: .pdf, .jpg, .jpeg, .png, .xml'),
	},
	async ({ voucherId, filePath }) => {
		const mimeType = resolveMimeType(filePath);
		const fileBuffer = readFileSync(filePath);
		const blob = new Blob([fileBuffer], { type: mimeType });
		const formData = new FormData();
		formData.append('file', blob, basename(filePath));

		const result = await makeLexwareOfficeMultipartRequest<any>(`/v1/vouchers/${voucherId}/files`, formData);

		if (!result || !result.ok) {
			return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		}

		return {
			content: [{ type: 'text', text: `File uploaded to voucher ${voucherId} successfully:\n\n${JSON.stringify(result.data, null, 2)}` }],
		};
	},
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.log('Lexware Office MCP Server running on stdio');
}

main().catch((error) => {
	logger.error('Fatal error in main():', { error });
	process.exit(1);
});
