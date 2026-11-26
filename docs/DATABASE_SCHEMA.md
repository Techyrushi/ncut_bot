# Database schema

All timestamps are UTC dates. Mongoose `timestamps` adds `createdAt` and `updatedAt` to mutable entities.

## Customer

`name`, optional `phoneNumber`, unique `whatsappId`, `profileName`, `optInStatus` (`UNKNOWN | OPTED_IN | OPTED_OUT`).

- `whatsappId` stores Meta's business-scoped user ID when supplied, otherwise the sender's WhatsApp ID/phone.
- `phoneNumber` is optional because current webhook payloads can omit phone fields; it is indexed when present.

## Product

`name`, unique `slug`, `description`, `category` (maximum 32 characters), arrays `sizes`, `grits`, `colours`, `backing`, mixed `specifications`, optional `imageUrl`, `isActive`.

- Category/active index for catalogue lookup.
- Text index across name, description, and category.
- Inactive products are soft-archived and excluded from WhatsApp discovery.
- Admins can upload JPEG, PNG, or WebP images up to 5 MiB. The generated public URL is stored as `imageUrl`; keep the upload directory persistent and set `APP_URL` to the externally reachable API origin for Meta media fetches.

## Conversation

`customerId`, `status` (`OPEN | HUMAN_HANDOVER | CLOSED`), `currentStep` (`NEW`, `WELCOME_SENT`, `PRODUCT_MENU`, `PRODUCT_DETAILS`, `INTEREST_TRIGGERED`, `HUMAN_HANDOVER`, `CLOSED`), `selectedProductIds`, `uniqueProductCount`, `interestTriggeredAt`, `interestPromptStatus`, `interestPromptLockedAt`, `currentCategory`, `lastMessageAt`, `lastInteractionAt`, `lastInboundMessageAt`, and `handoverAt`.

- Partial unique index permits one `OPEN` conversation per customer.
- The WhatsApp service window is calculated only from `lastInboundMessageAt`; webhook timestamps are normalized to UTC, and startup backfills this field from inbound message history for existing conversations.
- Customer/status/updated and recent-message indexes serve admin lists.
- Product selection uses a conditional atomic update and add-to-set to count only first-time product IDs.

## Message

`customerId`, `conversationId`, optional unique/sparse `whatsappMessageId`, `direction` (`INBOUND | OUTBOUND`), `messageType`, `content`, `status` (`RECEIVED | QUEUED | SENT | DELIVERED | READ | FAILED`), `timestamp`, optional provider error.

- Conversation/time descending index supports conversation history.
- Provider message ID is sparse unique so inbound webhook replays and status updates are associated safely.

## Lead

`customerId`, unique-per-conversation relationship, `selectedProducts`, optional `assignedSalesPerson`, status (`NEW | CONTACTED | QUALIFIED | WON | LOST`), `notificationStatus`, `notificationSentAt`, and optional requirement.

- Status/creation and assignee indexes support work queues.
- Lead history is the related `Message` set for its `conversationId`; messages are not duplicated into a lead document.

## WebhookEvent

`eventId`, `eventType`, raw parsed `payload`, `processingStatus`, attempt count/error, `receivedAt`, `processedAt`.

- `eventId` is unique for callback idempotency.
- Processing-status/received index drives worker claims.
- Failed events are retained for operator inspection.
- `availableAt` backs off retries; `lockedAt` supports stale-claim recovery.

## WorkspaceSettings

Single `workspace` record with public business phone number, configurable welcome text, and the administrator that last changed it. It does not contain Meta credentials.

## ActivityLog

Append-only operational history with `source` (`USER | SYSTEM`), action/summary, resource type and optional ObjectId, actor reference/role, response status, and UTC `occurredAt`.

- Indexed by event time and source/time for paginated admin review.
- Authenticated write attempts, service startup/shutdown, and exhausted WhatsApp webhook retries are recorded.
- Request bodies, customer message content, credentials, and query strings are not stored.

## User, MessageTemplate, RevokedToken

`User`: unique lowercase email, bcrypt `passwordHash` (`select: false`), name, role and active flag.

`MessageTemplate`: unique name/language pair, category, Meta approval status, template components. Approval must reflect the actual Meta template state.

`RevokedToken`: unique JWT ID and expiry with TTL cleanup index. Expiry cleanup is asynchronous; auth checks token revocation on every protected request.

## Transactions

Current code does not require transactions. Durable webhook inbox insertion and atomic per-document updates address current consistency needs. Use transactions only on replica-set-backed MongoDB for future multi-document operations.
