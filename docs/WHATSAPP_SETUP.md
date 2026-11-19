# WhatsApp Cloud API setup

Use Meta's current [Cloud API message reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api), [webhook overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview), and [access-token guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens) as the source of truth for supported fields and account requirements.

1. Create a Meta Developer app for the business and add the WhatsApp product.
2. Select or create a WhatsApp Business Account (WABA).
3. Add a development test phone number; configure allowed test recipients.
4. Use the Cloud API getting-started screen to send an initial test message.
5. For production, verify the business and phone number, register the number, and configure a system user with the minimum WhatsApp permissions.
6. Generate a system-user access token with the required `whatsapp_business_messaging` permission for sending and receiving messages; use `whatsapp_business_management` for management operations. Store it in a secrets manager and set `WHATSAPP_ACCESS_TOKEN` only on the backend.
7. Record phone number ID, WABA ID, app secret, Graph API version, and a random webhook verify token in backend secrets.
8. Configure callback URL and subscribe to the `messages` field as described in `WEBHOOK_SETUP.md`.
9. Create and submit message templates in WhatsApp Manager. Add only templates showing approved status to this application's template registry.

Never put an access token in frontend build variables, source control, support logs, or screenshots. Rotate tokens and app secrets if exposed. Use a long-lived system-user token process supported by Meta rather than a temporary onboarding token.

The repository-root `.env` is loaded by the backend. Set `WHATSAPP_PHONE_NUMBER_ID` to the numeric sender ID (not the displayed test phone number), `WHATSAPP_BUSINESS_ACCOUNT_ID` to the WABA ID, and `META_GRAPH_API_VERSION` to the selected Graph version. Set the browser-facing API base URL in `frontend/.env.local` as `VITE_API_URL`; keep that file limited to public configuration and never put secrets in `VITE_` variables.

Current webhook payloads can include a business-scoped user ID (`from_user_id` / `user_id`) when phone-number fields are unavailable. The application stores that identifier for customer identity and uses a phone number when Meta provides one, falling back to the scoped ID for replies. Do not treat a missing phone number as a failed webhook.

## Template policy and customer windows

Free-form messaging is allowed only during the 24-hour customer service window after the customer's last message. Outside that window, use a template that Meta has approved for the correct category/language and ensure opt-in exists. This application blocks free-form admin sends after 24 hours and requires `OPTED_IN` for its template route. Product flows respond to inbound messages and rely on the same customer service window.

Meta limits reply-button titles to 20 characters. The user-facing sales button is shortened to **Connect With Team**; the product detail action is an interactive list so it can retain the requested **Explore Another Product** and **Connect With Our Team** labels within list-row limits.

Template status in the application is an operator-maintained record, not a live synchronization from Meta. Verify actual approval in WhatsApp Manager before marking a template `APPROVED`.

## Business data

Add correct product descriptions, product images available to Meta, and product specifications through the admin API. Keep source-of-truth data in your product catalog; no specs are inferred by the automation.
