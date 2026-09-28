# Coyote — AI website generator for LatAm small businesses

## Goal
A public web form asks 3 questions. A model writes the content (asking the owner a few follow-up questions when the answers are thin), a renderer fills a hand-built theme, and the site is published at `{slug}.<sites-domain>`. Everything runs on AWS. Until the publishing plan, every site is a private draft seen only through the owner's magic link.

## Decisions
- **LLM**: Claude Opus 5.5 through Anthropic's API (the user's key) writes each page; Claude Haiku 4.5 on Amazon Bedrock asks the follow-up questions; Nova 2 Lite pre-screens.
- **Hosting**: one subdomain per site (wildcard cert + CloudFront rewrite).
- **Auth**: none. Rate-limited.
- **Stack**: TypeScript everywhere (CDK, Lambda, Astro frontend).
- **One environment.** A single stack, `Coyote`, in this AWS account, which is the development sandbox: `localhost:5173` may call the API, `cdk destroy` deletes all data, and the rate limit is relaxed. No dev/prod split in code, names, or URLs. If a real production environment is ever needed, it is a **separate AWS account** running the same stack (`COYOTE_AWS_PROFILE=<prod profile> ./coyote.sh deploy`). Real users only ever go on that account; nothing in this one is meant to survive.
- **IaC**: every AWS resource is defined in CDK. Manual one-offs are marked 👤 in the phases.
- **Region**: us-east-1 for everything. One stack, no cross-region references. Bedrock, Route 53 Domains, CloudFront SaaS Manager, and ACM for CloudFront are native there. CloudFront edges in São Paulo, Bogotá, Santiago, Buenos Aires, and Mexico City serve the sites. Only the API round-trip (~100 ms per submission) is slower than sa-east-1.
- **Opus 5.5 writes each page, with the frontend-design skill as its system prompt** and a request written like a chat message. Rules in the prompt made the designs worse, so the rules are checks on the finished page (`page-check.ts`): what can be repaired is repaired; a page that fails a content check is rejected, and one that never arrives fails the job. There is no themed fallback and no generated photo: Opus draws what the page needs as SVG, and uses the owner's photos when there are any. Pages may use inline JavaScript, Tailwind and libraries from a few CDNs; the sites CSP gives scripts no network access. Contact edits swap the new details into the page with no model call; free-text edits send the current page back to Opus. Drafts made before the page writer still render and edit with their theme (`edit_content`).
- **MVP sites have only the WhatsApp CTA.** The contact form and SES email are post-MVP. They are built with WhatsApp lead delivery first (`PLAN-PHASE2.md`), email second.
- **Our frontend is Astro, built to static files.** Generated business sites are not Astro: they are rendered in Lambda by `render.ts`, where no build step can run.
- **Local toolchain**: Node 24, CDK CLI, SAM (not used).

## Domains
Two domains:
- `<domain>` — the brand. Hosts the generator UI (`app.<domain>`), the API (`api.<domain>`), and email (`notify.<domain>`). Needs a Route 53 hosted zone.
- `<sites-domain>` — a separate registrable domain, only for user sites (`{slug}.<sites-domain>`). Safe Browsing and mail reputation are tracked per registrable domain, so a phishing page must not be able to flag the app, API, or email. Buy it with Route 53 Domains and submit it to the Public Suffix List once live.

Domains arrive in stages. The `cdk.json` context (`domainName`, `sitesDomainName`) selects the mode:
1. **Domainless** (now, until the project is stable): both values unset. No ACM, no Route 53, no aliases. App at its `dxxxx.cloudfront.net` URL, API at the default `execute-api` URL. Sites are path-based: `https://<sites-dist>.cloudfront.net/{slug}/` (after the publishing plan), drafts at `/_draft/{draftId}/`. (A `cloudfront.net` hostname cannot do wildcard subdomains.)
2. **`consideralohecho.com`** (internal testing, when the user decides): `domainName = consideralohecho.com`, `sitesDomainName = sites.consideralohecho.com`, so sites live at `{slug}.sites.consideralohecho.com`. Sharing one registrable domain is fine only while nothing is public.
3. **Final domains** (before public launch): separate registrable domain for sites, PSL submission.

`consideralohecho.com` itself serves only the project landing page (`landing/index.html`, a static file hosted outside the stack). It does not change the stack's domain mode.

Context keys: `domainName`, `sitesDomainName`, and optionally `hostedZoneName` / `sitesHostedZoneName` when a name lives in a parent zone (stage 2: `sitesDomainName = sites.consideralohecho.com`, `sitesHostedZoneName = consideralohecho.com`).

Switching stage = change the context, redeploy, run `./coyote.sh refill-all`. To keep it that simple:
- No domain literal in code, themes, or tests.
- `urls.ts` (`siteUrl(slug)`, `draftUrl(draftId)`, `appUrl`, `apiUrl`, the map URLs) is the only code that knows the mode. CSP, CORS, and Origin checks derive from it.
- Themes reference assets with relative URLs, so a page works at `/_draft/{id}/`, at `/{slug}/`, and at a subdomain root. Drafts in domain mode live at `draft.<sites-domain>/{draftId}/`.

## AWS profile
The project uses the AWS CLI profile **`coyote`** (account `887799775985`, IAM user `coyote`, default region us-east-1).
- Root npm scripts pass `--profile coyote` to `cdk`. Local scripts set `AWS_PROFILE=coyote`. Never fall back to the default profile.
- CI only builds, tests, and synths; it never touches AWS.
- Without the profile: no `cdk deploy`, no Bedrock calls from `local-generate`. `cdk synth` still works in domainless mode (no `fromLookup`).

## Architecture

```
browser ──(form, es/pt)──> CloudFront #1 [app.<domain>] ──> S3 appBucket (generator UI + "Mi sitio", JS allowed)
   │
   └── POST /generate ──> API Gateway HTTP API [api.<domain>] ──> submit Lambda ──> DynamoDB jobs (PENDING)
                                     (rate limit → pre-screen → slug claim)  │ async invoke (failure → job FAILED)
                                                        v
                                                 generate Lambda ──> Bedrock (Claude Haiku 4.5): plan_site → questions? → brief → content JSON
                                                        │              ──> policy → render(theme, content) ──> S3 _draft/{draftId}/index.html
                                                        └──> DynamoDB sites (currentDraftId, drafts) + jobs (NEEDS_INPUT | DONE, draftUrl)
   browser polls GET /jobs/{id} ──> {status, questions?, draftUrl?, magic link once}; answers → POST /jobs/{id}/answers

visitor ──> https://{slug}.<sites-domain> ──> CloudFront #2 (wildcard alias, CSP script-src = theme script hashes)
              CloudFront Function: Host → path rewrite  /{slug}/index.html  ──> S3 sitesBucket (OAC, private)
```

- **Async + polling**: generation takes 20–60 s; API Gateway caps sync responses at 30 s.
- **Two distributions**: CloudFront picks the cache behavior (and its response-headers policy) from the original path, before the viewer-request function rewrites by Host. One distribution cannot give sites their own script policy (only theme scripts, by hash) while the generator UI runs its own JS.

## Repo layout

```
coyote/
  package.json            # npm workspaces, root scripts (build, test, dev, deploy)
  tsconfig.base.json
  infra/                  # CDK app (TypeScript)
    bin/coyote.ts
    lib/coyote-stack.ts   # us-east-1: ACM certs, S3, 2× CloudFront, Route53, API GW, Lambdas, DynamoDB
    lib/cf-rewrite.js     # CloudFront Function (host → path rewrite, sites distribution)
  services/generator/     # Lambda code
    src/handlers/submit.ts
    src/handlers/generate.ts
    src/handlers/status.ts
    src/core/prompt.ts    # brief, content, plan_site, and edit_content prompts
    src/core/pipeline.ts  # design_brief → publish_content
    src/core/site-writer.ts     # plan_site (follow-up questions) and edit_content (free-text edits)
    src/core/bedrock.ts   # Converse tool call, effort, caching, images
    src/core/content.ts   # content JSON schema (zod) + patch function
    src/core/render.ts    # render(theme, content, brief) → HTML; escapes every interpolation
    src/core/drafts.ts    # draft storage (_draft/, _src/, _media/), re-render
    src/core/questions.ts # the model's follow-up questions and the owner's answers
    src/core/css.ts       # signatureCss sanitizer (parser-based allowlist)
    src/core/policy.ts    # safety checks on content JSON + rendered HTML
    src/core/quality.ts   # slop lint + brief repair
    src/core/slug.ts      # slugify, reserved/brand list, atomic claim
    src/core/urls.ts      # all URLs, domainless + domain modes
    src/core/ratelimit.ts # per-IP daily counter in DynamoDB
    themes/               # theme templates + CSS + metadata
    logos/                # SVG logo templates
    scripts/local-generate.ts   # fixed businesses through the real model → out/sites/ + the sites sheet
    scripts/theme-sheet.ts      # every theme with sample content, no model call
    test/                 # vitest: flows, owner, render escaping, css sanitizer, policy, prompt snapshot
  web/                    # Astro workspace: landing, form, "Mi sitio", reportar, terms, privacy
    src/pages/            # es at /, pt at /pt/ (Astro i18n routing)
    src/layouts/, src/components/, src/i18n/
    src/scripts/          # plain TypeScript for the form, polling, questions, Mi sitio (type-checked with tsc; `astro check` does not run on TypeScript 7)
    public/config.js      # runtime API URL (written by the dev script and by BucketDeployment)
```

