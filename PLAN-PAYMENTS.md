# Paddle pricing (sandbox): design credits + monthly hosting subscription

## Context
`ventas314-pricing.md` sets the business model: 1 free design, extra designs sold in packs, paid hosting. Coyote has no payment code yet (PLAN.md:466-467 leaves the provider undecided, behind `payments.ts`). Decisions from the Q&A:
- **Provider:** Paddle **sandbox**, in the existing shared sandbox account (it already holds "Guardiana Plus"). Our webhook ignores everything except our price IDs with `custom_data.app = "coyote"`.
- **Free design:** stays 1 per email (`core/free-draft.ts`). WhatsApp verification comes later, with Phase 2.
- **Free designs:** each email already gets 3 paid-tier page writes (`core/paid-writes.ts`: the first design and 2 redesigns), and Mi sitio shows a banner when they run out. Credits extend that count; the banner gets the buy button.
- **Design pack:** USD 5, one-time, gives **3 design credits**. One credit pays for each paid-tier page write (`modelTier` in `models.ts`: Opus today) after the free one. Free-tier writes (Haiku: template mode, `page-model haiku`) never spend a credit. A credit pays for: a new site, or a redesign from the chat ("Rediseñar con esta idea", photos added or removed). No free redesigns. Subscribers pay credits too. Free, as today (no Opus call): text edits, contact edits, photo swaps, the chat itself, undo. `EDITS_PER_DAY = 5` stays as a safety cap.
- **Hosting:** subscription at **USD 7.99/month**, one per site, same price everywhere (no Argentina override). The pack pays for designs only.
- **Scope: payment only.** The subscription marks the site paid. Publishing (domain → CloudFront tenant + DNS) and registering the domain stay for later.

## Paddle catalog (I create it through the Paddle sandbox MCP)
| Product | `tax_category` | Price |
|---|---|---|
| "Ventas314 – Hosting" (`custom_data.app: coyote`) | `website-hosting` | USD 799, `billing_cycle` month/1, quantity 1–1 |
| "Ventas314 – 3 diseños" | `standard` (or `saas`) | USD 500, one-time, quantity 1–1 |

The price IDs go into `infra/cdk.json` context as `paddle: { env: 'sandbox', clientToken, hostingPriceId, designsPriceId }`. This works like `turnstileSiteKey`: the client token is public, and synth keeps working without credentials. Paddle converts USD into local currencies on its own.

## Backend (`services/generator`)
1. **`core/credits.ts`**: design credits per email, on the account profile row in AccountsTable.
   - `creditsOf(emailId)`
   - `spendCredit(emailId)`: conditional atomic decrement, refused at 0.
   - `refundCredit(emailId)`
   - `addCredits(emailId, n, txnId)`: a TransactWrite that puts `paddle-txn#<id>` only if absent and increments the balance, so a retried webhook doesn't add credits twice.
   - Add these methods to the `Stores` interface (`core/jobs.ts`) and implement them in `aws/stores.ts`, like `hitRateLimit` / `releaseRateLimit`.
2. **Spending on a new site** (`core/submit.ts:85`, `core/generate-job.ts:340`), only when the job's `tier` is `paid`:
   - If the free draft is used and the request carries a Mis páginas web session for that email, the job is marked `paidWith: 'credit'` and `spendCredit` runs at the claim.
   - A failure gives back whatever paid for it, at the same places that call `returnFreeDraft` (`generate-job.ts:443,489`).
   - Without a session, it stays 409 `has_draft`. Otherwise anyone who typed the email into the form could spend someone else's credits.
3. **Spending on a redesign** (`core/owner.ts:150`):
   - After the daily cap, `spendCredit(site.ownerEmailId)` when the writer's tier is paid. At 0 it answers 402 `no_credits`.
   - Photo swaps (`replaceMade`) stay free.
   - A redesign job that fails refunds its credit, like in step 2 (job field `paidWith`).
   - `ownerView` adds `credits` and `billing`.
4. **`core/payments.ts`**: a `Payments` interface, so the core never imports the Paddle SDK.
   - `checkout(kind, site, emailId)`: creates a Paddle **transaction on the server**, with `custom_data {app, kind, slug, emailId}`, and returns its id. The browser can't forge what it buys or for whom.
   - `portalUrl(customerId)`
   - `handleEvent(event)`:
     - `transaction.completed` for the designs price → `addCredits(3)`.
     - `subscription.created|updated|activated|past_due|canceled` → `site.billing = { subscriptionId, customerId, status, nextBilledAt, scheduledChange }` on the `SiteRecord` (`jobs.ts`). The site is paid while `status ∈ {active, past_due}`.
     - Events that aren't ours are acknowledged with 200 and ignored.
