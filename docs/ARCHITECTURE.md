# Architecture

## Boundaries

- `backend/src/config`: environment validation and logger.
- `backend/src/database`: Mongoose connection and persistence models/indexes.
- `backend/src/modules`: bounded HTTP/API features. Routes validate and authorize requests; `automation` and `whatsapp` services own business/provider behavior.
- `backend/src/middleware`: JWT, role authorization, and normalized errors.
- `frontend/src`: React application, auth context, route layout, pages, API client.
- `docs`: operational, API, schema, and deployment guidance.

The backend is a modular monolith. This keeps domain transitions and MongoDB writes in one deployable application while leaving notification providers and Meta integration behind service boundaries. Extracting workers/services can be done without exposing provider SDK details to route handlers.

## Webhook event flow

1. The webhook route is mounted before `express.json()`. It accepts a bounded raw `Buffer`.
2. `X-Hub-Signature-256` is checked using HMAC-SHA256 and the Meta App Secret with constant-time comparison.
3. Inbound messages and delivery statuses become individual `WebhookEvent` inbox rows. Unique event keys reject duplicate deliveries; acknowledgement follows durable insertion.
4. A MongoDB polling worker claims pending records atomically, processes them, marks success, and requeues failures with capped backoff up to a configured retry limit. Stale processing leases are reclaimed after five minutes. Failed events remain inspectable.
5. Inbound messages are persisted with a unique WhatsApp message ID. Automation state changes use MongoDB atomic operations; Meta sends are made only through `WhatsAppService`.

The worker is an at-least-once processor. External webhook providers should honor the lead notification idempotency key. A five-minute event lease allows stale claim recovery; avoid worker tasks that exceed this interval without adding lease heartbeats. Monitor old `PROCESSING` records.

## Automation state

`Conversation.currentStep` persists user-facing progress, while `status` controls whether automation may act. Each conversation tracks distinct product ObjectIds; `$addToSet` plus a conditional `$ne` update ensures unique interests increment once per product. The third-interest transition and prompt delivery are tracked independently; conditional state claims and a short delivery lease prevent normal concurrent duplicates while allowing retry after a transient failure. `interestTriggeredAt` records the one-time trigger.

Conversation inactivity for seven days closes the automated session. A new customer message can start a fresh session. `HUMAN_HANDOVER` conversations do not receive automated product responses. `STOP`, `UNSUBSCRIBE`, and `OPT OUT` set customer opt-out status.

## Security and failures

Express applies Helmet, exact-origin CORS, JSON size limits, request rate limiting, Zod validation, JWT authentication, role checks, safe API errors, and Pino structured request logging. Password hashes are selected out of normal User queries. Access tokens and password hashes are redacted/never returned.

Meta calls fail explicitly and surface provider errors. No success-shaped response is synthesized. The platform does not initiate free-form messages after the 24-hour window; approved templates are a separate route.

## Scaling and transactions

Unique constraints and conditional updates cover current idempotency and counter needs without multi-document transactions. The current Compose MongoDB is standalone. If a future business operation requires atomic writes spanning collections, deploy MongoDB as a replica set or Atlas cluster and use a session transaction with retry semantics.

## Deployment shape

Run the API and frontend as separate containers, MongoDB as a managed service, and send application logs to a protected collector. The webhook worker currently runs inside the backend process. For horizontally scaled APIs, split worker scheduling into a single dedicated process or add an explicit lease/queue architecture before running multiple worker copies.
