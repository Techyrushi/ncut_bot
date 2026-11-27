# API documentation

Base URL: `http://localhost:5000/api/v1`. JSON responses use `{ "success": true, "data": ... }`; errors use `{ "success": false, "error": { "code": "...", "message": "..." } }`.

Login obtains a bearer token. Supply it as `Authorization: Bearer <token>` on protected endpoints. Roles: `ADMIN` and `SALES`; product writes, assignment, team management, template changes, and WhatsApp configuration are admin-only.

## Endpoints

| Method    | Path                                                     | Auth                | Notes                                                                                  |
| --------- | -------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| GET       | `/health`                                                | No                  | Reports database connectivity                                                          |
| POST      | `/auth/login`                                            | No                  | `{email,password}`                                                                     |
| POST      | `/auth/logout`                                           | Yes                 | Revokes current JWT                                                                    |
| GET       | `/auth/me`                                               | Yes                 | Revalidates the session and returns current user identity                              |
| PATCH     | `/auth/account`                                          | Yes                 | `{currentPassword,email?,newPassword?}`; changes credentials and invalidates old sessions |
| GET       | `/products?page=1&limit=20&search=&category=&active=all` | Yes                 | Paginated product list                                                                 |
| GET       | `/products/categories`                                    | Yes                 | Distinct catalogue categories for searchable admin selection and filters                 |
| GET       | `/products/:id`                                          | Yes                 | Product detail                                                                         |
| POST      | `/products`                                              | Admin               | Create verified product data                                                           |
| POST      | `/products/image-upload`                                 | Admin/Sales          | JPEG, PNG, or WebP binary body, up to 5 MiB; returns a public `imageUrl`                |
| PUT       | `/products/:id`                                          | Admin               | Partial update; validates supplied fields                                              |
| DELETE    | `/products/:id`                                          | Admin               | Soft archive                                                                           |
| GET       | `/customers?page=&limit=&search=&optInStatus=`            | Admin/Sales         | Search customers and filter by `UNKNOWN`, `OPTED_IN`, or `OPTED_OUT`                   |
| GET       | `/customers/import-sample.xlsx`                          | Admin               | Download the consent-import spreadsheet header template                                |
| POST      | `/customers/import`                                      | Admin               | Raw CSV/XLSX with phone, `OPTED_IN`, and consent source; name and ISO consent date are optional; requires `X-Consent-Verified: true` |
| GET       | `/customers/:id`                                         | Admin/Sales         | Customer details                                                                       |
| PATCH     | `/customers/:id/opt-in`                                  | Admin/Sales         | `{status,source}`; record verified consent or opt-out                                  |
| GET       | `/conversations?status=`                                 | Admin/Sales         | Paginated conversations with customer                                                  |
| GET       | `/conversations/:id`                                     | Admin/Sales         | Conversation detail                                                                    |
| GET       | `/conversations/:id/messages?before=&limit=`             | Admin/Sales         | Chronological message history                                                          |
| POST      | `/conversations/:id/read`                                 | Admin/Sales         | Sends a WhatsApp read receipt and clears persisted inbound unread messages             |
| PATCH     | `/conversations/:id/status`                              | Admin/Sales         | `{status:"CLOSED"}`                                                                    |
| POST      | `/conversations/:id/resume-automation`                   | Admin/Sales         | Resumes from sales handover and resets product-selection state                         |
| GET       | `/leads?search=&status=&assignedSalesPerson=&startDate=&endDate=&page=&limit=` | Admin/Sales | Search and filter leads by customer/product, status, assignee (`assigned`, `unassigned`, or a user ID), and inclusive UTC creation dates |
| GET       | `/leads/export.csv?search=&status=&assignedSalesPerson=&startDate=&endDate=` | Admin/Sales | Download every lead matching the active filters as a CSV                                |
| GET       | `/leads/:id`                                             | Admin/Sales         | Lead and selected product details                                                      |
| PATCH     | `/leads/:id/status`                                      | Admin/Sales         | `{status}`                                                                             |
| PATCH     | `/leads/:id/assign`                                      | Admin               | `{userId}` (active sales user) or `{userId:""}` to unassign                            |
| POST      | `/bulk-campaigns/media`                                  | Admin               | Raw image/video/document upload; returns WhatsApp-fetchable media metadata              |
| POST      | `/bulk-campaigns`                                        | Admin               | Create a draft from message text and/or uploaded media; does not send                   |
| POST      | `/bulk-campaigns/:id/import`                             | Admin               | Raw CSV/XLSX upload; deduplicates numbers and previews consent/window eligibility        |
| GET       | `/bulk-campaigns?page=&limit=`                           | Admin               | Campaign history and per-recipient delivery counts                                      |
| GET       | `/bulk-campaigns/:id?status=&page=&limit=`               | Admin               | Campaign details and recipient-level UNSENT/QUEUED/SENT/DELIVERED/READ/FAILED activity  |
| POST      | `/bulk-campaigns/:id/recipients/:recipientId/record-opt-in` | Admin             | `{consentSource,confirmed:true}`; records verified consent for one unsent recipient in a READY campaign |
| POST      | `/bulk-campaigns/:id/recipients/record-opt-in-bulk`      | Admin               | `{recipientIds,consentSource,confirmed:true}`; records verified consent for up to 100 selected unknown/non-consented contacts; opted-out, ambiguous, and invalid numbers are skipped |
| POST      | `/bulk-campaigns/:id/send`                               | Admin               | Queue the previewed eligible recipients for paced sending                              |
| POST      | `/bulk-campaigns/:id/recipients/retry-failed`             | Admin               | `{recipientIds,confirmed:true}`; manually retries up to 100 selected failed recipients through the paced queue; requires a still-opted-in customer and approved template, skips previously accepted sends, and allows up to two retries (three total send attempts) per recipient |
| GET       | `/bulk-campaigns/:id/export.csv?status=`                 | Admin               | Export recipient activity; optional status filter                                       |
| GET/POST  | `/team`                                                  | Admin/Sales / Admin | List or add a sales account                                                            |
| PATCH     | `/team/:id`                                              | Admin               | `{isActive}`                                                                           |
| GET/POST  | `/templates`                                             | Admin/Sales / Admin | List or register Meta template                                                         |
| PATCH     | `/templates/:id/status`                                  | Admin               | Record actual Meta approval status                                                     |
| POST      | `/whatsapp/send-message`                                 | Admin/Sales         | `{customerId,message}`; requires 24-hour window                                        |
| POST      | `/whatsapp/send-image`                                   | Admin/Sales         | `{customerId,imageUrl,caption?}`; requires 24-hour window                              |
| POST      | `/whatsapp/send-template`                                | Admin/Sales         | `{customerId,templateId,components?}`; template must be approved and customer opted in |
| GET       | `/whatsapp/configuration`                                | Admin/Sales         | Safe configuration presence and callback status; no secrets                           |
| POST      | `/whatsapp/configuration/test-connection`                | Admin               | Read-only Meta phone-number metadata check; sends no message                           |
| GET/PATCH | `/settings/workspace`                                    | Admin/Sales / Admin | Public business number and welcome-message settings                                    |
| GET       | `/logs?page=&limit=&source=&search=`                     | Admin               | Paginated, searchable persistent user-activity and service-event history                |
| GET/POST  | `/webhooks/whatsapp`                                     | Meta                | Verify subscription / signed callbacks                                                 |
| GET       | `/dashboard/stats`                                       | Admin/Sales         | Aggregate workspace metrics                                                            |

