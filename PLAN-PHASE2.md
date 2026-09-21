# Coyote — Phase 2: WhatsApp as the front door

Companion to `PLAN.md`. Phase 2 code starts after MVP phases 0–6 are live. Its Meta setup (step 1) has no code and takes weeks, so start it as soon as the final brand name and domain are chosen, ideally while the MVP is still being built.

## Why
Competing with Wix/Squarespace/Hostinger on generation quality is a losing axis. For LatAm small businesses the advantage is low friction: they run the business on WhatsApp, won't learn an editor, and don't have USD cards. Phase 2 makes WhatsApp the main interface: create the site by chat, edit by chat, receive leads as WhatsApp messages. The MVP web form stays as a second entry point.

- **Reused unchanged from the MVP**: theme library, design brief, Haiku 4.5 content generation, renderer, content patching, safety layers, slug/hosting, magic link.
- **Added**: a conversational front end, the contact form (designed in `PLAN.md`, built here), and WhatsApp as the first lead-delivery channel. SES email follows as the fallback (`PLAN.md` phase 7).
- **URLs**: as in `PLAN.md` (sites at `{slug}.<sites-domain>`, app at `app.<domain>`, API at `api.<domain>`). All URLs in messages come from `urls.ts`, so the flows also run in domainless mode during development. Sending site links to real users requires the final domains: a `cloudfront.net/{slug}/` link looks like spam and would change later.

## Platform: AWS End User Messaging Social
WhatsApp Business Platform through AWS. No Meta Cloud API webhooks to host, no BSP middleman.
- Inbound messages and status events arrive on an SNS topic → Lambda. Outbound via `SendWhatsAppMessage`. Media via `GetWhatsAppMessageMedia` / `PostWhatsAppMessageMedia`, directly to/from S3.
- IAM auth, CloudWatch metrics, billed on the AWS account.
- Requires: a Meta Business account, a phone number not registered in the WhatsApp app, display-name approval, and message-template approval.
- **Meta Business verification** (Meta checks the legal business name, address, and a website on a matching domain; days to weeks): not needed to start testing, but needed to go past the unverified limits (about 250 business-initiated conversations per 24 h; verify the current number). Lead notifications and "tu sitio está listo" are business-initiated, so real usage needs it. A live `app.<domain>` landing page helps. This is the critical path.

## Pricing (verified Sep 2026)
| Item | Cost |
|---|---|
| AWS fee | $0.005 per outbound message, $0.001 per inbound |
| Meta fee, inbound (user → us) | free |
| Meta fee, service replies inside the 24 h window | free until 2026-09-30; **from 2026-10-01 charged at the utility rate**, with **1,000 free service messages per phone number per month** |
| Meta utility/service rate | Colombia ~$0.0008 · Brazil ~$0.0068 · Mexico ~$0.0085 · Argentina/Chile/Peru ~$0.02 |
| Meta marketing rate | Mexico ~$0.03 · Brazil ~$0.06 — **never use this category** |

- Per site via WhatsApp: ~8 outbound messages ≈ $0.04 AWS + ≤ $0.16 Meta (worst market) + ~$0.02 Haiku ≈ **$0.10–0.25**.
- Lead notification to an owner: 1 utility template ≈ **$0.006–0.025**.
- The 1,000 free service messages/month cover early volume.
- Rule: every business-initiated message uses a **utility** template (transactional: "tu sitio está listo", "nuevo mensaje de un cliente"). Nothing promotional; marketing is 3–8× the price and needs marketing opt-in.

## Conversation flows

### A. Create a site
`wa-inbound` Lambda; state machine in DynamoDB `wa_sessions` (pk `phone`, TTL 48 h).
Entry: the user taps a `wa.me/<number>?text=Hola` link (site, Instagram bio, QR on a flyer) or messages the number.