## Local development
`npm run dev` runs `astro dev` for `web/` on `http://localhost:5173` and calls the real API Gateway of the deployed stack. Only the frontend runs locally; Lambdas, DynamoDB, S3, Bedrock, and CloudFront are the deployed ones.
- The browser needs no AWS credentials (the API is public HTTPS). The `coyote` profile is only needed to deploy: `./coyote.sh deploy` → `cdk deploy Coyote --profile coyote`. `coyote.sh` in the repo root holds the project commands: `deploy`, `destroy` (deletes the stack and all data, for when the project is parked), the admin commands, and the alert-subscription commands.
- The API base URL is the only environment-specific value in the frontend. It is loaded at runtime from `config.js`, not baked in at build time, because CDK only knows the URL after deploying. `npm run dev` writes `web/public/config.js` from `infra/cdk-outputs.json` (written by `cdk deploy --outputs-file`, gitignored). `BucketDeployment` writes the deployed value. A `?api=` query parameter overrides it.
- Because this account is the sandbox, the stack allows local development:
  - API CORS allows `http://localhost:5173` next to the app origin.
  - Sites CSP `frame-ancestors` also lists `http://localhost:5173`, or the draft iframe is blocked.
  - Per-IP rate limit raised (e.g. 100/day) so testing does not hit 429.
- Drafts open at their real URLs (domainless: `https://<sites-dist>.cloudfront.net/_draft/{draftId}/`; with a domain: `draft.<sites-domain>/{draftId}/`). CSP, rewrite, and guardrails are the real ones. Each test site costs about $0.40–0.60 (Opus 5.5).
- The form UI (phase 5) therefore needs phases 3–4 deployed. Before that, only static layout and copy work on `web/` is possible.

## The 3 questions (form)
1. **Nombre del negocio** — business name.
2. **¿Qué hace tu negocio?** — free text: industry, products/services, city/country. Drives language, tone, currency.
3. **¿Cómo te contactan?** — WhatsApp number (the main CTA in LatAm), address, Instagram/Facebook (optional).

A language selector (es / pt) sets the site's language. Owner email is not collected in the MVP; it is added in "Mi sitio" when the contact form ships.

## Generation (`services/generator/src/core`)
- **Page writer** (`page-writer.ts`, `page-check.ts`): Claude Opus 5.5 (`claude-opus-5-5`, `PAGE_MODEL` overrides; effort `PAGE_EFFORT`, default high, one level lower for edits) through Anthropic's API, streaming, with the frontend-design skill (`frontend-design.ts`, Apache-2.0, bundled verbatim) as the system prompt. Each request starts from nothing, so Opus converged on one look per kind of business; a new site's request adds one sentence offering 3 random tones from the skill's own list and a light or dark page (`pickLook`). The request is worded like the chat request that gave the best designs (business, owner's answers, contact details, photo file names, "don't invent facts"), with the photos attached as images; no tags, notes, or rules in it: safety is the checks on the finished page. The contact answers' phone numbers are sent as stand-ins of the same shape and swapped back afterwards; numbers the owner writes in the description or answers go as written. Measured: $0.40–0.60 and 3–4 minutes per page; an edit about $0.50. The API key is the Secrets Manager secret `coyote/anthropic-api-key` (👤 created by hand), readable only by `generate`. Opus goes through Anthropic's API because the Bedrock account refuses it.
- **Checks on a written page**: links only to the owner's WhatsApp, phone, email, Instagram, Facebook, or Google Maps (others become `#`); no outside images, other iframes than the Google map, scripts or stylesheets from other hosts, `<base>`, or form actions (all removed); no redirects in scripts, meta refresh, or phone numbers and emails the owner never wrote (the page is rejected; numbers and emails in the description, the answers to the questions, and edit requests count as the owner's, so a second branch or an orders email is fine); the visible text passes `checkTexts` and the output guardrail. Then the overflow guard and the platform footer are added. The checks run again on every render.
- **Models**: Claude Haiku 4.5 writes the follow-up questions (and edits of old themed drafts); the pre-screen stays on Amazon Nova 2 Lite. Both defaults live only in `src/core/models.ts`; `BEDROCK_MODEL_ID` and `PRESCREEN_MODEL_ID` override them. ≈ $0.003 per site on Haiku. Claude models get `toolChoice: auto` with the tool named in the prompt (newer models reject a forced tool); effort is sent only to models that accept it.
- **Follow-up questions**: before writing, `plan_site` returns ready or up to 4 typed questions. With questions the job becomes `NEEDS_INPUT`; the owner answers or skips ("Generar así") through `POST /jobs/{id}/answers`, and the job resumes. One round only. Free-text answers go to the model inside `<answers>` after the input guardrail and the pre-screen; contact answers (phone, email, address, social) are validated like the form and go into the contact details, never to the model.
- **Token budget** (Haiku, measured ≈ 7k in / 1–1.5k out per site with questions): brief ≈ 2k in / 0.5k out; content ≈ 3k in / 1–1.5k out (`maxTokens` 3k); pre-screen ≈ 1.5k in / 0.1k out. Log `usage` from every call into `jobs` and expose cost per site as a CloudWatch metric.
- **No prompt caching**: Haiku 4.5's minimum cacheable prefix is ~4k tokens (verify) and the seeded theme candidates change the prefix, so hits would be rare.
- **Model call**: `BedrockRuntimeClient` + `ConverseCommand`, explicit `maxTokens`, `retryMode: "adaptive"`. Model IDs from env `BEDROCK_MODEL_ID` / `PRESCREEN_MODEL_ID`. Use the `us.` inference profile; check IDs with `aws bedrock list-inference-profiles --region us-east-1 --profile coyote`.
- **Structured content via tool use**: force a `publish_content` tool whose schema is the content model (`content.ts`, zod → JSON Schema):
  `{ title, description, headline, subhead, about, services: [{ name, detail? }], hours?: [{ days, time }], location: { neighborhood?, city? }, ctaText, signatureCss? }`
- **Contact details are never model output.** WhatsApp number, social handles, and address are copied from the form into the content record (`SiteContent = ModelContent + businessName, lang, contact, media`), so the model cannot invent a phone number. The phone number is not even sent to the model.
- **Renderer** (`render.ts`): each theme is a TS template function. Every interpolated value is HTML-escaped. Links are built only from typed fields (`wa.me/<number>`, `instagram.com/<handle>`, maps query). The theme guarantees: single HTML file, inline CSS, mobile-first, no JS, no external assets except Google Fonts, `<meta>` for SEO and Open Graph.
- **System prompt** (copy only): language/locale from the answers; no invented facts (prices, reviews, addresses); the sections the theme expects; a natural WhatsApp CTA.
- **`signatureCss`** (optional; the only code the model writes): parsed with a real CSS parser (`css-tree`/`postcss`). Allowlisted properties only; no `url()`, `@import`, `position: fixed`, or selectors outside `.signature`. Dropped on any parse error. The sites CSP is the second line of defense.
- **Stored state**: per draft, the record (answers, content, brief, notes, and the written page when there is one) under `_src/<slug>/`, the rendered page and its images under `_draft/<draftId>/`. The `sites` item holds `currentDraftId` and the last 5 drafts. Re-rendering is a pure function of the record.
- **Slug**: slugify(business name). Claimed atomically in `submit` with a conditional put on `sites` (`attribute_not_exists(slug)`). Clean slug first; 4-char random suffix only on collision. Refused before claiming: reserved words (`www`, `api`, `app`, `mail`, `preview`, `draft`, `admin`, `static`, anything starting with `_`), the `blocklist` table, and the brand-impersonation list (`bancolombia.<sites-domain>` is the likeliest phishing vector).
- **Rate limit** (ships with the API in phase 4): API GW route throttling (e.g. 5 rps / burst 10) + per-IP DynamoDB counter with TTL (e.g. 3 sites/IP/day). Checked before the pre-screen call, so a blocked request spends no Bedrock money. WAF deferred.
- **Guardrail on the input**: only the requester's text is sent as `guardContent`. Our own prompts name the banned categories and would otherwise trip the topic filters on every request.
- **Bundling**: Lambdas are bundled to CommonJS with the AWS SDK included. `css-tree` is aliased to its self-contained build (its ESM entry breaks when bundled). `./coyote.sh deploy` loads every bundle before deploying, because unit tests run unbundled code and cannot see this kind of failure.
- **Failures**: the `generate` async invoke has an on-failure destination that marks the job `FAILED` and frees the slug of a site with no draft. `status` also reports `FAILED` for any job `PENDING` longer than 12 min (counted from when the job last became PENDING). `generate` runs up to 10 minutes; the page writer stops at 9 (retries included) and the job becomes `FAILED`.

