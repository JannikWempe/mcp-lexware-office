# Lexware Office MCP Server

An MCP server implementation that integrates with Lexware Office (formerly known as Lexoffice), providing a seamless interface for managing business operations through the Model Context Protocol.

## Features

- **Broad Lexware Office API coverage**: 56 tools covering the available read/write workflows exposed by this server
- **Full document lifecycle**: Create, finalize, and download PDFs for invoices, quotations, order confirmations, credit notes, delivery notes, and dunning notices
- **Contact management**: Create, read, and update customers and vendors
- **Bookkeeping**: Vouchers, posting categories, payments, and file uploads
- **Webhooks**: Create, list, and delete event subscriptions

## Tools

### Invoices
| Tool | Description | API |
|---|---|---|
| `get-invoices` | List invoices with optional filters | `GET /v1/invoices` |
| `get-invoice-details` | Get details of a specific invoice | `GET /v1/invoices/{id}` |
| `create-invoice` | Create an invoice as a draft | `POST /v1/invoices` |
| `finalize-invoice` | Create and immediately finalize an invoice | `POST /v1/invoices?finalize=true` |

### Quotations
| Tool | Description | API |
|---|---|---|
| `get-quotations` | List quotations with optional filters | `GET /v1/quotations` |
| `get-quotation-details` | Get details of a specific quotation | `GET /v1/quotations/{id}` |
| `create-quotation` | Create a quotation as a draft | `POST /v1/quotations` |
| `finalize-quotation` | Create and immediately finalize a quotation | `POST /v1/quotations?finalize=true` |

### Order Confirmations
| Tool | Description | API |
|---|---|---|
| `get-order-confirmations` | List order confirmations with optional filters | `GET /v1/order-confirmations` |
| `get-order-confirmation-details` | Get details of a specific order confirmation | `GET /v1/order-confirmations/{id}` |
| `create-order-confirmation` | Create an order confirmation as a draft | `POST /v1/order-confirmations` |
| `finalize-order-confirmation` | Create and immediately finalize an order confirmation | `POST /v1/order-confirmations?finalize=true` |

### Credit Notes
| Tool | Description | API |
|---|---|---|
| `get-credit-notes` | List credit notes with optional filters | `GET /v1/credit-notes` |
| `get-credit-note-details` | Get details of a specific credit note | `GET /v1/credit-notes/{id}` |
| `create-credit-note` | Create a credit note as a draft | `POST /v1/credit-notes` |
| `finalize-credit-note` | Create and immediately finalize a credit note | `POST /v1/credit-notes?finalize=true` |

### Delivery Notes
| Tool | Description | API |
|---|---|---|
| `get-delivery-notes` | List delivery notes with optional filters | `GET /v1/delivery-notes` |
| `get-delivery-note-details` | Get details of a specific delivery note | `GET /v1/delivery-notes/{id}` |
| `create-delivery-note` | Create a delivery note as a draft | `POST /v1/delivery-notes` |
| `finalize-delivery-note` | Create and immediately finalize a delivery note | `POST /v1/delivery-notes?finalize=true` |

### Dunning Notices
| Tool | Description | API |
|---|---|---|
| `get-dunnings` | Helper explaining that listing dunnings is not supported by the API | — |
| `get-dunning-details` | Get details of a specific dunning notice | `GET /v1/dunnings/{id}` |
| `create-dunning` | Create a dunning notice for an existing invoice | `POST /v1/dunnings` |
| `finalize-dunning` | Alias for create-dunning (see note below) | `POST /v1/dunnings?finalize=true` |

> **Note on dunnings:** The Lexware Office API always returns `voucherStatus: "draft"` for dunning notices regardless of the `finalize` parameter. This is expected API behaviour — a PDF is generated immediately upon creation.

### Down-Payment Invoices
| Tool | Description | API |
|---|---|---|
| `get-down-payment-invoices` | List down-payment invoices with optional filters | `GET /v1/down-payment-invoices` |
| `get-down-payment-invoice-details` | Get details of a specific down-payment invoice | `GET /v1/down-payment-invoices/{id}` |

### Contacts
| Tool | Description | API |
|---|---|---|
| `get-contacts` | List contacts with optional filters | `GET /v1/contacts` |
| `get-contact-details` | Get details of a specific contact | `GET /v1/contacts/{id}` |
| `create-contact` | Create a new contact (customer or vendor) | `POST /v1/contacts` |
| `update-contact` | Update an existing contact | `PUT /v1/contacts/{id}` |