| Step | Bot | Accepts |
|---|---|---|
| 0 `lang` | Detect from country code (+55 → pt, else es); allow "Português/Español" switch | text |
| 1 `name` | "¿Cómo se llama tu negocio?" | text |
| 2 `about` | "Cuéntame qué hacen y dónde están (puedes mandar un audio)" | text, voice note (Transcribe, flag), location pin |
| 3 `contact` | "¿Qué número de WhatsApp mostramos?" default = sender; "¿Quieres recibir aquí los mensajes de tus clientes? Sí/No" | text, contact card, button reply |
| 4 `media` | "Mándame tu logo y hasta 3 fotos, o escribe *listo*" | images (→ `_uploads/`, Rekognition moderation) |
| 5 `preview` | Generates (same `generate` core, invoked directly, not via HTTP); sends preview link + buttons **Publicar / Otra versión / Cambiar algo** | button reply |
| 6 `done` | "Listo: https://{slug}.<sites-domain>. Guarda este chat: aquí puedes cambiar tu sitio cuando quieras." + magic link | — |

- Rate limit, pre-screen classifier, and slug claim run before step 5 (same code as `submit`). Rejection → fixed polite message, session closed, counted in abuse metrics.
- Every state transition is idempotent on the WhatsApp message id (SNS delivers at least once).
- Generation takes 20–40 s: send "Estoy creando tu sitio, dame un minuto" immediately and use typing indicators / read receipts.
- Unknown input at any step → Haiku intent classification (`continue`, `restart`, `help`, `human`) with tool use. Never free-form chat.

### B. Edit by message
"cambia el horario a 9 a 6", "pon que también hacemos envíos", "quita la foto 2".
- Sender phone → sites via the GSI on `sites.ownerPhone`. One site → proceed. Several → WhatsApp list message "¿Cuál sitio?"; the choice is kept in `wa_sessions` for the session.
- Haiku tool `edit_site` → patch `{ hours?, about?, services?[], removeMedia?[], contact? }`, validated by the content schema and applied with the same `content.ts` patch function "Mi sitio" uses. Re-render, no generation.
- Unpatchable request → "Eso lo puedes cambiar en tu página Mi sitio: <magic link>".
- Caps: 10 edits/day per site; full regeneration stays at 2 per site.
- Patched text passes `ApplyGuardrail` + policy + lint before publish.

### C. Contact form + leads to WhatsApp
Builds the contact form from `PLAN.md` ("Post-MVP: Contact form": theme slot, `contact` Lambda, spam controls, `messages` table) with WhatsApp delivery. Existing sites get the form on their next re-render once the owner opts in.

Submission → if the owner opted in (`wa_optins`), send utility template `nuevo_mensaje`:
> Nuevo mensaje desde tu sitio {{business}}: {{name}} — {{message_excerpt}}. Contacto: {{contact}}

