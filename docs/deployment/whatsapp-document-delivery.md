# Direct quotation documents in WhatsApp

Furniture uses `/api/furniture-quotations/{id}/whatsapp-send` to upload the
generated unbranded PDF privately to Meta and send it as a document with the
operator's message. Browser clients never receive the provider token.

Set `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in Railway's service
environment using a registered WhatsApp Business sender. `WHATSAPP_GRAPH_VERSION`
defaults to `v23.0`; configure the version supported by your Meta application.
Set `WHATSAPP_APP_SECRET` and a random `WHATSAPP_VERIFY_TOKEN`, then register
`https://forge20-production-a8b0.up.railway.app/api/whatsapp/webhook` with Meta
and subscribe to messages. The webhook validates the exact raw-body HMAC.
Do not put tokens into source, frontend variables, screenshots or chat.

For business-initiated messages outside the customer service window, configure
`WHATSAPP_DOCUMENT_TEMPLATE` to an approved template with a document header and
one body text parameter for the accompanying message, and set
`WHATSAPP_TEMPLATE_LANGUAGE` to that template's approved language (default `en`).
Without a template the provider's document-caption rules apply; a rejected send
is displayed as failed. See [Meta's document message reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/document/)
and [Meta's Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

Each request includes a stable idempotency key. The unique floor/document/key
index prevents double clicks or repeated HTTP requests from sending twice.
The same key with different PDF/message bytes is rejected. A provider timeout
after sending is `unknown`, not automatically retried; verify the recipient or
provider receipt before intentionally sending again. `accepted` means Meta has
accepted the request; only a signed webhook can mark it delivered/read.
The floor-scoped receipt endpoint permits explicit refresh. No public PDF link
is necessary for direct delivery. Provider errors are reduced to safe codes.

No real customer messages are sent by automated tests or deployment smoke tests.
An operational send needs the configured sender and a real customer contact.
