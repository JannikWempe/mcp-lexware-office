# Lexware Office MCP Server

An MCP server implementation that integrates with Lexware Office (formerly known as Lexoffice), providing a seamless interface for managing business operations through the Model Context Protocol.

## Features

- **Lexware Office Integration**: Direct integration with the Lexware Office API
- **Business Operations**: Manage invoices, contacts, and other business documents (read-only as of now)

## Tools

The following tools are available through this MCP server:

- **get-invoices**

  - Get a list of invoices from Lexware Office
  - Inputs:
    - `status` (array of strings, optional): Filter by invoice status ("open", "draft", "paid", "paidoff", "voided"). Default: all statuses
    - `page` (number, optional): Page number to retrieve (starts at 0). Default: 0
    - `size` (number, optional): Number of invoices per page (1-250). Default: 250

- **get-invoice-details**

  - Get details of an invoice from Lexware Office
  - Inputs:
    - `id` (string): The UUID of the invoice

- **get-contacts**

  - Get contacts from Lexware Office with optional filters that are combined with a logical AND
  - Inputs:
    - `email` (string, optional): Filter contacts by email address (supports wildcards)
    - `name` (string, optional): Filter contacts by name (supports wildcards)
    - `number` (number, optional): Filter contacts by contact number
    - `customer` (boolean, optional): Filter contacts by customer role
    - `vendor` (boolean, optional): Filter contacts by vendor role
    - `page` (number, optional): Page number to retrieve (starts at 0). Default: 0
    - `size` (number, optional): Number of contacts per page (1-250). Default: 250

- **list-posting-categories**

  - Retrieve list of posting categories for bookkeeping vouchers
  - Inputs:
    - `type` (string, optional): Filter posting categories by type ("income" or "outgo")

- **list-countries**
  - Retrieve list of countries known to lexoffice with their tax classifications
  - Inputs:
    - `taxClassification` (string, optional): Filter countries by tax classification ("de" for Germany, "intraCommunity" for EU countries, or "thirdPartyCountry" for non-EU countries)

## Configuration

### Getting a Lexware Office API key

Visit [https://app.lexoffice.de/addons/public-api](https://app.lexoffice.de/addons/public-api) to get your API key.

### Prerequisites

- Node.js 22 or higher

### Usage with Claude Desktop

Add this to your `claude_desktop_config.json`:

### Docker

```json
{
	"mcpServers": {
		"mcp-lexware-office": {
			"command": "docker",
			"args": ["run", "-i", "--rm", "-e", "LEXWARE_OFFICE_API_KEY", "mcp-lexware-office"],
			"env": {
				"LEXWARE_OFFICE_API_KEY": "YOUR_API_KEY_HERE"
			}
		}
	}
}
```

### NPX

```json
{
	"mcpServers": {
		"mcp-lexware-office": {
			"command": "npx",
			"args": ["-y", "JannikWempe/mcp-lexware-office"],
			"env": {
				"LEXWARE_OFFICE_API_KEY": "YOUR_API_KEY_HERE"
			}
		}
	}
}
```

## Build

Docker build:

```bash
docker build -t mcp-lexware-office:latest -f Dockerfile .
```

## License

This project is licensed under the MIT License. See the LICENSE file in the project repository for full details.