- `{{contact}}`: the form's `contacto` field accepts phone or email. Phone → normalised, sent as `wa.me/<visitor_phone>`. Email → plain text.
- Template variables carry visitor text, so sanitise: strip newlines/tabs, collapse spaces, de-link URLs, cap the excerpt at 200 chars. Malformed or link-heavy variables get templates rejected or paused by Meta.
- Inside the owner's open 24 h window, send a free-form service message instead (cheaper, no template limits).
- No opt-in, or template failure → the message is stored in `messages` and shown in "Mi sitio". Once SES ships (`PLAN.md` phase 7), a verified email is the fallback channel. The form is rendered only for sites with at least one delivery channel.
- Opt-in is explicit at step 3 and revocable with *BAJA*/*STOP* (handled locally; also required by Meta). Web-created sites opt in from "Mi sitio" via a `wa.me` deep link that sends "ACTIVAR {slug}".
- Same spam controls as the contact form. Digest rule: ≥5/hour → one message with the count.

### D. Monthly pulse
Template `reporte_mensual`: "Este mes 12 personas te escribieron desde tu sitio y 340 lo visitaron." Counts from CloudFront standard logs (Athena query, monthly EventBridge). The category must be utility; if Meta classifies it as marketing, drop the feature rather than pay marketing rates.

## Ownership changes vs MVP
- The phone number becomes the primary identity. `sites` gets `ownerPhone` (GSI), `waOptIn`, `channel: "web" | "whatsapp"`.
- The magic link is delivered on WhatsApp. Re-issue ("Enviarme mi enlace") works for every site with an `ownerPhone` via template `enlace_mi_sitio`. This closes the MVP's lost-link gap.
- "Mi sitio" gains: messages from the last 30 days, WhatsApp opt-in/pause, link back to the chat.

## Safety and abuse (additions)
- Per-phone limits: 3 sites/month, 30 inbound messages/hour. `blocklist` also holds phone numbers.
- Media goes through Rekognition moderation before storage (MVP code).
- No LLM free-chat: every model call is tool use with a fixed schema, with the MVP guardrail attached.
- Opt-out words (BAJA, STOP, CANCELAR, PARAR, SAIR) are honored immediately and logged.
- Quality-rating guard: CloudWatch alarm on Meta quality rating, messaging-limit tier, and template-status events from the SNS stream. Pause business-initiated templates automatically if the rating drops to "red".

## Infra additions (CDK, us-east-1)
- `AWS::SocialMessaging` linked WABA + phone number (one-time in the console; ARN into CDK context). Event destination → SNS topic `wa-events`.
- Lambdas: `wa-inbound` (SNS-triggered, 30 s, idempotency via `wa_messages`), `wa-send` (shared module), `wa-monthly` (EventBridge cron), `contact` (`POST /contact/{slug}`, see `PLAN.md`). `generate` gains a WhatsApp notification branch.
- DynamoDB: `wa_sessions` (TTL 48 h), `wa_messages` (idempotency, TTL 7 d), `wa_optins`, `messages` (TTL 30 d); GSI `ownerPhone` on `sites`.
- SSM parameter for the contact-form HMAC secret. The sites CSP already allows `form-action https://api.<domain>`.
- Templates (registered in Meta via console/API, es + pt): `sitio_listo`, `nuevo_mensaje`, `reporte_mensual`, `enlace_mi_sitio`.
- Optional: Amazon Transcribe for voice notes (~$0.024/min; a 30 s note ≈ $0.012), flag `VOICE_NOTES`.
- IAM: `social-messaging:SendWhatsAppMessage`, `GetWhatsAppMessageMedia`, `PostWhatsAppMessageMedia`, scoped to the phone-number ARN.
- Budget: cost-allocation tag `channel=whatsapp`; alarm at $50/month initially.

## Implementation steps
Tick a box (`[x]`) only when the item is done and its check passed. 👤 = needs the user.

### Step 1 — Meta setup (critical path; start once the brand is chosen)
- [ ] 👤 Final brand name + domain decided (verification is tied to them)
- [ ] 👤 Meta Business verification approved
- [ ] 👤 Dedicated number acquired (local SIM or virtual number that receives SMS/voice OTP), never registered in the WhatsApp app
- [ ] 👤 WABA linked in AWS End User Messaging Social; ARN in CDK context
- [ ] 👤 Display name approved
- [ ] Templates submitted and approved, es + pt: `sitio_listo`, `nuevo_mensaje`, `reporte_mensual`, `enlace_mi_sitio`

### Step 2 — Inbound plumbing
- [ ] Event destination → SNS `wa-events` → `wa-inbound`
- [ ] Idempotency on message id (`wa_messages`)
- [ ] `wa-send` module; echo bot on the test number
- [ ] 24 h window tracking + read receipts/typing indicators verified

### Step 3 — Flow A (create a site)
- [ ] `wa_sessions` state machine, steps 0–6, es + pt
- [ ] Rate limit + pre-screen + slug claim reused from `submit`; per-phone limits
- [ ] Media intake → `_uploads/` → Rekognition
- [ ] Voice notes via Transcribe (flag `VOICE_NOTES`) with read-back confirmation
- [ ] Preview link + buttons (Publicar / Otra versión / Cambiar algo)
- [ ] Intent classifier for unknown input
- [ ] Magic link + re-issue over WhatsApp (`enlace_mi_sitio`); `ownerPhone` GSI
- [ ] Fixture conversations as tests (recorded SNS payloads)

### Step 4 — Flow C (contact form + leads)
- [ ] Theme contact slot + `contact` Lambda + spam controls + `messages` table (`PLAN.md` "Post-MVP: Contact form")
- [ ] Opt-in at step 3 and from "Mi sitio" (`ACTIVAR {slug}`); `wa_optins`
- [ ] `nuevo_mensaje` with variable sanitising; free-form inside the 24 h window
- [ ] "Mi sitio" inbox (last 30 days); form rendered only with a delivery channel
- [ ] BAJA/STOP handling; digest rule

### Step 5 — Flow B (edit by message)
- [ ] `edit_site` tool on the shared `content.ts` patch function
- [ ] Multi-site disambiguation (list message)
- [ ] Caps (10 edits/day) + safety checks on patched text

### Step 6 — Flow D + guards
- [ ] Monthly counts (CloudFront logs → Athena) + `reporte_mensual`
- [ ] Quality-rating / template-status alarm + auto-pause

### Step 7 — Entry points
- [ ] "Crea tu sitio por WhatsApp" button on the app
- [ ] QR generator for flyers; Instagram bio link text
- [ ] 👤 Final domains live before links go to real users

### Step 8 — Hand-off
- [ ] `PLAN.md` phase 7 (SES email fallback) plugged into the `contact` Lambda
- [ ] Full "Verification" section passes on the test number

## Verification
- Test number, end to end: create a site in Spanish and in Portuguese by chat only, with a voice note and two photos. Preview buttons work. Published URL and magic link arrive. "Enviarme mi enlace" re-issues the link.
- A duplicate SNS delivery of the same message id causes no duplicate step or message.
- A contact-form submission reaches the owner on WhatsApp within 10 s. A message with newlines and URLs arrives flattened and de-linked. An email-only `contacto` shows as text; a phone shows as a `wa.me` link. BAJA stops delivery, and the message still appears in "Mi sitio".
- A site with no delivery channel renders no form.
- "cambia el horario a 9-6" updates the page with no generation call. An owner with two sites is asked which one. An unpatchable request gets the Mi sitio link.
- Bad-actor fixtures (adult, phishing) via WhatsApp end `REJECTED` with nothing in S3.
- CloudWatch shows AWS + Meta fees per message. A 100-conversation test run stays under $5.

## Risks
- **Meta verification and approvals** can take weeks; start once the brand is chosen. Verification and the display name are tied to the real business name and website, so they need the final brand domain, not `consideralohecho.com`. Deciding the brand unblocks this step.
- **Pricing change on 2026-10-01**: service replies become paid. The design keeps replies to ~8 per conversation and never uses marketing templates. Re-check rates once Meta publishes the final card.
- **Messaging limits**: new numbers start at 250 business-initiated conversations per 24 h and grow with quality. Lead notifications are business-initiated, so the "Mi sitio" inbox (and later email) is the safety net.
- **Template pausing**: visitor text inside utility templates can draw blocks/reports and get `nuevo_mensaje` paused. Mitigations: variable sanitising, spam controls, the quality-rating guard.
- **One number, one place**: a number works on the WhatsApp app or the API, not both. The business number must live on the API only.
- **Voice notes** transcribe poorly in noisy places. Always show the transcription back for confirmation before generating.

Sources: [AWS End User Messaging pricing](https://aws.amazon.com/end-user-messaging/pricing) · [AWS charged per message](https://docs.aws.amazon.com/social-messaging/latest/userguide/charged-per-message.html) · [YCloud: Oct 1 2026 pricing update](https://www.ycloud.com/blog/whatsapp-api-message-pricing-update-effective-october-1-2026) · [Patagon AI: LatAm per-message rates](https://www.patagon.ai/blog-posts/whatsapp-business-api-pricing) · [SendPulse: service message pricing changes](https://sendpulse.com/blog/whatsapp-service-message-pricing)