5. **`aws/paddle.ts`**: implements `Payments` with `@paddle/paddle-node-sdk` (environment from config) and verifies webhooks with `webhooks.unmarshal`. The API key and webhook secret come from Secrets Manager `coyote/paddle` (JSON `apiKey`, `webhookSecret`).
6. **Handlers** (`handlers/payments.ts`):
   - `POST /me/checkout` `{kind: 'designs'|'hosting'}`: authenticated with `authenticate`. A site that already has an active subscription gets 409.
   - `POST /me/billing/portal`: returns the Paddle customer portal URL, for cancelling or changing the card.
   - `POST /paddle/webhook`: no auth and no CORS. It verifies `Paddle-Signature` on the raw body (decoded from `isBase64Encoded`) and answers 200 fast. A bad signature gets 400.
7. `admin.ts` / `coyote.sh`: `./coyote.sh credits <email> [add <n>]` to look at or adjust a balance, for support and testing.

## Infra
- `infra/lib/generator-api.ts`:
  - A `payments` Lambda through the `fn()` helper.
  - The three routes, added with `route()`.
  - `Secret.fromSecretNameV2('coyote/paddle').grantRead`
  - Read/write access to the Sites and Accounts tables.
  - Paddle config passed in the environment.
- `infra/lib/coyote-stack.ts`: route throttles for the new routes. The webhook needs a generous limit.
- `infra/lib/csp.ts` `appCsp`: add `https://cdn.paddle.com` to script-src, `https://sandbox-buy.paddle.com https://buy.paddle.com` to frame-src, and the Paddle endpoints in connect-src. I'll check the exact hosts in the browser.

## Frontend (`web/`)
- **`web/src/scripts/paddle.ts`:**
  - Loads Paddle.js (`Paddle.Environment.set('sandbox')`, `Paddle.Initialize({ token })`) from the runtime `config.js`.
  - `buy(kind)` → `POST /me/checkout` → `Paddle.Checkout.open({ transactionId })`.
  - On `checkout.completed` it polls `GET /me` until the credits or billing change.
- **Mi sitio** (`MySite.astro`, `my-site.ts`):
  - **Change tab:** a line "Diseños disponibles: N", and the "Comprar 3 diseños · USD 5" button. That button also shows on the 402 `no_credits` answer instead of the plain error.
  - **New "Plan" card under the title:** "Hosting USD 7.99/mes". The "Suscribirme" button runs `buy('hosting')`. When paid, it reads "Suscripción activa · próximo cobro …" with an "Administrar suscripción" link (the portal). It also says publishing on your own domain is coming soon.
- **Mis páginas web:** shows the credit balance and buy button, plus "Nueva página (usa 1 diseño)" with the session. Create's `has_draft` message points there.
- **Copy:** es (tú), `esVos` and pt-BR in `strings.ts`.

## Plans and docs
- PLAN.md:
  - Phase 8: tick "payment provider chosen: Paddle".
  - Replace `:467` with the checkout + webhook items above.
  - Add a short "Pricing" section (free design / 3 for USD 5 / USD 7.99/month).
  - Update the free-draft line `:132`.
  - Note that `:529` (renewal scheduler) applies to domains only, because Paddle renews the subscription.
- `ventas314-pricing.md`: record the decision of USD 7.99/month instead of 100/year.
- README runbook: Paddle sandbox setup and test cards.
- CLAUDE.md: one line on payments under Architecture.

## 👤 Steps for you
1. In the Paddle sandbox dashboard:
   - Create an API key (products, prices, transactions, customers, subscriptions, customer portal).
   - Create a client-side token.
   - After the first deploy, create a notification destination for `https://api.<domain>/paddle/webhook`, subscribed to transaction.completed and subscription.*.
2. Put `{"apiKey": "...", "webhookSecret": "..."}` into Secrets Manager `coyote/paddle`, then give me the client-side token, which is public, for `cdk.json`.

## Verification
- **Unit tests (vitest):**
  - credits: spend at 0 is refused, `addCredits` is idempotent, refund.
  - submit: credit path with and without a session.
  - owner: 402 at 0 credits, swaps don't charge, a failed redesign refunds.
  - payments: event → state mapping, foreign events ignored, a bad signature is rejected (signed fixture).
  - `stack.test.ts`: routes, secret grant, CSP hosts.
- `npm run build && npm test && npm run synth` without credentials.
- **Deploy, then end to end with `npm run dev`:**
  - Buy a pack with test card `4242 4242 4242 4242` → credits 3 → a redesign leaves 2.
  - Subscribe → "Suscripción activa" → cancel in the portal → status canceled.
  - Replay a webhook from the Paddle simulator → credits not doubled.
  - Check the Lambda logs and the DynamoDB rows through the AWS MCP.
