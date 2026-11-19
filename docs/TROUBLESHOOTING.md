# Troubleshooting

## Backend fails at startup

- Check `MONGODB_URI` and that the database is reachable from the backend.
- `JWT_SECRET` must be at least 32 characters.
- In production, all `WHATSAPP_*` values and `WHATSAPP_BUSINESS_ACCOUNT_ID` must be present.
- If bootstrapping an administrator, both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are required; password minimum is 12 characters.

## Login is rejected

- The first administrator is created only once when bootstrap env values are configured.
- Confirm the user is active and the email is lowercase-normalized.
- A logout revokes the token; sign in again to issue another.
- The frontend keeps the JWT in memory only, so a page reload requires signing in again.

## Meta messages fail

- Confirm access token, sender phone-number ID, Graph API version, and app permissions.
- Test phone numbers can message only permitted recipients.
- Inspect the sanitized provider error in backend logs; do not log the token.
- Check Meta limits and template approval/category/language.

## Webhook verification fails

- GET challenge requires `hub.mode=subscribe`, exact verify token, and a configured token.
- POST signature requires the Meta app secret and unchanged raw body.
- Confirm the reverse proxy does not decompress, re-encode, or parse/re-serialize JSON before it reaches Express.
- Ensure `X-Hub-Signature-256` is forwarded.

## Events are pending or failed

- Confirm MongoDB is healthy and the backend worker is running.
- Inspect `WebhookEvent.processingStatus`, `attempts`, and `lastError`.
- Check product records, WhatsApp window policy, notification URL, and Meta API errors.
- After correcting a cause, operators may reset an event to `PENDING` using an audited database procedure; be aware at-least-once sends can duplicate if a provider succeeded before a timeout.

## No product data is returned

- Add active products with a menu category, verified description, and optional image URL.
- The product category menu includes requested default labels; categories without active records report that no products are currently listed.
- No specifications are invented; populate exact specifications in the catalog.

## Frontend API requests fail

- Check `VITE_API_URL`, backend health, CORS `FRONTEND_URL`, and a fresh login.
- The dashboard is memory-session-based, so reload and authenticate again.
- Inspect browser network errors but do not expose bearer tokens in bug reports.
