# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
Coyote generates single-page static websites for LatAm small businesses from a 3-question form (es/pt), hosted entirely on AWS. The repo is at the start of the build: most of the design exists only in the plans.

**`PLAN.md` (MVP) and `PLAN-PHASE2.md` (WhatsApp front door) are the source of truth** for architecture, decisions, and progress. Read the relevant section before building anything. "Implementation phases" is a checkbox tracker: tick `[x]` only when the item is done and its check passed; 👤 items need the user. If an implementation deviates from the plan, update the plan in the same change. Keep plan wording plain and short, and don't record when decisions were made.

## Commands
```
npm install            # all workspaces
npm run build          # type-check every workspace and build web/dist (synth and the stack tests need web/dist or a webDist prop)
npm test               # vitest run
npx vitest run infra/test/stack.test.ts     # one file
npx vitest run -t "domainless"              # by test name
npm run synth          # cdk synth; must work with no AWS credentials
npm run diff           # cdk diff against the deployed stack (--profile coyote)
./coyote.sh status     # the deployed stack at a glance: URLs, page model/skill/look switches, Bedrock models
./coyote.sh deploy     # builds web, checks Lambda bundles, cdk deploy (--profile coyote); writes infra/cdk-outputs.json
./coyote.sh destroy    # deletes the stack and ALL data (asks for typed confirmation). Never run it without the user asking
./coyote.sh abuse-report | unpublish <slug> | restore <slug> | refill-all | free-draft <email> | usage <email> | add-designs <email> <n>   # admin commands (see README runbook)
./coyote.sh page-mode [design|template]   # show or switch how pages are made: Opus writes each page, or Haiku fills a template Opus designed (no deploy)
./coyote.sh page-templates [add <id> <file> "<description>" | rm <id>]   # the template library (services/generator/templates/), checked and uploaded
npm run templates:make -w services/generator -- --count 5   # Opus designs templates, Haiku fills example businesses; gallery in out/templates/<run>/ (real calls)
./coyote.sh page-model [opus|haiku]   # show or switch the page writer for the whole stack (haiku: cheap, for testing the workflow)
./coyote.sh page-skill [<name>|none] | page-skill add <name> <SKILL.md>   # show, switch, or add the page writer's skill (no deploy)
./coyote.sh page-look [on|off]   # show or switch the look nudge on new pages (no deploy)
./coyote.sh page-images [on|off]   # show or switch made photos for everyone (owners choose per site on the form; no deploy)
./coyote.sh domain-register [on|off]   # show or switch domain registration in Mi sitio → Dominio (Coyote pays from the Porkbun balance; no deploy)
./coyote.sh captcha [on|off]   # show or switch the Turnstile CAPTCHA on the create, sign-in link and report forms (no deploy)
./coyote.sh email [on|off]   # show or switch sending email; the SES bounce/complaint rate alarms turn it off (no deploy)
./coyote.sh domains    # the domains owners registered
./coyote.sh view <slug>   # copy a site's current draft to out/view/<slug>/ and open it
./coyote.sh example-page <page-dir> <slug>   # make an opus:sites page a landing example (examples/sites/<slug>/; then deploy)
npm run dev            # astro dev for web/ on :5173 against the DEPLOYED API. Runs in the background; stop with `npx astro dev stop` in web/
```
`coyote.sh` (repo root) is the home for project commands; add new operational commands there as `cmd_<name>` functions rather than as loose scripts.

Tests live in `infra/test/` and `services/*/test/` (see `vitest.config.ts`). There is no linter configured.