### Vouchers (Bookkeeping)
| Tool | Description | API |
|---|---|---|
| `get-vouchers` | List bookkeeping vouchers with optional filters | `GET /v1/voucherlist` |
| `get-voucher-details` | Get details of a specific voucher | `GET /v1/vouchers/{id}` |
| `create-voucher` | Create a bookkeeping voucher (e.g. incoming invoice) | `POST /v1/vouchers` |
| `update-voucher` | Update an existing bookkeeping voucher | `PUT /v1/vouchers/{id}` |
| `duplicate-voucher` | Duplicate a voucher including all file attachments | `GET + POST /v1/vouchers` |
| `list-posting-categories` | List posting categories for bookkeeping | `GET /v1/posting-categories` |

### Articles (Product Catalogue)
| Tool | Description | API |
|---|---|---|
| `get-articles` | List articles with optional filters | `GET /v1/articles` |
| `get-article-details` | Get details of a specific article | `GET /v1/articles/{id}` |
| `create-article` | Create a new article | `POST /v1/articles` |
| `update-article` | Update an existing article | `PUT /v1/articles/{id}` |
| `delete-article` | Delete an article | `DELETE /v1/articles/{id}` |

### Files & Documents
| Tool | Description | API |
|---|---|---|
| `get-file` | Download a file (PDF or XML) by file ID | `GET /v1/files/{id}` |
| `get-document-file` | Download the PDF of a document by document ID; may require a rendered PDF first | `GET /v1/{docType}/{id}/file` |
| `upload-file` | Upload a file and receive a file ID | `POST /v1/files` |
| `upload-file-to-voucher` | Upload a file and attach it to a voucher | `POST /v1/vouchers/{id}/files` |

### Payments & Receivables
| Tool | Description | API |
|---|---|---|
| `get-payments` | Get payment information for an invoice or voucher | `GET /v1/payments` |
| `get-payment-conditions` | List available payment conditions (Zahlungsbedingungen) | `GET /v1/payment-conditions` |
| `get-open-receivables` | Get all open receivables for a customer (invoices + salesinvoice vouchers combined) | `GET /v1/invoices` + `GET /v1/voucherlist` |

### Recurring Templates
| Tool | Description | API |
|---|---|---|
| `get-recurring-templates` | List recurring invoice templates | `GET /v1/recurring-templates` |

### Event Subscriptions (Webhooks)
| Tool | Description | API |
|---|---|---|
| `list-event-subscriptions` | List all webhook event subscriptions | `GET /v1/event-subscriptions` |
| `get-event-subscription` | Get details of a specific event subscription | `GET /v1/event-subscriptions/{id}` |
| `create-event-subscription` | Create a new webhook event subscription | `POST /v1/event-subscriptions` |
| `delete-event-subscription` | Delete an event subscription | `DELETE /v1/event-subscriptions/{id}` |

### Company & Reference Data
| Tool | Description | API |
|---|---|---|
| `get-profile` | Get the company profile (name, address, tax settings) | `GET /v1/profile` |
| `list-countries` | List countries with their tax classifications | `GET /v1/countries` |
| `list-print-layouts` | List available print layouts | `GET /v1/print-layouts` |

## Permission Model

Tools are grouped into three tiers. You can restrict access by disabling tools in your Claude/MCP configuration:

| Tier | Allowed | Disable these tools |
|---|---|---|
| Read-only | All `get-*` and `list-*` tools | `create-*`, `update-*`, `delete-*`, `finalize-*`, `upload-*` |
| Draft mode | + create, update, delete, upload tools | `finalize-invoice`, `finalize-quotation`, `finalize-order-confirmation`, `finalize-credit-note`, `finalize-delivery-note`, `finalize-dunning` |
| Full access | All tools | _(nothing)_ |

Example (draft mode — no finalization):
```json
{
  "mcpServers": {
    "lexware-office": {
      "disabledTools": [
        "finalize-invoice",
        "finalize-quotation",
        "finalize-order-confirmation",
        "finalize-credit-note",
        "finalize-delivery-note",
        "finalize-dunning"
      ]
    }
  }
}
```

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
