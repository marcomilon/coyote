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
./coyote.sh deploy     # builds web, checks Lambda bundles, cdk deploy (--profile coyote); writes infra/cdk-outputs.json
./coyote.sh destroy    # deletes the stack and ALL data (asks for typed confirmation). Never run it without the user asking
./coyote.sh abuse-report | unpublish <slug> | restore <slug> | refill-all   # admin commands (see README runbook)
npm run dev            # astro dev for web/ on :5173 against the DEPLOYED API. Runs in the background; stop with `npx astro dev stop` in web/
```
`coyote.sh` (repo root) is the home for project commands; add new operational commands there as `cmd_<name>` functions rather than as loose scripts.

Tests live in `infra/test/` and `services/*/test/` (see `vitest.config.ts`). There is no linter configured.

## AWS
- Always use the CLI profile **`coyote`** (account 887799775985, us-east-1): `--profile coyote` for `aws`/`cdk`, `AWS_PROFILE=coyote` for local scripts. Never fall back to the default profile. CI uses a GitHub OIDC role instead.
- Everything is in us-east-1, in one CDK stack, `Coyote`. There is one environment and no dev/prod split: this account is a disposable sandbox (localhost may call the API, `cdk destroy` deletes all data). A production environment, if ever needed, is a separate AWS account running the same stack; do not add environment names or flags before then.
- All AWS resources are created through CDK. No console or CLI-created resources except the one-offs the plan marks 👤.
- Bedrock models: the defaults live only in `services/generator/src/core/models.ts`: Claude Opus 5.5 writes the sites (`BEDROCK_MODEL_ID` overrides it), Amazon Nova 2 Lite runs the pre-screen (`PRESCREEN_MODEL_ID`). Never hardcode a model ID anywhere else. The user decides model changes.

## Architecture (big picture)
- **Flow** (`PLAN-MODEL-SITES.md`): `web/` form → API Gateway → `submit` Lambda (rate limit → pre-screen classifier → atomic slug claim) → async `generate` Lambda: `plan_site` (may ask the owner up to 4 questions → `NEEDS_INPUT` → `POST /jobs/{id}/answers`) → `write_site` → sanitizer + text checks + guardrail → fill → private draft in S3 → browser polls `GET /jobs/{id}` and gets the draft URL and, once, the magic link. Nothing is published yet.
- **The model writes the whole page (HTML + CSS), never contact details.** `sanitize.ts` rebuilds it from an allowlist (scripts only inline or from the CDN list, images any `https:`; no forms, iframes, outside links, or hidden text) and extracts the visible text for `policy.ts` and the guardrail. Contact details and images appear only as placeholders (`{{whatsapp_url}}`…) that `fill.ts` fills from what the owner typed, escaped; a placeholder with no value removes its element. `fill.ts` also adds the Google map and the platform footer. The unfilled source is stored, so contact edits and domain switches refill with no model call; free-text edits go through `edit_site` and the same checks.
- **Two CloudFront distributions**: the app (`script-src 'self'`) and user sites (model-written scripts from the CDN list in `core/cdn.ts`, no network calls: `default-src 'none'`). They cannot be merged: CloudFront picks the response-headers policy before the Host-rewrite function runs.
- **Domain modes**, selected by CDK context `domainName` + `sitesDomainName` (both or neither; the stack throws otherwise):
  - *Domainless* (current): no ACM/Route 53; sites are path-based at `<sites-dist>.cloudfront.net/{slug}/`.
  - *Domain mode*: sites at `{slug}.<sites-domain>`, a separate registrable domain from the brand domain.
  - Switching must stay a config change + redeploy + `refill-all`. So: **no domain literal anywhere in code, prompts, or tests**; `urls.ts` is the only module that knows the mode (CSP, CORS, Origin checks, map URLs derive from it); pages use relative asset URLs.
- **Local development has no mock backend.** `npm run dev` serves only the static frontend; the API, Lambdas, and generated sites are the deployed stack, which allows `http://localhost:5173` in CORS and in the sites' `frame-ancestors`.
- **Safety is four independent layers** (Bedrock Guardrail incl. explicit `ApplyGuardrail` on output text, pre-screen classifier, `policy.ts` checks on content + rendered HTML, post-publication reports/quarantine). The rate limit runs before any Bedrock call.
- MVP sites carry only a WhatsApp CTA. The contact form, SES email, WhatsApp flows, and custom domains are post-MVP and specified in the plans.

## Git
- Never commit (or push) unless the user explicitly asks for it in that message. Leave changes uncommitted and say so.

## Conventions
- Site design comes from the design guide (`services/generator/prompts/design-guide.md`, first and stable in the `write_site`/`edit_site` system prompt so it is cached) and the prompts in `prompt.ts`. After any change to the guide, a prompt, the sanitizer, or `fill.ts`, run `npm run generate:local` (real model calls, costs money; `--only` for a few businesses) and look at the sheet it writes (`npm run sites:sheet` rebuilds it).
- Our frontend (`web/`) is Astro, built to static files; interactive parts are plain TypeScript in Astro scripts, and the API URL comes from a runtime `config.js`. Generated business sites are never Astro: `render.ts` builds them in Lambda.
- ESM TypeScript everywhere, `moduleResolution: "Bundler"`, extensionless relative imports. The CDK app runs through `tsx` (`infra/cdk.json`).
- `npm run synth` and unit tests must keep passing without AWS credentials (no `fromLookup` in domainless mode).
- User-facing copy is Spanish (es-419) first, with Portuguese (pt-BR).