## AWS
- Always use the CLI profile **`coyote`** (account 887799775985, us-east-1): `--profile coyote` for `aws`/`cdk`, `AWS_PROFILE=coyote` for local scripts. Never fall back to the default profile. CI uses a GitHub OIDC role instead.
- Everything is in us-east-1, in one CDK stack, `Coyote`. There is one environment and no dev/prod split: this account is a disposable sandbox (localhost may call the API, `cdk destroy` deletes all data). A production environment, if ever needed, is a separate AWS account running the same stack; do not add environment names or flags before then.
- All AWS resources are created through CDK. No console or CLI-created resources except the one-offs the plan marks 👤.
- Models: the page writer is Claude Opus 5.5 through Anthropic's API (`page-writer.ts`, `PAGE_MODEL` / `PAGE_EFFORT` override). `./coyote.sh page-model haiku` switches it to Claude Haiku 4.5 for cheap workflow testing (SSM `/coyote/page-model`, read per job), because the Bedrock account refuses Opus 5.5. The Bedrock defaults live only in `services/generator/src/core/models.ts`: Claude Haiku 4.5 asks the follow-up questions (`BEDROCK_MODEL_ID`), Amazon Nova 2 Lite runs the pre-screen (`PRESCREEN_MODEL_ID`), Stable Image Core in us-west-2 makes the page writer's photos (`IMAGE_MODEL_ID`). Never hardcode a model ID anywhere else. Every model has a tier in `MODELS` there: `paid` (Opus, photos: a page write uses the free draft, and later a design credit) or `free` (Haiku, Nova). A new model needs a tier, and the tests and synth check this. The user decides model changes and tiers.

## Architecture (big picture)
- **Flow**: `web/` form → API Gateway → `submit` Lambda (rate limit → pre-screen classifier → atomic slug claim) → async `generate` Lambda: `plan_site` (may ask the owner up to 4 questions → `NEEDS_INPUT` → `POST /jobs/{id}/answers`) → Opus writes the page → page checks + guardrail → private draft in S3 → browser polls `GET /jobs/{id}` and, once, gets the magic link, then goes straight to Mi sitio. Nothing is published yet.
- **Opus 5.5 writes each page** (`page-writer.ts`: Anthropic's API with the user's key in Secrets Manager `coyote/anthropic-api-key`, the frontend-design skill as the system prompt, a chat-like request). Don't add rules to that prompt: they made the designs worse. Safety is checks on the finished page (`page-check.ts`: repair links, scripts, images; reject redirects, contact details the owner never gave, policy text). No fallback: if it fails, the job fails. Opus uses the owner's uploads, makes photos through the `make_image` tool when the owner left the form's "Fotos creadas con IA" on and `page-images` is on (`images.ts`: guardrail on the scene, Rekognition on the photo, Haiku checks the hands (`hands.ts`), at most 4) instead of drawing SVG illustrations (a refused photo is left out), and otherwise draws its images as SVG. The page writer and the chat get the owner's real contact details; contact details come from user input (numbers and emails the owner wrote elsewhere are allowed on the page too), the page checks reject any other number or email, and contact edits swap them into the page with no model call.
- **Template mode** (`./coyote.sh page-mode template`): instead of Opus per page, Haiku on Bedrock picks one of the Opus-designed templates and writes the words for its slots (`template-writer.ts`); `template.ts` fills them in with the contact links, photos and head from our code. Same page checks; the draft record keeps the template and its words for redesigns.
- **Two CloudFront distributions**: the app (JS allowed) and user sites (inline scripts and a few CDNs listed in `page-check.ts`, no network access). They cannot be merged: CloudFront picks the response-headers policy before the Host-rewrite function runs.
- **Domain modes**, selected by CDK context `domainName`:
  - *Domainless*: no ACM/Route 53; drafts and examples are path-based on `<sites-dist>.cloudfront.net`.
  - *Domain mode* (current, `ventas314.com`): app at `www.<domain>` (the bare domain redirects there), API at `api.<domain>`, private drafts at `draft.<domain>`, our landing examples at `{slug}.<domain>`. Customer pages are never public on our domain: drafts load only inside the app, and owners publish only on their own domain.
  - Switching must stay a config change + redeploy + `refill-all`. So: **no domain literal anywhere in code, prompts, or tests**; `urls.ts` is the only module that knows the mode (CSP, CORS, Origin checks, footer links derive from it); pages use relative asset URLs.
