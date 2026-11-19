# WhatsApp Product Catalogue & Sales Automation

A TypeScript monorepo for managing an abrasive-product catalogue, automating product discovery in WhatsApp, and handing qualified conversations to sales. The backend integrates directly with Meta's official WhatsApp Cloud API; it does not use Twilio.

> **Production readiness note:** This repository supplies the application foundation and core workflows, but a production launch still requires Meta app review/configuration, verified business data, real product content, TLS, a production MongoDB deployment, operational alerting, and provider-specific tests. No product specifications or live Meta credentials are bundled.

## Features

- Meta Cloud API text, image, button, list, and approved-template messages.
- Signed webhook verification against the original raw request body, including current business-scoped WhatsApp user identifiers when phone fields are absent.
- Persisted webhook inbox, duplicate-event protection, retries, and a background MongoDB worker.
- Stateful catalogue discovery, seven-day conversation expiry, opt-out handling, unique product interest tracking, and one-time third-product prompt.
- Human handover, sales lead creation, and configurable log/webhook notification.
- Product, customer, conversation, lead, team, template, authentication, and dashboard APIs.
- Self-service account email/password changes with prior-session invalidation and accessible show/hide password controls.
- Responsive authenticated React dashboard, optimistic catalogue entry with local image uploads, QR click-to-chat builder, and an unread-aware WhatsApp conversation inbox.
- Zod request validation, JWT roles/revocation, bcrypt passwords, Helmet, CORS, rate limits, structured logs, and safe API errors.
- Docker Compose, TypeScript checks, and Jest/Supertest tests using MongoDB Memory Server.

## Architecture

The backend is organized by feature. Express controllers/routes handle HTTP and validation; services implement automation and Meta API behavior; Mongoose models own schema/index constraints. Webhook delivery is acknowledged after a durable event is inserted. A database-backed worker processes the event asynchronously, so the endpoint does not wait on Meta sends. The frontend is a separate Vite application and never receives server-side Meta credentials.

```text
backend/src/
  config/             Environment validation and logging
  database/models/    Customer, Product, Conversation, Message, Lead, User, etc.
  middleware/         Auth, role checks, errors
  modules/            Feature routes and automation/WhatsApp services
  app.ts              Middleware ordering and route composition
  server.ts           Database/bootstrap/worker startup
frontend/src/
  components/ contexts/ layouts/ pages/ services/ types/
docs/
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for request flows and [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) for collection/index details.

## Technology

- Node.js 20.19+ and npm 10+
- Express 4, TypeScript 5, Mongoose 8, Zod, Pino
- React 18, Vite 6, Tailwind CSS 3, React Router 6, TanStack Query 5, Axios
- MongoDB 7+ (transactions are not required by the current worker; use a replica set if adding transaction-dependent flows)
- Jest, Supertest, MongoDB Memory Server

All direct dependencies are pinned. `package-lock.json` is the canonical transitive dependency lock.

## Prerequisites and installation

1. Install Node.js 20.19+ and npm 10+.
2. Install MongoDB locally, use MongoDB Atlas, or start the Compose service.
3. Copy `.env.example` to the repository-root `.env` and set `MONGODB_URI`, a random `JWT_SECRET` of at least 32 characters, and bootstrap administrator credentials. For the frontend, copy `frontend/.env.example` to `frontend/.env.local` and set `VITE_API_URL`. The frontend environment file contains public configuration only.
4. Configure Meta values before connecting a real WhatsApp number.

```powershell
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
npm ci
```

Never commit `.env`. The `.env.example` contains placeholders only.

## Local development

```powershell
npm run dev
```

This starts the API at `http://localhost:5000` and the Vite dashboard at `http://localhost:5173`. For separate terminals use `npm run dev -w backend` and `npm run dev -w frontend`. Set `VITE_API_URL` in `frontend/.env.local` if the API is hosted elsewhere.

On startup the backend validates required configuration, connects to MongoDB, and creates the first administrator only when both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are provided and the account does not already exist. Bootstrap passwords must be at least 12 characters. To add sales representatives, sign in as an administrator and use `POST /api/v1/team`.

## Environment variables

