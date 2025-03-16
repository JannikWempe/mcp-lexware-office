import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeLexwareOfficeRequest } from './helper.js';
import { logger } from './logger.js';

const server = new McpServer({
	name: 'lexware-office',
	version: '0.1.1',
});

server.tool(
	'get-invoices',
	'Get a list of invoices from Lexware Office',
	{
		status: z
			.array(z.enum(['open', 'draft', 'paid', 'paidoff', 'voided']))
			.optional()
			.default(['open', 'draft', 'paid', 'paidoff', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z
			.number()
			.min(1)
			.max(250)
			.optional()
			.default(250)
			.describe('number of invoices to retrieve per page'),
	},
	async ({ status }) => {
		const voucherlistUrl = `/v1/voucherlist?voucherType=invoice&voucherStatus=${status.join(',')}`;
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
		page: z.number().min(0).optional().default(0).describe('page number to retrieve; starts at 0'),
		size: z
			.number()
			.min(1)
			.max(250)
			.optional()
			.default(250)
			.describe('number of contacts to retrieve per page'),
	},
	async ({ email, name, number, customer, vendor }) => {
		const params = new URLSearchParams();
		if (email) params.append('email', email);
		if (name) params.append('name', name);
		if (number) params.append('number', number.toString());
		if (customer !== undefined) params.append('customer', customer.toString());
		if (vendor !== undefined) params.append('vendor', vendor.toString());

		const contactsUrl = `/v1/contacts?${params.toString()}`;
		const contactsData = await makeLexwareOfficeRequest<any>(contactsUrl);

		if (!contactsData) {
			return {
				content: [
					{
						type: 'text',
						text: 'Failed to retrieve contacts',
					},
				],
			};
		}

		const response = `Contacts:\n\n${JSON.stringify(contactsData, null, 2)}`;

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

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.log('Lexware Office MCP Server running on stdio');
}

main().catch((error) => {
	logger.error('Fatal error in main():', { error });
	process.exit(1);
});