- **Local development has no mock backend.** `npm run dev` serves only the static frontend; the API, Lambdas, and generated sites are the deployed stack, which allows `http://localhost:5173` in CORS and in the sites' `frame-ancestors`.
- **Bots**: Cloudflare Turnstile on the anonymous forms (create, sign-in link, report): the widget's token goes in the JSON body as `turnstileToken`, and the Lambda checks it before any count, model call or email (`core/captcha.ts`, `aws/turnstile.ts`). Switch `./coyote.sh captcha`; the secret is in Secrets Manager `coyote/turnstile`, the public site key is the CDK context `turnstileSiteKey`.
- **Safety is four independent layers** (Bedrock Guardrail incl. explicit `ApplyGuardrail` on output text, pre-screen classifier, `policy.ts` checks on content + rendered HTML, post-publication reports/quarantine). The rate limit runs before any Bedrock call.
- **Design packs**: when an email's 3 free designs are used, Mi sitio sells 3 more for USD 4.90 through Paddle (sandbox; `core/payments.ts`, `aws/paddle.ts`). The transaction is made on our server; Paddle's webhook adds the designs once per transaction (`paid-writes.ts`). Keys in Secrets Manager `coyote/paddle`; the client token and price id are CDK context `paddle`.
- **Owners' domains** (Mi sitio → Dominio, `core/domains.ts`): Porkbun is the registrar (`aws/porkbun.ts`, key in Secrets Manager `coyote/porkbun-api`, free DNS). The owner is the registrant; registering works only while `./coyote.sh domain-register` is on. The tab is hidden with CSS until the flow is finished, unless `PUBLIC_DOMAIN_TAB=on` at build/dev time (e.g. in `web/.env.development.local`, which only `npm run dev` reads). Connecting a domain to its site waits for publishing.
- MVP sites carry only WhatsApp and call buttons (one number, "Teléfono" on the form). The contact form, SES email, WhatsApp flows, and custom domains are post-MVP and specified in the plans.

## Git
- Never commit (or push) unless the user explicitly asks for it in that message. Leave changes uncommitted and say so.

## Conventions
- The page writer's prompt is the frontend-design skill (`frontend-design.ts`, verbatim) plus the chat-like request in `pagePrompt()`. For experiments the skill is switchable at runtime (`./coyote.sh page-skill`: SSM `/coyote/page-skill` + the skills bucket; `none` turns it off); frontend-design stays the default. Keep the request plain; put safety in `page-check.ts`, not in the prompt. To try a change, `npm run opus:sites -w services/generator -- --skills … --look on,off` (real Opus calls, about $0.50 a page; business examples in `examples/*.json`) and open `out/design/<run>/index.html`.
- Our frontend (`web/`) is Astro, built to static files; interactive parts are plain TypeScript in Astro scripts, and the API URL comes from a runtime `config.js`. Generated business sites are never Astro: Opus writes them and `page-check.ts` finishes them in Lambda.
- ESM TypeScript everywhere, `moduleResolution: "Bundler"`, extensionless relative imports. The CDK app runs through `tsx` (`infra/cdk.json`).
- `npm run synth` and unit tests must keep passing without AWS credentials: domain mode's zone lookups are cached in `infra/cdk.context.json` (commit it after a lookup changes) and `account` in `cdk.json` stands in for the credentials.
- User-facing copy is Spanish (es-419, tú) first, with Portuguese (pt-BR). Argentina, Uruguay and Paraguay get vos: add the vos wording of any new Spanish string with tú forms to `esVos` in `strings.ts` (the strings test fails otherwise), and new Spanish pages need their twin under `web/src/pages/vos/`.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance

- Where these AWS rules conflict with the project's own instructions, the
  project's instructions take precedence.
- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.
<!-- END AWS Agent Toolkit rules -->