| Variable                         |    Required | Purpose                                            |
| -------------------------------- | ----------: | -------------------------------------------------- |
| `NODE_ENV`                       |          No | `development`, `test`, or `production`             |
| `PORT`                           |          No | Backend port (default `5000`)                      |
| `HOST`                           |          No | Backend bind address (default `0.0.0.0`)           |
| `APP_URL`                        |          No | Public API base URL                                |
| `MONGODB_URI`                    |         Yes | Mongo connection URI                               |
| `WHATSAPP_ACCESS_TOKEN`          |  Production | Meta system-user access token                      |
| `WHATSAPP_PHONE_NUMBER_ID`       |  Production | Cloud API sender ID                                |
| `WHATSAPP_BUSINESS_ACCOUNT_ID`   |  Production | WhatsApp Business Account ID                       |
| `WHATSAPP_APP_SECRET`            |  Production | HMAC webhook-signature secret                      |
| `WHATSAPP_VERIFY_TOKEN`          |  Production | Secret chosen for webhook verification             |
| `META_GRAPH_API_VERSION`         |          No | Graph API version, default `v27.0`                 |
| `JWT_SECRET`                     |         Yes | JWT signing secret, minimum 32 characters          |
| `JWT_EXPIRES_IN`                 |          No | Token lifetime, default `1d`                       |
| `FRONTEND_URL`                   |          No | Exact allowed browser origin                       |
| `SALES_NOTIFICATION_PROVIDER`    |          No | `log` or `webhook`                                 |
| `SALES_NOTIFICATION_TARGET`      | Conditional | HTTPS notification receiver for `webhook` provider |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` |          No | First administrator bootstrap pair                 |
| `WEBHOOK_PROCESSING_INTERVAL_MS` |          No | Worker polling period                              |
| `WEBHOOK_MAX_ATTEMPTS`           |          No | Failed event retry limit                           |

Set the public frontend `VITE_API_URL` in `frontend/.env.local` (see `frontend/.env.example`). Meta credentials are optional in development and tests. The WhatsApp service returns an explicit configuration error if a message is attempted without them. All Meta settings are required in production. Never expose `WHATSAPP_ACCESS_TOKEN` to Vite or the browser. The phone number ID is the numeric ID shown in Meta's API setup, not the displayed test phone number.

## Catalogue and automation data

Create products using the admin API or dashboard. The menu includes the 13 product categories from the provided workflow document; catalogue descriptions, images, sizes, grit ranges, colours, backing, and specifications must be supplied from verified business data. The application does not fabricate specs. See [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md).

The automation flow welcomes a new inbound customer, presents the paginated category/product menus, sends saved product data, atomically adds distinct product IDs to the conversation, prompts after the third unique interest only once, and creates a sales lead on handover. The session expires after seven days without interaction. Human handover turns off automated replies until a representative closes the conversation through an operational workflow.

## API

All endpoints are prefixed with `/api/v1`. Authenticated admin endpoints require `Authorization: Bearer <JWT>`.

| Area                      | Routes                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| Health                    | `GET /health`                                                                                 |
| Auth                      | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`                                       |
| Products                  | `GET/POST /products`, `POST /products/image-upload`, `GET/PUT/DELETE /products/:id`          |
| Customers                 | `GET /customers`, `GET /customers/:id`                                                        |
| Conversations             | `GET /conversations`, `GET /conversations/:id`, `GET /conversations/:id/messages`, `POST /conversations/:id/read` |
| Customers / conversations | `PATCH /customers/:id/opt-in`, `PATCH /conversations/:id/status`                              |
| Leads                     | `GET /leads`, `GET /leads/:id`, `PATCH /leads/:id/status`, `PATCH /leads/:id/assign`          |
| Team/templates            | `/team`, `/templates`                                                                         |
| WhatsApp                  | `POST /whatsapp/send-message`, `/send-image`, `/send-template`, `GET /whatsapp/configuration`, `POST /whatsapp/configuration/test-connection` |
| Webhooks                  | `GET/POST /webhooks/whatsapp`                                                                 |
| Settings / dashboard      | `GET/PATCH /settings/workspace`, `GET /dashboard/stats`                                       |

See [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) and [backend/docs/openapi.yml](backend/docs/openapi.yml) for request/response details.

## Meta / WhatsApp setup

Follow [docs/WHATSAPP_SETUP.md](docs/WHATSAPP_SETUP.md) to create a Meta app, attach a WhatsApp Business Account, configure a system-user token, add a test number, and use approved templates. Follow [docs/WEBHOOK_SETUP.md](docs/WEBHOOK_SETUP.md) for callback subscription and raw-body HMAC verification.

The callback is `https://<public-host>/api/v1/webhooks/whatsapp`. Subscribe to the `messages` webhook field. Meta's GET verification uses the configured verify token; POST callbacks require `X-Hub-Signature-256`.

## QR code

The WhatsApp setup page builds `https://wa.me/<E.164 digits>?text=<encoded message>` and offers an SVG download. A QR scan opens WhatsApp; the customer must send the opening message before the automation starts. The QR does not contain a secret or automatically opt a customer in.

## Testing and quality checks

```powershell
npm test
npm run typecheck
npm run build
npm run lint
```

Tests use MongoDB Memory Server and mocked HTTP/WhatsApp behavior; no real Meta credentials are required. On first test execution, MongoDB Memory Server may need to download its test binary. It does not connect to a production database.

## Docker

```powershell
Copy-Item .env.example .env
# Set MONGODB_URI=mongodb://mongo:27017/whatsapp_automation in .env
docker compose up --build
```

The API is exposed on port 5000 and the dashboard on port 8080. For a real deployment, set `VITE_API_URL` to the public API origin at frontend build time and serve both endpoints over HTTPS. The default Compose MongoDB service is intended for local development and has no authentication or persistence policy suitable for production.

## Security and policy notes

- Use a Meta system-user token with only required permissions and rotate it.
- Put secrets in a managed secret store in production; protect database backups and logs.
- Admin sessions are short-lived JWTs and logout revokes their token ID until expiry.
- Webhook HMAC is checked against the exact raw body before JSON parsing.
- Customer opt-out is persisted. Business-initiated outbound templates require opted-in status and an approved local template record.
- Free-form admin messages require an active 24-hour service window.
- Rate limits are applied to API and webhook routes; tune after observing real Meta callback volume.
- Configure retention, privacy notices, consent capture, regional data handling, and deletion/export processes for the business jurisdiction.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) and [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md). Common setup issues include missing MongoDB, wrong webhook verify token, invalid app secret, unapproved templates, stale test tokens, and incorrect public callback URL.
