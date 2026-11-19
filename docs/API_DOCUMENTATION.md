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
| GET       | `/products?page=1&limit=20&search=&category=&active=all` | Yes                 | Paginated product list                                                                 |
| GET       | `/products/:id`                                          | Yes                 | Product detail                                                                         |
| POST      | `/products`                                              | Admin               | Create verified product data                                                           |
| PUT       | `/products/:id`                                          | Admin               | Partial update; validates supplied fields                                              |
| DELETE    | `/products/:id`                                          | Admin               | Soft archive                                                                           |
| GET       | `/customers?page=&limit=&search=`                        | Admin/Sales         | Search name/phone/WhatsApp ID                                                          |
| GET       | `/customers/:id`                                         | Admin/Sales         | Customer details                                                                       |
| PATCH     | `/customers/:id/opt-in`                                  | Admin/Sales         | `{status,source}`; record verified consent or opt-out                                  |
| GET       | `/conversations?status=`                                 | Admin/Sales         | Paginated conversations with customer                                                  |
| GET       | `/conversations/:id`                                     | Admin/Sales         | Conversation detail                                                                    |
| GET       | `/conversations/:id/messages?before=&limit=`             | Admin/Sales         | Chronological message history                                                          |
| PATCH     | `/conversations/:id/status`                              | Admin/Sales         | `{status:"CLOSED"}`                                                                    |
| GET       | `/leads?status=&assignedSalesPerson=`                    | Admin/Sales         | Paginated lead queue                                                                   |
| GET       | `/leads/:id`                                             | Admin/Sales         | Lead and selected product details                                                      |
| PATCH     | `/leads/:id/status`                                      | Admin/Sales         | `{status}`                                                                             |
| PATCH     | `/leads/:id/assign`                                      | Admin               | `{userId}` (active sales user)                                                         |
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
| GET/POST  | `/webhooks/whatsapp`                                     | Meta                | Verify subscription / signed callbacks                                                 |
| GET       | `/dashboard/stats`                                       | Admin/Sales         | Aggregate workspace metrics                                                            |

## Examples

```http
POST /api/v1/auth/login
Content-Type: application/json

{"email":"admin@example.com","password":"<secret>"}
```

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
- Pagination defaults to 20 and is capped at 100.
- `DELETE /products/:id` archives rather than physically deleting historical references.
- API and webhook request bodies have a 1 MiB maximum.
- Full OpenAPI 3.1 file: [`../backend/docs/openapi.yml`](../backend/docs/openapi.yml).