## Examples

```http
POST /api/v1/auth/login
Content-Type: application/json

{"email":"admin@example.com","password":"<secret>"}
```

```http
PATCH /api/v1/auth/account
Authorization: Bearer <jwt>
Content-Type: application/json

{"currentPassword":"<current-secret>","newPassword":"<new-secret-at-least-12-characters>"}
```

Changing the login email or password requires the current password and issues a new bearer token. Existing sessions are invalidated.

```http
POST /api/v1/products
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "name":"Verified Product Name",
  "slug":"verified-product-name",
  "description":"Business-approved description.",
  "category":"Flap Disc",
  "sizes":["115 mm"],
  "grits":["P60"],
  "colours":[],
  "backing":[],
  "specifications":{"material":"Verified material"}
}
```

```http
PATCH /api/v1/leads/<lead-id>/status
Authorization: Bearer <jwt>
Content-Type: application/json

{"status":"CONTACTED"}
```

## Notes

- Product IDs and user IDs are MongoDB ObjectIds.
- Set `APP_URL` to the public HTTPS API origin so uploaded product images can be fetched by WhatsApp. Keep the upload directory persistent (`/app/uploads` in Compose).
- Customer consent imports accept CSV/XLSX files up to 5 MiB and 500 unique contacts. Every row must include a phone number, `OPTED_IN`, and consent source; customer name and ISO consent date are optional. The admin must affirm verified consent. Existing opted-in contacts, ambiguous numbers matching multiple customer records, and imported opt-outs are skipped without changing their records.
- Bulk campaigns accept CSV/XLSX files up to 5 MiB, 5,000 populated rows, and 500 unique recipients. Numbers are normalized to E.164 (10-digit numbers default to India `+91`); duplicates are skipped. Only existing customers with recorded opt-in and an active 24-hour service window are queued. Unknown, opted-out, non-consented, and expired-window rows remain unsent; approved templates can send outside that window.
- Campaign media supports JPEG/PNG (5 MiB), MP4 video (16 MiB), and PDF/Office/TXT documents (20 MiB). Each recipient is paced through a durable queue and independently tracked; webhook status events update delivery/read records. Interrupted sends are marked failed for manual verification rather than automatically retried, to avoid duplicate messages.
- Pagination defaults to 20 and is capped at 100.
- `DELETE /products/:id` archives rather than physically deleting historical references.
- Activity history stores authenticated write attempts and selected service lifecycle/webhook events; it does not store request bodies, message text, or credentials.
- Seed the initial N-CUT catalogue with `npm --prefix backend run seed:catalogue`. The operation is repeatable and inserts only products whose slugs are not already present.
- Prepare the N-CUT Direct Send enquiry entry with `npm --prefix backend run seed:enquiry-template`. The named UTILITY template is generated by Meta when an admin sends it from a conversation; Direct Send eligibility and customer opt-in are required.
- JSON API and webhook request bodies have a 1 MiB maximum; product image uploads accept up to 5 MiB.
- Full OpenAPI 3.1 file: [`../backend/docs/openapi.yml`](../backend/docs/openapi.yml).
