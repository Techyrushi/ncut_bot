# Webhook setup

## Configure Meta callback

1. Expose the backend over publicly trusted HTTPS (a temporary tunnel is suitable only for development).
2. Set `WHATSAPP_VERIFY_TOKEN` to a random secret and `WHATSAPP_APP_SECRET` to the Meta app secret.
3. Set `APP_URL` to the public API origin and use `<APP_URL>/api/v1/webhooks/whatsapp` as the callback URL in Meta app Webhooks configuration.
4. Enter the exact verify token, complete verification, and subscribe to the WhatsApp `messages` field.
5. Send a test message and inspect structured API logs and the `WebhookEvent`, `Message`, `Conversation`, and `Customer` collections.

## Processing and security

The route is registered before JSON middleware and reads the original raw bytes. It calculates `HMAC-SHA256(appSecret, rawBody)` and compares it in constant time with `X-Hub-Signature-256: sha256=<hex>`. Unsigned, malformed, or invalid callbacks are rejected. Keep the 1 MiB request limit and rate-limit thresholds aligned with observed Meta callback volume.

The handler persists deduplicated message/status work and responds quickly. A Mongo-backed polling worker processes the inbox and retries failures up to `WEBHOOK_MAX_ATTEMPTS`, recovering stale processing leases after a crash. Inspect `FAILED` inbox rows and logs during incidents. Do not manually replay without considering whether a Meta send may already have succeeded.

The worker runs in the API process and uses MongoDB atomic claims so multiple API replicas can share the queue. Monitor pending queue age, failed count, processing duration, Meta API failure rate, and database availability.

## Verification troubleshooting

- `403`: wrong verify token, mode not `subscribe`, or token not configured.
- `401 INVALID_WEBHOOK_SIGNATURE`: wrong app secret, proxy modified body bytes, incorrect header, or request body parsing happened before verification.
- Repeated delivery: expected at-least-once webhook behavior; unique event/message constraints prevent duplicate processing.
- No automation: confirm the `messages` subscription, public callback, app secret, access token, sender phone-number ID, and worker/database logs. Active products are needed for product details; an initial inbound message can still receive the welcome flow. A customer's inbound message opens the service window; template sends outside it require opt-in.
- Phone number fields missing: current payloads may supply business-scoped IDs (`from_user_id` / `user_id`). The worker accepts those as customer identities and uses the phone number when Meta provides one.