## Content safety
Blocks adult, phishing, scams, hate, and illegal content. Four independent layers; a request must pass all.

1. **Bedrock Guardrail, input and output**
   - Input: `guardrailConfig` on every Converse call (`trace: "disabled"`).
   - Output: generated text sits in a `toolUse` block, which Converse guardrails may not evaluate (verify). So `generate` calls `ApplyGuardrail` on the visible text extracted from the content JSON, and on the model's questions before they are shown. Cheaper and fewer false positives than scanning HTML/CSS.
   - Standard tier. The Classic tier covers only en/fr/es; Portuguese needs Standard, which requires cross-region guardrail inference (verify).
   - Content filters: sexual and hate at HIGH. Violence, insults, misconduct start at MEDIUM and are tuned on the fixtures (HIGH rejects butchers, martial-arts gyms, tattoo studios). Prompt-attack filter on input.
   - Denied topics, each defined narrowly with es/pt/en examples: adult/escort services; all gambling (casinos, betting, lottery agencies and kiosks, bingo), licensed or not; businesses whose main activity is selling alcohol, tobacco, or vapes (bars, liquor stores, vape shops; a restaurant that also serves drinks is allowed); pawn shops and money exchange offices; illegal drugs and weapons; financial fraud, crypto "investment" schemes, pyramid/MLM; impersonation of banks, governments, delivery companies, or well-known brands; credential/payment collection; pirated content; political campaign material and proselytising content (not a church or community centre's address-and-schedule page); anything sexualising minors.
   - The "main activity" rules (bars, liquor stores, tobacco/vape, pawn shops, money exchange) are enforced only by the pre-screen classifier. As guardrail topics they would also block a restaurant that mentions beer.
   - Word filter: small managed profanity list + custom terms (es/pt slurs, scam phrases like "verifica tu cuenta", "atualize seus dados").
   - Blocked → fixed message, job `REJECTED` with a generic reason. Never show guardrail details to the user.
   - IAM: the generator role's `bedrock:InvokeModel` has a `bedrock:GuardrailIdentifier` condition, so a call without the guardrail is denied.

2. **Pre-screen classifier** (Nova 2 Lite, `PRESCREEN_MODEL_ID`; tool use, ~200 tokens)
   - Input: business name, description, address (never the phone number). Output tool `classify`: `{ reason, decision: "allow" | "reject", category, confidence }`. A reject below `REJECT_MIN_CONFIDENCE` (0.5) is not trusted; the other layers still apply. About 1.5k tokens per call (the rules are in the system prompt).
   - It judges meaning, so it catches what the hardcoded list cannot: look-alike spellings ("B4ncol0mbia"), impersonation with no brand named, and prompt injection in the answers (treated as a reason to reject).
   - Reject list mirrors the denied topics, plus an impersonation check (name/description matches a bank, government agency, courier, or major brand).
   - Runs in `submit` after the rate limit, so rejected requests never reach generation or S3. Returns HTTP 422 with "No podemos crear este sitio". Runs again on the owner's free-text answers to the model's questions and on every edit request.

3. **Policy checks** (`policy.ts`, pure functions, unit-tested)
   - On the content JSON: URLs are removed from every text the model wrote (a legit owner may mention their website; it must not become a way to send visitors elsewhere). Then scan all text, including the business name and address, for scam phrases, credential requests (a credential word plus a request verb in one sentence, so "la clave de nuestro pan" passes), and card numbers (Luhn). Match → `REJECTED`.
   - Brand impersonation (`brands.ts`), two scopes. Business name and slug: banks, payment companies, couriers, government agencies, big platforms (Bancolombia, BBVA, Itaú, Nubank, Mercado Pago, SAT, AFIP, Correios, DHL, WhatsApp, …). Title and headline: only banks, payment companies, and couriers, so an accountant can write "declaraciones ante el SAT" and anyone can write "pide por WhatsApp".
   - On the rendered HTML (catches theme bugs): no `<script>`, `<iframe>`, `<object>`, `<meta http-equiv="refresh">`, inline event handlers, or `javascript:` URLs; no `<form>` except the theme's `data-coyote-contact` form (post-MVP); no password/card inputs; outbound links only to `wa.me`, `api.whatsapp.com`, `instagram.com`, `facebook.com`, `maps.google.com`/`goo.gl/maps`, `tel:`, `mailto:`; external resources only from `fonts.googleapis.com`/`fonts.gstatic.com`.
   - Any failure → `REJECTED`, nothing uploaded.

4. **After publication**
   - Every page has a footer "Sitio creado con Coyote · Reportar · Privacidad", added by the renderer, not the theme. Sites have no JS or forms, so "Reportar" links to the app page `/reportar?sitio={slug}`, which calls `POST /report/{slug}`. Reports go to an SNS topic (email to the admin). Auto-unpublish only after N reports from distinct IP hashes (otherwise anonymous reports can be used against competitors). Quarantine moves the S3 prefix to `_quarantine/`, is reversible, and shows on the owner's "Mi sitio" page.
   - `jobs` stores the 3 answers, IP hash, guardrail outcome, and classifier decision for 90 days.
   - `./coyote.sh unpublish <slug>`: removes the pages and adds the slug to `blocklist` so it cannot be claimed again. `./coyote.sh restore <slug>` undoes a quarantine.
   - CloudWatch metric + alarm on `REJECTED` rate (a spike means probing).

**Detecting abuse.** Every alarm emails the admin through one SNS topic (`alerts`).
- Lambdas emit metrics with CloudWatch EMF (no extra API calls): `Submitted`, `RateLimited` (429s), `Rejected`, `NeedsInput`, `Generated`, `Edited`, `Failed`, `TokensIn`/`TokensOut`, `HeroImages`.
- Alarms: sites generated per hour above normal; `RateLimited` spike (someone hitting the cap repeatedly); `REJECTED` rate spike (probing); tokens per day above budget; API Gateway 4xx/5xx and throttle count; `generate` errors.
- Money: AWS Budget alert plus AWS Cost Anomaly Detection (free) on the account.
- One CloudWatch dashboard with the metrics above.
- `./coyote.sh abuse-report`: reads `jobs` for the last 24 h and prints the top IP hashes by requests, their decisions and categories, and the newest drafts. This is the tool for "who is doing this", since metrics only say "something is happening".
- Visitor reports (footer link) arrive by email through `abuse-reports`.

Policy text (es/pt) lives in the terms page, linked from the form. The submit button states acceptance.

## Design quality
A model left alone produces the same page every time: purple-to-blue gradient hero, "Bienvenidos a…", three centered icon cards, Inter/Roboto, generic copy. Countermeasures, highest impact first:

The page writer (Opus 5.5 with the frontend-design skill) is the design now. What follows describes the themed pages, which are no longer generated; the code stays only to render and edit drafts made before the page writer, and can be deleted with them.

1. **Hand-built theme library** (`services/generator/themes/`), designed with Claude Opus 5.5 in chat: the user asks Opus for each theme as one static HTML/CSS page built around the content slots, and it is converted into a theme file. This replaces the first nine themes, which looked dated. (Model-written pages were tried and parked: see `PLAN-MODEL-SITES.md`.)
   - 8–12 themes (editorial/serif, warm artisan, bold poster, dark luxury, playful pastel, brutalist/raw, tropical/vibrant, clean clinical, …). Each = CSS foundation + template function (hero variant, section rhythm, texture/grain, motion on load) + tokens (`--ink`, `--paper`, `--accent`, font pairing, radius, spacing scale).
   - Theme metadata: suited industries, mood words, light/dark. The model picks and fills; it never writes layout. Quality is bounded by the worst theme, not by the model's taste.
   - The model may add `signatureCss` for one signature element so pages don't look templated.
   - Layout rules (no three-equal-card row, not everything centered, no glassmorphism) are enforced in theme review, not at runtime.

2. **Two-step generation**
   - Step A, `design_brief` tool: `{ theme, palette (3 colors from the business, not the industry cliché), fontPairing (allowlist of ~20 Google Fonts pairings; no Inter/Roboto/Arial/Space Grotesk/Poppins), tone, signatureElement (giant type hero, diagonal split, hand-drawn divider, menu board layout, …), headline (max 6 words, no "Bienvenidos") }`.
   - Step B, `publish_content` tool: the content JSON, given the brief and the theme's slot descriptions. Deciding first and writing second keeps the model from falling back to defaults.

3. **Variety seed**: a seed from the slug hash pre-selects 3 candidate themes and 3 font pairings; the model chooses among them. Log the choice in `jobs`. A weekly query shows the histogram and flags any theme above ~25%.

4. **Negative list in the system prompt** (`prompt.ts`, snapshot-tested)
   - Copy: no "Bienvenidos a", "Soluciones integrales", "Calidad y compromiso", "Tu satisfacción es nuestra prioridad", "Somos una empresa dedicada a…" (es + pt lists). No invented testimonials, prices, or awards. No emoji as icons. Concrete headlines ("Pan de masa madre, cada mañana en Chapinero").
   - Palette: no purple/indigo/blue-on-white gradient.
   - Do: one dominant color + one sharp accent; real local detail from the answers (neighborhood, hours, city); tuteo/voseo/você per country; local currency symbol; natural WhatsApp CTA.

5. **Slop lint before publish** (`quality.ts`, pure functions), on the brief + content JSON
   - Font pairing in the allowlist; palette hues outside purple/indigo; no banned phrases; headline ≤ 8 words; no emoji in headline or service names; `signatureCss` passes the sanitizer.
   - Fail → regenerate once with the lint messages. A second miss ships as it is: the lint is about taste, and the policy check is what guards safety. (Fallback model on a second miss: later, with Claude.)
   - The brief is repaired deterministically instead of regenerated: see `fixBrief`. Renderer token `--on-accent` picks ink or paper, whichever reads better on the accent.

6. **Critic pass** (flag, off by default): a Haiku call scores the content 1–5 (distinctive vs generic, copy specificity). Below 3 → regenerate once with the critique.

7. **Sites sheet**: `npm run generate:local` runs 10 fixed businesses through the real model and writes `out/sites/index.html` (every page at phone and desktop width, with theme, cost, and questions). `npm run themes:sheet` shows every theme with sample content and no model call. Review them after every prompt or theme change.

Trade-off: less surprise per site than free-form output, in exchange for a guaranteed floor. Themes can be added without touching the prompt.

## Images and logo
MVP uses all three.

1. **Logo = SVG from templates** (`services/generator/logos/`)
   - ~10 templates: monogram in circle/shield/badge, wordmark, icon + name lockup, stamp/seal, split-color initials. Parameters: `{ text, initials, icon, colors, font }`.
   - Icon from an allowlisted inline set (Lucide or Phosphor, MIT), chosen in the brief (`logo: { template, icon, text }`). Fonts from the page's pairing allowlist.
   - At publish, render with `sharp`/`resvg`: `favicon.ico`/`icon.png` and a 1200×630 Open Graph image (logo on theme background) under `/{slug}/assets/`.
   - Diffusion rejected: garbled text, no vector, colors don't match the theme.


2. **User uploads** (optional 4th step: "Sube tu logo y hasta 3 fotos")
   - `POST /uploads` returns S3 presigned POST URLs (max 5 MB, `image/*`, key under `_uploads/{jobId}/`). The form uploads before submitting.
   - The browser resizes (logo ≤ 512 px PNG, photos ≤ 1600 px JPEG), which also strips EXIF. `generate` moderates and copies the files to `_media/<slug>/assets/`; every draft gets its own copy next to the page. No image library runs in the Lambdas. The images go to the models as image blocks: to Haiku when it plans its questions, and to Opus, which places them in the page by their file names.
   - Moderation: Rekognition `DetectModerationLabels` on every upload (~$0.001/image). Any explicit/violent/hate label → job `REJECTED`, uploads deleted.
   - `_uploads/` has a 1-day lifecycle rule. Pages must look good with zero photos.

3. **No generated photos.** Opus draws the images a page needs as SVG. (The Stability hero photo was removed: it cost $0.04 and 10 s, and invented a shop that does not exist.)

Infra: an `uploads` Lambda with `s3:PutObject` on `_uploads/*` (it signs the POST); `rekognition:DetectModerationLabels` for `generate`; `bedrock:InvokeModel` on the us-west-2 image model for `generate` (image models take no guardrail, so this statement has no guardrail condition); `s3:DeleteObject` on `_media/*` for `generate` (a flagged generated photo); bucket CORS for browser POSTs. Refused moderation categories: explicit and non-explicit nudity, violence, visually disturbing, hate symbols, drugs and tobacco, gambling. Alcohol and swimwear pass (restaurants and beachwear shops exist).

## Site ownership (magic link)
No accounts, no Cognito. Whoever has the link owns the site. The owner's phone (product phase 2) and verified email (phase 7) later become recovery channels.
- When the first draft of a new site is ready, the create page shows the link once: `https://app.<domain>/mi-sitio#token=<slug>.<secret>` (the first `GET /jobs/{id}` after `DONE` takes it off the job). The token is in the fragment so it never reaches logs or referrers. Token = random 32 bytes, stored hashed in `sites`, 1-year expiry.
- Buttons: "Copiar", "Guardar en mi WhatsApp" (`wa.me/<ownerNumber>?text=<link>`; the owner messages the link to themselves), "Abrir Mi sitio".
- Re-issue ("Enviarme mi enlace") comes with WhatsApp (template `enlace_mi_sitio` to `sites.ownerPhone`) and later email. Until then a lost link means creating a new site.
- "Mi sitio" page: the current draft in an iframe at phone and desktop width; "¿Qué quieres cambiar?" (free text → an edit job: pre-screen, optional questions, `edit_content` on the copy, the content policy and the output guardrail, a new draft); the contact fields (refill, no model call); "Deshacer" (back to the previous draft; the last 5 are kept); delete my data. Post-MVP: last 30 days of messages, pause notifications, add/verify email, buy a domain.
- API: `GET /me`, `POST /me/edit { instruction?, contact? }`, `POST /me/undo`, `DELETE /me`, all with `Authorization: Bearer <token>`, 60 requests per site per day, 10 free-text edits per site per day. `POST /jobs/{id}/answers` answers the model's questions (the job ID is the credential). Unpublish and republish come back with the publishing plan.

## Drafts (nothing is published yet)
- Every version is a draft at `_draft/<draftId>/` (random 128-bit ID), served by the sites distribution with `X-Robots-Tag: noindex` and the sites CSP (inline scripts and the listed CDNs, no network access); `frame-ancestors` lets the app show it. `/{slug}/` is not served until the publishing plan.
- Drafts do not expire; old versions beyond the last 5 are deleted.
- 👤 Later plan: publishing, admin review, and the go-live email.

## Privacy and legal
- Privacy and terms pages (es/pt, written in Markdown): what we store (answers, owner WhatsApp number, IP hashes for rate limiting; later owner email and visitor messages for 30 d), why, retention, how to delete (magic-link page or email). Covers the basics of LGPD (BR), LFPDPPP (MX), Ley 1581 (CO), Ley 25.326 (AR).
- Generated sites link to the platform privacy page in the footer.
- IPs stored only as salted hashes. No cookies or analytics on generated sites.
- The privacy page names Anthropic (answers and photos, never the phone number) and the public CDNs the sites load fonts and libraries from.

## Environments and delivery
- **Environment**: one stack (see Decisions). With domains: `app.<domain>`, `api.<domain>`, `*.<sites-domain>`.
- **CI**: GitHub Actions on every PR: `npm run build` + `npm test` + `cdk synth`. Deploys are manual (`./coyote.sh deploy`); automated deploys with an OIDC role can come with the production account.
- **Runbook** in `README`: deploy, rotate SSM secrets, unpublish a site, check Bedrock quota. No prepaid vendors to top up.
- **Flags**: critic pass, digest mode.

## Infra (CDK, `infra/lib`)
`CoyoteStack` (us-east-1), one per environment. Items marked *(domain mode)* exist only when `domainName`/`sitesDomainName` are set. In domainless mode the stack exports `AppUrl`, `ApiUrl`, `SitesBaseUrl`.
- *(domain mode)* ACM certificates, DNS-validated: `<sites-domain>` + `*.<sites-domain>` (own hosted zone); `app.<domain>` and `api.<domain>` via `HostedZone.fromLookup`.
- *(domain mode)* Route 53 alias records: `app.<domain>`, `api.<domain>`, `<sites-domain>`, `*.<sites-domain>`.
- S3 `sitesBucket`: private, versioned, block public access. Lifecycle: noncurrent versions 30 d, `_uploads/` 1 d. Drafts (`_draft/`) never expire. `_src/` (records) and `_media/` (images) are never served. S3 `appBucket`: generator UI.
- **CloudFront #1 — app**: OAC to `appBucket`, alias `app.<domain>`. A viewer-request function maps clean URLs to Astro's output (`/mi-sitio` → `/mi-sitio/index.html`). CSP: `script-src 'self'` (Astro is configured to emit external script files, no inline scripts), `connect-src https://api.<domain>`, `frame-src https://draft.<sites-domain>`. HSTS.
- **CloudFront #2 — sites**: OAC to `sitesBucket`, aliases `<sites-domain>` + `*.<sites-domain>`. One viewer-request CloudFront Function, both modes unit-tested:
  - `Host == draft.<sites-domain>` → `/_draft/<path>` (only 32-hex draft IDs)
  - `Host == {slug}.<sites-domain>` → `/{slug}/<path or index.html>` (after the publishing plan)
  - apex → redirect to `https://app.<domain>`
  - domainless (`Host` is the `cloudfront.net` name): no host rewrite; `/_draft/{id}` → 301 `/_draft/{id}/`; `/_draft/{id}/` → `/_draft/{id}/index.html`; `/` → redirect to the app. Until the publishing plan, `/{slug}/` (and `{slug}.<sites-domain>`) answer 404.
  - ResponseHeadersPolicy: `default-src 'none'; script-src <sha256 of each theme script, from themeScriptHashes()>; frame-src https://maps.google.com https://www.google.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action https://api.<domain>; frame-ancestors https://app.<domain>`. HSTS. `X-Robots-Tag: noindex, nofollow` while every page is a private draft.
  - Domainless CSP: `frame-ancestors` uses the app distribution URL. Where an exact URL would make the distributions and the API depend on each other in a circle, a wildcard is used instead: sites `form-action https://*.execute-api.<region>.amazonaws.com`, app `connect-src` the same, app `frame-src https://*.cloudfront.net`. Domain mode uses exact origins everywhere.
  - Cache: default TTL 5 min, so an owner's edit shows up without an invalidation. Missing pages (S3 answers 403) return a small 404 page from `_errors/`.
- `BucketDeployment` of `web/dist/` (the Astro build) plus the generated `config.js` → `appBucket`.
- DynamoDB, MVP: `jobs` (pk `jobId`, TTL 90 d; answers, safety outcomes, usage), `sites` (pk `slug`; status, currentDraftId, drafts, ownerWhatsApp, tokenHash, createdAt), `ratelimit` (pk `ip`, TTL), `blocklist` (pk `slug`). Post-MVP: `messages`, `suppression`, `wa_*` (`PLAN-PHASE2.md`), `domains`, GSI on `sites.ownerPhone`.
- `CfnGuardrail` + `CfnGuardrailVersion` (Standard tier; filters, denied topics, word filters as above). ID/version passed to Lambdas via env.
- Lambdas: `NodejsFunction`, Node 22, esbuild. MVP: `submit` (sync, 15 s), `generate` (async, 5 min, 1 GB, on-failure destination → `job-failed` handler), `status`, `uploads`, `owner` (`/me`), `report`. `submit` also serves `POST /jobs/{id}/answers`. Post-MVP: `contact`, `ses-events`, `digest`, `domains`, `wa-*`.
- HTTP API on `api.<domain>`: `POST /generate`, `GET /jobs/{id}`, `POST /jobs/{id}/publish`, `POST /uploads`, `/me/*`, `POST /report/{slug}`. CORS locked to `https://app.<domain>`. Throttling.
- SNS topic `abuse-reports` with email subscription.
- IAM: `bedrock:InvokeModel` scoped to the model/profile ARN with the `bedrock:GuardrailIdentifier` condition, plus the image model without it; `bedrock:ApplyGuardrail` on the guardrail; `s3:PutObject`/`DeleteObject` on the sites bucket; DynamoDB RW on the MVP tables; `rekognition:DetectModerationLabels`.
- CloudWatch alarms on `generate` errors and `REJECTED` rate. AWS Budget alert (e.g. $20/month); Bedrock is the only meaningful cost.

## Implementation phases
MVP = phases 0–6. Tick a box (`[x]`) only when the item is done and its check passed. 👤 = needs the user.

### Phase 0 — Admin (only what blocks building)
- [x] 👤 Create the `coyote` AWS CLI profile; `aws sts get-caller-identity --profile coyote` works
- [ ] 👤 Bedrock access for Claude (Opus 5.5 is the default for model-written sites, see `PLAN-MODEL-SITES.md`; Haiku 4.5 and Sonnet 5 too). Use case form submitted; Nova is used until access is granted. Needs the Anthropic use case form in the Bedrock console (Model catalog → any Claude model), then ~15 min. Profile IDs: `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `us.anthropic.claude-sonnet-5`
- [x] `cdk bootstrap --profile coyote` for the account/us-east-1

### Phase 1 — Scaffold
- [x] npm workspaces, `tsconfig.base.json`, vitest, `.gitignore`, `README`
- [x] Root scripts (`build`, `test`, `dev`, `synth`, `diff`, `deploy`) and `coyote.sh`; deploy/diff use `--profile coyote`
- [x] CDK app skeleton; `cdk synth` passes without credentials
- [ ] GitHub Actions: PR → `npm run build` + `npm test` + `cdk synth` (workflow written; ticks when it passes on a first PR)

### Phase 2 — Generator core, offline first
- [x] `content.ts` schema (zod → JSON Schema) + patch function; `answers.ts` input normalization
- [x] `render.ts` with one throwaway theme (`themes/plain.ts`); escaping tests
- [x] `css.ts` `signatureCss` sanitizer + tests
- [x] `slug.ts` slugify + reserved/brand list (`brands.ts`) + tests
- [x] `urls.ts` (domainless + domain modes) + tests
- [x] `prompt.ts` + `bedrock.ts` + `pipeline.ts` (`design_brief`, `publish_content` tools); prompt snapshot test
- [x] `npm run generate:local` writes `out/index.html` + `out/site.json` (verified end to end with Nova)
- [ ] ~~Re-run on Haiku 4.5 and tune the prompts~~ superseded by the Phase 5c bake-off

### Phase 2a — Theme library + design brief
- [x] Font-pairing allowlist: 21 pairings in 5 styles (serif, sans, contrast, poster, soft), each with its heading weight; `npm run fonts:check -w services/generator` requests every Google Fonts URL
- [x] Themes 1–9 as template functions: `editorial` (magazine), `cartel` (street poster), `artesanal` (handmade), `nocturno` (dark, framed), `tropical` (color blocks), `clinico` (information first), `pizarra` (menu board as the hero), `carta` (a letter from the owner, one column), `mosaico` (bento tiles). The last three also differ in page structure, not only in look: themes should not all share the hero → services → about → visit order. Each declares suited industries, moods, scheme, compatible font styles, and a default palette. `npm run themes:sheet` renders all of them with sample content (no model call) into `services/generator/out/themes/index.html`. Reviewed on desktop and at 390 px. Photo and logo slots come with the `uploads` route
- [x] Variety seed (`variety.ts`): the slug seeds 3 candidate themes, each with 3 compatible font pairings; the model picks a theme and one of that theme's pairings
- [x] `quality.ts`: `fixBrief` repairs the brief without a model call (font not in the theme's list → the theme's first candidate; palette with ink/paper contrast < 7, accent/paper < 3, or the wrong light/dark scheme → the theme's default palette). `lintContent` (banned phrases, headline > 8 words, emoji, exclamation hype) triggers one regeneration with the problems as feedback. The fallback-model step waits for Claude
- [x] SVG logo marks (`services/generator/logos/`): 6 templates built from the business initials, picked by a hash of the site URL, in the page's colors and display font; also used as an SVG favicon. An uploaded logo replaces the mark. All six themes place the logo and the photo slots (first photo = hero image); `themes:sheet` renders each theme with and without photos
- [x] Generated hero photo when nothing was uploaded (`images.ts`, `heroScene` in the brief, Stable Image Core in us-west-2, `HeroImages` metric). Unit-tested; `generate:local` writes it to `out/assets/`. Checked on the deployed stack: a job with no uploads gets its photo
- [ ] 👤 Check the Stable Image Core price on the Bedrock pricing page
- [ ] Later: icon-based logo templates chosen by the brief, and a 1200×630 Open Graph image (needs a rasterizer with fonts in the Lambda)
- [ ] ~~`scripts/contact-sheet.ts`~~ superseded by `generate:local` + the sites sheet (Phase 5c)

### Phase 2b — Content safety core
- [x] `policy.ts` content checks + rendered-HTML invariants + tests; wired into `pipeline.ts` (throws `PolicyRejection`) and `generate:local`
- [x] Pre-screen classifier (`prescreen.ts`, `classify` tool); runs first in `generate:local`
- [x] Guardrail definition (`infra/lib/guardrail.ts`: Standard tier, filters, 7 denied topics, scam word list, pinned version)
- [x] The fixtures run through the deployed guardrail (`verify:live`): no legitimate business blocked, 18 of 27 bad cases stopped by it. Filter strengths unchanged
- [ ] Verify the three unconfirmed items (guardrail tiers for pt, `toolUse` evaluation, cache minimum)
- [x] Fixture set (44 good/borderline/bad cases, `test/fixtures/prescreen-cases.ts`); `npm run prescreen:fixtures` runs them on the real model and compares with the hardcoded list. Nova 2 Lite: 44/44 correct; the model catches 21/21 bad cases, the list alone 4/21
- [ ] Re-run the fixtures on Haiku 4.5 and tune `REJECT_MIN_CONFIDENCE` (waits for Claude access)
- [x] 👤 Policy calls confirmed. Rejected: all gambling including licensed lottery kiosks, bars and liquor stores, tobacco and vape shops, pawn shops, money exchange, cannabis, firearms, political campaigns, betting tips
- [ ] 👤 Still to confirm: church or community-centre info page = allowed; restaurant or café that also serves drinks = allowed

### Phase 3 — Infra (domainless mode)
- [x] `sitesBucket` + `appBucket` with lifecycle rules (direct S3 access returns 403)
- [x] CloudFront #2 (sites) + `cf-rewrite.js` (both modes, unit-tested) + strict CSP
- [x] CloudFront #1 (app) + CSP + clean-URL function
- [x] DynamoDB `jobs`, `sites`, `ratelimit`, `blocklist`
- [x] `CfnGuardrail` + version (Standard tier deployed; smoke test: es/pt scam, casino, escort blocked; bakery, butcher, restaurant with beer pass)
- [x] HTTP API skeleton, CORS (app origin + `localhost:5173`), throttling. The CORS config is deployed; an API with no routes answers 404 to preflights, so the preflight itself is checked in phase 4
- [x] Domain-mode resources conditional; synth-tested with dummy context
- [x] `./coyote.sh deploy` succeeds; `infra/cdk-outputs.json` written
- [x] Check: hand-uploaded `test/index.html` serves at `<sites-dist>/test/` with `script-src 'none'`; `/test` → 301 `/test/`; preview path serves; `_uploads/` and unknown sites → 404 page; root → app; app serves `config.js` with the real API URL

### Phase 4 — API + handlers + rate limit
- [x] `submit`: validate → rate limit → brand list → pre-screen → atomic slug claim → job PENDING → async invoke (`core/submit.ts`)
- [x] `generate`: brief → content → policy → `ApplyGuardrail` → render → HTML check → S3 `_preview/` + `sites` record; `usage` stored on the job (`core/generate-job.ts`). The slop lint joins in phase 2a
- [x] `status` (+ PENDING > 6 min ⇒ FAILED); on-failure destination releases slug; `publish` route (copies the preview to `/{slug}/`, idempotent)
- [x] `uploads`: `POST /uploads` hands out presigned POST slots with fixed names and types (`logo.png`, `photo-1..3.jpg`, ≤ 2 MB each, 20 requests/IP/day). The browser resizes before uploading (logo ≤ 512 px PNG, photos ≤ 1600 px JPEG; the re-encode strips EXIF), so the Lambdas need no `sharp`. `generate` runs Rekognition moderation on every file before any model call (a flagged or invalid image → `REJECTED`, `rejectedBy: image`), then copies the clean files to `assets/`. A regeneration reuses the previous version's images. Verified on the deployed stack with real images, a non-image, and an oversized file
- [x] IAM: `InvokeModel` scoped to the configured model with the `GuardrailIdentifier` condition. Policy simulation: no guardrail, another guardrail, or another model → denied
- [x] Checked on the deployed API: job reaches `DONE` in ~8 s, preview and published site serve with `script-src 'none'`; same name twice → suffixed slug; brand, guardrail, and classifier rejections → 422 with no reason (reason stored in `jobs`); at the limit → 429 with nothing stored and no model call; CORS allows the app and `localhost:5173` only

### Phase 5 — Frontend (Astro)
- [x] `web/` is an Astro 7 workspace: one layout, es at `/` and pt at `/pt/`, one translations file (`src/i18n/strings.ts`). `scripts/write-config.mjs` replaces `scripts/dev.mjs`
- [x] Landing page (zero JS). Look: hand-painted shop signs ("rótulos"), striped awning, order-ticket form; fonts Bungee, Yellowtail, Hanken Grotesk
- [x] Form at `/crear` and `/pt/criar` (3 questions, site language, terms note); validates with the same zod schema as the API (`answers.ts`). The uploads step arrives with the `uploads` route
- [x] `npm run dev` = `astro dev` on :5173 → deployed API (writes `web/public/config.js` from `cdk-outputs.json`). Astro 7 starts the server in the background; stop it with `npx astro dev stop` in `web/`
- [x] Polling/progress state, preview with "Publicar", rejected / rate-limited / failed messages. The job ID lives in the URL hash, so a reload resumes. Checked in headless Chrome against real jobs
- [x] Result screen: link + copy
- [x] Build emits external scripts only; `web/dist/` deployed via `BucketDeployment` (`coyote.sh deploy` builds it first). On the live app: clean URLs work (`/crear`, `/pt/criar`), CSP is `script-src 'self'`, the create script runs and calls the API with no CSP violations

### Phase 5b — Magic link + preview
- [x] Preview iframe, "Publicar", "Genera otra versión" (`POST /jobs/{id}/regenerate`), cap of 2 regenerations per site. A regeneration varies the variety seed, so it offers other themes. Generation results live on the job; the site record and the live page change only on publish
- [x] Magic link: token `<slug>.<secret>`, only the sha256 of the secret stored, 1-year expiry, returned once by the first publish, shown with "Copiar", "Guardar en mi WhatsApp", "Abrir Mi sitio"
- [x] "Mi sitio" page (`/mi-sitio`, `/pt/meu-site`) + one `owner` Lambda for `GET /me`, `POST /me/content|regenerate|unpublish|republish`, `DELETE /me`. An edit goes patch → policy → `ApplyGuardrail` → re-render, with no model call. 60 owner requests per site per day. "Delete my data" removes the pages and the site record and redacts the text of every job of that site. Publish, edit, unpublish, republish, and delete invalidate the CDN cache, so they show at once. Verified end to end on the deployed stack
- [x] Privacy and terms pages (es/pt, Markdown), linked from the footer
- [x] `reportar` page (es/pt). Generated pages link to the report and privacy pages in their own language (`urls.pageLinks`)
- [ ] 👤 Before public launch: legal review of the privacy and terms texts, and a contact address in them

### Phase 5c — Questions, drafts, and new themes
- [x] Model-written pages built and parked (`PLAN-MODEL-SITES.md`, commit `b085099` on `feature/model-sites`): on Haiku 4.5 they did not look good enough, and Opus 5.5 is not available on the Bedrock account
- [x] Follow-up questions (`plan_site` → `NEEDS_INPUT` → `POST /jobs/{id}/answers`), private drafts with the magic link, Mi sitio with free-text edits (`edit_content`), contact edits, undo, delete; publishing removed until a later plan; `refill-all`
- [x] Theme renderer and content pipeline back; Haiku 4.5 is the default content model (≈ $0.01 per site)
- [x] Themes may use bundled Lucide icons (`icons.ts`, `iconFor()` picks one per product line), Tailwind compiled at build time (`npm run themes:tailwind`), and their own animation scripts, allowed by the sites CSP through their SHA-256 hashes; any other script fails the final HTML check
- [x] Retail theme `mostrador` (awning, shop window, price-tag products, scroll reveal); `generate:local --theme <id>` forces a theme for review
- [x] Food theme `fogon` (Tailwind: full-bleed hero, ticker, menu with leaders, hours sticker, parallax) and beauty theme `tocador` (Tailwind: arched hero, turning WhatsApp seal, price list, map beside the hours)
- [x] Google map on the themes: the renderer builds a keyless Google Maps embed of the owner's address (`render.ts` `mapEmbedUrl`; never model output) and passes it to the theme as `map`; `checkHtml` allows exactly that one iframe; the sites CSP has `frame-src https://maps.google.com https://www.google.com`. The URL form is undocumented: if Google changes it, switch it in `render.ts` (keyed Embed API, or no map) and run `refill-all`
- [x] Copy and image fixes found on real sites: the hero scene must be English (a Spanish "llamas" became a llama; one retry, then no photo); voseo is sent back unless the answers name Argentina, Uruguay, or Paraguay; `signatureCss` may no longer write text through `content`; themes keep content out of the `.signature` element
- [x] Opus 5.5 page writer with the frontend-design skill (`page-writer.ts`), checks and repairs on the page (`page-check.ts`), page edits with Opus at one effort lower, contact edits swapped into the page, 5 free-text edits a day; sites CSP with inline scripts and the CDN list; `generate` 10 minutes; privacy page updated
- [x] 👤 Anthropic API key in Secrets Manager (`coyote/anthropic-api-key`)
- [x] Opus writes every new site on its own: no themed fallback, no hero photo (SVG instead); a page writer failure fails the job
- [x] Look nudge against same-looking sites: each new site's request offers 3 random tones from the skill's list and a light or dark page; Opus picks the tone that suits the business (`pickLook`). `opus:sites --repeat 3` shows the spread on one business
- [ ] Deploy and check a written page live (CSP, map, photos, Mi sitio edit)
- [ ] Delete the theme pipeline (themes, render, brief, content prompts, Tailwind build, sheets) once no themed draft is left
- [ ] New themes for health and trades; each checked on `themes:sheet` and `generate:local`
- [ ] Route each business family to its theme (today the model picks among 3 seeded candidates)
- [ ] Themes show phone and email when the owner gives them (`links.phone`, `links.email`)
- [ ] Deploy and live checks, including `verify:live`
- [ ] 👤 AWS Support case: Claude Opus 5.5 and Sonnet 5 refused on the account ("not available for this account")
- [ ] 👤 Later plan: publishing, admin review, and the go-live email

### Phase 6 — Hardening
- [x] Report endpoint (`POST /report/{slug}`) + `reportar` / `pt/denunciar` pages + SNS email per report. One visitor counts once per site; 3 distinct visitors quarantine it (pages moved to `_quarantine/`, status `quarantined`, the owner cannot republish it)
- [x] `./coyote.sh unpublish <slug>` (delete + blocklist), `restore <slug>`, `rerender-all` (now `refill-all`)
- [x] EMF metrics from the Lambdas (namespace `Coyote`); 9 alarms → SNS `alerts`; dashboard `Coyote` (`infra/lib/monitoring.ts`)
- [x] 👤 Alert emails: both topics subscribed and confirmed with authenticated unsubscribe. The stack does not create email subscriptions: a subscription confirmed by clicking the email link can be removed by any mail scanner that follows the unsubscribe link (this happened). `./coyote.sh subscribe-alerts <email>`, then `confirm-alerts '<link>'` per topic; `protect-alerts` repairs click-confirmed ones
- [x] AWS Budget ($20/month, alerts at 80% and 100%) + Cost Anomaly Detection (≥ $5)
- [x] `./coyote.sh abuse-report` (requests per hashed IP, rejections by layer, newest published sites)
- [x] `README` runbook
- [x] Full "Verification" section passes on the deployed stack (contact form excluded: post-MVP). `npm run verify:live -w services/generator` runs the 48 safety fixtures through the deployed API: 48/48. Layers that stopped the 27 bad cases: guardrail 18, pre-screen 5, brand list 4
- [ ] 👤 *(optional, when stable)* switch to `consideralohecho.com`; first real deploy of domain mode; subdomain rewrite verified
- [ ] 👤 Choose the two final domain names: the brand domain (`<domain>`) and the separate one for user sites (`<sites-domain>`). Choosing the brand also unblocks Meta Business verification (`PLAN-PHASE2.md` step 1), which takes weeks, so decide early if WhatsApp is next
- [ ] 👤 **Before any public launch: create the production AWS account** and its CLI profile. Add one production switch to the stack then (retain data + point-in-time recovery, no `localhost` in CORS or `frame-ancestors`, rate limit 3/IP/day) and deploy the same code there. Never launch publicly from the sandbox account: moving live sites, records, and a domain to another account later is real migration work
- [ ] 👤 **Launch gate**: final domains set, redeploy, re-render, final `<sites-domain>` submitted to the PSL (never the testing domain)

**MVP line.** Product phase 2 (`PLAN-PHASE2.md`) runs here: WhatsApp creation, contact form, leads on WhatsApp.

### Phase 7 — Email fallback (SES)
- [ ] SES identity + DKIM + MAIL FROM + DMARC on `notify.<domain>`
- [ ] 👤 Sandbox exit request approved
- [ ] Owner email add/verify in "Mi sitio"
- [ ] Email branch in the `contact` Lambda (built in product phase 2)
- [ ] `ses-events` (bounce/complaint), suppression table, List-Unsubscribe + pause link
- [ ] Digest mode + reputation kill switch + alarms

### Phase 8 — Custom domains
- [ ] 👤 Payment provider chosen (Mercado Pago vs Stripe vs dLocal)
- [ ] 👤 Route 53 Domains quota increase
- [ ] `registrar.ts` + availability check
- [ ] Checkout + webhook (`payments.ts`)
- [ ] `domains` Lambda: register, DNS, distribution tenant + managed cert
- [ ] Renewal scheduler + notifications
- [ ] One real `.com` end to end

## Post-MVP: Contact form
Built in product phase 2 (Flow C). WhatsApp delivery first; SES email (phase 7) is the fallback. Plain HTML form → our API → owner. No JS, no paid CAPTCHA.

- **Injected by the theme, never written by the model.** Each theme has a contact slot: `<form method="post" action="https://api.<domain>/contact/{slug}" data-coyote-contact>`. Fields: `nombre`, `contacto` (phone or email), `mensaje`, hidden `_t` (signed timestamp), honeypot `_web` (must stay empty, hidden via CSS). The policy check allows exactly this form and rejects any other `<form>` or password/card input.
- Rendered only for sites with a delivery channel (WhatsApp opt-in or verified email).
- **Works under the strict CSP** (`script-src 'none'`, `form-action https://api.<domain>`): native POST. The Lambda answers `303` to `https://{slug}.<sites-domain>/#enviado` (or `#error`), and the theme shows the state with CSS `:target`. It must be a fragment; CSS cannot read a query string.
- **Spam controls** (`contact` Lambda, 5 s timeout):
  1. Honeypot filled → drop silently (still 303).
  2. `_t` = HMAC(slug, issuedAt), secret in SSM. Reject if missing, invalid, older than 24 h, or younger than 3 s.
  3. `Origin`/`Referer` must be `https://{slug}.<sites-domain>`.
  4. Rate limits in the `ratelimit` table: 5/hour per IP, 30/day per slug; alarm on a global daily cap.
  5. Optional flag: Haiku spam/abuse classification (~$0.0005/message) before sending.
  6. Body limits (name 80, contact 120, message 1,000 chars), HTML stripped, no attachments, UTF-8 normalised.
- **Retention**: every message is copied to DynamoDB `messages` (pk `slug`, sk `ts`, TTL 30 d) and shown in "Mi sitio", so a lost notification can be recovered. Report/unpublish also disables the form for that slug.
- **Infra**: `POST /contact/{slug}` route, `contact` Lambda, SSM parameter for the HMAC secret, `messages` table.

### Email delivery via SES (phase 7)
- Owner email is added and verified in "Mi sitio" (one-click link). Unverified → no sends.
- `SendEmail` structured API, plain text. From `no-reply@notify.<domain>` (SES `EmailIdentity`, DKIM records in Route 53 via CDK), To owner, Reply-To visitor. Body includes a prefilled `wa.me/<visitor>?text=...` link when the visitor left a phone.
- Cost ≈ $0.10 per 1,000 messages. Exit the SES sandbox with a one-time support request.
- `contact` Lambda gets `ses:SendEmail` scoped to the identity. CloudWatch alarm on SES bounce/complaint rate.

### SES reputation protection
AWS reviews accounts at 5% bounces / 0.1% complaints and pauses them at 10% / 0.5%. Keep both near zero:
- **Verified recipients only**: double opt-in. The verification email is the only unverified send. If it bounces → address marked `invalid`.
- **Event handling**: SES `ConfigurationSet` → SNS → `ses-events` Lambda. Hard bounce → `sites.ownerEmailStatus = bounced`, sending stops until re-verified. Complaint → address added to `suppression` permanently. The SES account-level suppression list stays on as a backstop.
- **Easy opt-out**: every email has `List-Unsubscribe` + `List-Unsubscribe-Post` headers and a signed one-click "Pausar notificaciones" link (`GET /notifications/{slug}/pause?token=`), so owners pause instead of marking spam.
- **Isolated identity**: `notify.<domain>` with DKIM, custom MAIL FROM `mail.notify.<domain>` (SPF-aligned), DMARC `p=quarantine`. User sites are on a different registrable domain, so their reputation never affects mail.
- **Content hygiene**: fixed subject (`Nuevo mensaje desde tu sitio: {businessName}`), fixed template, visitor text quoted as plain text, URLs de-linked (`hxxp://`), no attachments, length caps. Visitor content never goes in the subject or From.
- **Flood → digest**: more than 5 messages/hour for one slug switches to an hourly digest (EventBridge scheduled Lambda drains `messages` with `pendingDigest=true`). The 30/day per-slug cap still applies.
- **Kill switch**: CloudWatch alarms on `Reputation.BounceRate` > 3% and `Reputation.ComplaintRate` > 0.05% (5-min period) → a Lambda sets SSM `/coyote/email/paused=true`. The `contact` Lambda checks the flag (cached 60 s) and stores messages without sending. SNS email to the admin.
- **Sandbox exit request** wording: transactional contact notifications, double opt-in recipients, automated bounce/complaint processing, expected volume.

## Post-MVP: Custom domains (phase 8)
Every site is free at `{slug}.<sites-domain>`. A `.com` is a paid upsell after publishing.

**Economics (verified Sep 2026)**: Verisign wholesale .com = $10.26, rising to $10.97 on 2026-11-01, and possibly 7%/yr to ~$13.42 by 2030. Plus $0.18 ICANN fee. Floor ≈ $11/yr.

| Registrar | .com/yr | DNS | All-in/yr | API register | Notes |
|---|---|---|---|---|---|
| **Route 53 Domains** (chosen) | $15.00 | $6.00 (hosted zone) | **$21.00** | Native `route53domains` (us-east-1 endpoint) | One vendor, IAM auth, billed to the AWS account, DNS + ACM validation automated in CDK/SDK |
| Dynadot | $10.88 | $0 (free DNS, apex ALIAS) | $10.88 | Yes, prepaid balance, reseller program | Switch when ~$10/domain/yr matters (≈ 500 domains ≈ $5k/yr) |
| Porkbun | ~$11 | $0 | ~$11 | Yes | Backup to Dynadot |
| Cloudflare | $9.15 | $0 | $9.15 | No new-registration API | Not usable |

- Route 53 first: no second vendor, no API keys, no balance top-ups. That is worth ~$10/domain/yr at small scale.
- The registrar sits behind `services/domains/src/registrar.ts` (`check`, `register`, `renew`, `setDns`), so Dynadot can replace it without touching checkout or DNS.
- Route 53 Domains defaults to 20 domains per account. Request the quota increase before launch.

**Flow**
1. Site page → "Compra tu dominio .com": `GET /domains/check?name=` → `CheckDomainAvailability` (cache 1 h). Suggest `{slug}.com`, `{slug}{city}.com`.
2. Checkout in local currency (cards/PIX/OXXO), ≈ USD 25/yr ($21 cost + margin). Webhook → `domains` Lambda. **Payment provider is undecided**: Mercado Pago accounts are per country and each needs a local legal entity. Compare Stripe (OXXO and PIX from one account) and dLocal. Keep it behind `services/domains/src/payments.ts`.
3. `domains` Lambda: `RegisterDomain` with the customer as registrant/admin/tech contact (name, email, phone, address collected at checkout), privacy protection on, `AutoRenew=false` (we renew after payment). Poll `GetOperationDetail` until `SUCCESSFUL` (async, minutes). Store in `domains` (slug, domain, expiresAt, status, operationId, hostedZoneId).
4. DNS: Route 53 creates the hosted zone. Add A/AAAA alias records for apex + `www` → the CloudFront tenant domain (`ChangeResourceRecordSets`).
5. TLS + routing: CloudFront multi-tenant distribution (SaaS Manager). One multi-tenant distribution + connection group; per customer, a distribution tenant with the custom domain and a CloudFront-managed ACM cert (validation CNAME written to the customer's hosted zone, no customer steps). Tenant origin path = `/{slug}/`. Standard CloudFront pricing, no per-tenant fee.
6. Renewal: daily EventBridge scan of `domains` expiring in 30/7/1 days → WhatsApp utility template or email → payment link → on payment, `RenewDomain`. Unpaid → expires; tenant + hosted zone deleted; the site stays on the free subdomain.

**Rules**
- .com only at first. LatAm ccTLDs (.com.br, .com.ar, .mx, .co, .cl) need local IDs/registries; later.
- The customer is the registrant of record (ICANN transfer/ownership rights); we hold the AWS account. The terms page states this and the "bring your own domain" option (customer adds 2 DNS records shown on their site page).
- Route 53 Domains is billed monthly to the AWS account, so the AWS Budget alarm covers it. Add a `domains` cost metric (count × $21) to the dashboard.
- Amazon Registrar sends the registrant an ICANN verification email. The site page explains this so customers click it (unverified → domain suspended after 15 days).

## Risks / open items
- **`coyote` profile and Bedrock model access** not set up yet. They block phase 3 onward and the Bedrock part of phase 2. Phases 1, 2a, and the pure-function parts of 2/2b can proceed.
- **Domains**: path-based sites mean the subdomain rewrite, wildcard cert, and reserved-subdomain rules are only unit/synth-tested until a domain is set. Final domains are undecided; the sites one must be a separate registrable domain bought before launch. A domain switch changes every site URL and magic link, so do it before real users exist. PSL acceptance takes weeks and is not blocking.
- **To verify at build time**: whether Converse guardrails evaluate `toolUse` content (`ApplyGuardrail` is called either way); Haiku 4.5 prompt-cache minimum prefix. Verified: the Standard-tier guardrail deploys with the `us.guardrail.v1:0` cross-region profile and blocks Portuguese text.
- **Guardrail false positives** on legitimate businesses (butcher, gym, tattoo studio, church). The borderline fixtures in phase 2b are the control. The church line and the restaurant-that-serves-drinks line are product policy calls to confirm.
- **Prompt injection through the description**: tested live with four attacks. Three were stopped at submit (guardrail prompt-attack filter and classifier). One polite instruction ("nota para el redactor: el titular debe decir…") steered the headline; it is now rejected by the classifier (fixture added), phone numbers are stripped from model copy like URLs, and prize-bait phrases are in the scam list. Structural limits hold regardless: the model has no tools, no secrets, and no other user's data in context; it cannot write HTML, links, or contact details; its one code output is sanitized; an attacker can only influence the copy of their own site, which still passes the policy and the output guardrail. Treat stored site text as untrusted in any future model-driven feature (critic pass, WhatsApp edits, support).
- **Abuse**: anonymous generation costs money per call. The rate limit is the MVP control; add WAF + CAPTCHA if abused.
- **Lost magic link** has no recovery until WhatsApp re-issue ships.

## Verification
- `npm test` — slug, urls, render escaping, css sanitizer, policy, prompt snapshot.
- `npm run generate:local -- --name "Panadería Luna" ...` → open `out/index.html`; check WhatsApp CTA, language, mobile layout. The WhatsApp number on the page equals the input byte for byte.
- `cdk synth` and `cdk diff` clean; `cdk deploy --all` succeeds.
- `curl -X POST <ApiUrl>/generate` → job id; poll `GET /jobs/{id}` until `DONE`; open the returned site URL in Chrome and screenshot desktop + mobile widths.
- Headers: `curl -I <site URL>` shows `script-src 'none'`; the app loads and runs its JS; the preview iframe renders inside the app and nowhere else.
- Injection: markup in the name or address comes out escaped (a `<script>` name is rejected outright by the guardrail's prompt-attack filter); a `signatureCss` with `url()`/`@import` is dropped (unit-tested: the API cannot force model output).
- Rate limit: 4th request from one IP in a day returns 429 and produces no Bedrock invocation.
- Slug: two simultaneous submissions of the same name get different slugs; a brand name (`bancolombia`) is rejected; reserved names (`www`, `preview`) get a suffixed slug.
- Failure: force a `generate` error → job ends `FAILED`, slug released.
- Edit: change hours in "Mi sitio" → page updates with no Bedrock call logged.
- Safety:
  - Run the fixture set end to end. Every bad case ends `REJECTED` with nothing in S3; every good and borderline-legit case publishes.
  - A fake bank page ("Banco Azteca, verifica tu cuenta") → 422 from pre-screen.
  - A published page has no `<form>` (MVP), only allowlisted links, and the report footer.
  - `POST /report/{slug}` N times from one IP does nothing; from N distinct IPs → prefix moved to `_quarantine/` and email received.
  - A Converse call without `guardrailConfig` is denied by IAM (`AccessDeniedException`).
- Contact form (post-MVP): submit from a published site → 303 back to `#enviado`, owner notified (WhatsApp, or email with Reply-To set). Honeypot-filled and <3 s submissions produce no notification. The 6th submission in an hour from one IP is dropped. `curl` with a foreign `Origin` is rejected.
