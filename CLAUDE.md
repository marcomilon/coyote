# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
Coyote generates single-page static websites for LatAm small businesses from a 3-question form (es/pt), hosted entirely on AWS. The repo is at the start of the build: most of the design exists only in the plans.

**`PLAN.md` (MVP) and `PLAN-PHASE2.md` (WhatsApp front door) are the source of truth** for architecture, decisions, and progress. Read the relevant section before building anything. "Implementation phases" is a checkbox tracker: tick `[x]` only when the item is done and its check passed; 👤 items need the user. If an implementation deviates from the plan, update the plan in the same change. Keep plan wording plain and short, and don't record when decisions were made.

## Commands
```
npm install            # all workspaces
npm run build          # type-check every workspace (tsc --noEmit; nothing is emitted, esbuild bundles Lambdas at synth)
npm test               # vitest run
npx vitest run infra/test/stack.test.ts     # one file
npx vitest run -t "domainless"              # by test name
npm run synth          # cdk synth; must work with no AWS credentials
npm run diff           # cdk diff against the deployed stack (--profile coyote)
./coyote.sh deploy     # cdk deploy Coyote (--profile coyote); writes infra/cdk-outputs.json
npm run dev            # serve web/ on :5173 against the DEPLOYED API (becomes `astro dev` in Phase 5)
```
`coyote.sh` (repo root) is the home for project commands; add new operational commands there as `cmd_<name>` functions rather than as loose scripts.

Tests live in `infra/test/` and `services/*/test/` (see `vitest.config.ts`). There is no linter configured.

## AWS
- Always use the CLI profile **`coyote`** (account 887799775985, us-east-1): `--profile coyote` for `aws`/`cdk`, `AWS_PROFILE=coyote` for local scripts. Never fall back to the default profile. CI uses a GitHub OIDC role instead.
- Everything is in us-east-1, in one CDK stack, `Coyote`. There is one environment and no dev/prod split: this account is a disposable sandbox (localhost may call the API, `cdk destroy` deletes all data). A production environment, if ever needed, is a separate AWS account running the same stack; do not add environment names or flags before then.
- All AWS resources are created through CDK. No console or CLI-created resources except the one-offs the plan marks 👤.
- Bedrock model: the default lives only in `services/generator/src/core/models.ts` (currently Amazon Nova 2 Lite); `BEDROCK_MODEL_ID` overrides it. Never hardcode a model ID anywhere else. Claude (Haiku 4.5) is the planned switch once the pipeline is stable; the user decides when.

## Architecture (big picture)
- **Flow**: `web/` form → API Gateway → `submit` Lambda (rate limit → pre-screen classifier → atomic slug claim) → async `generate` Lambda (design brief → content JSON → lint/policy/guardrail → render → S3) → browser polls `GET /jobs/{id}`.
- **The model writes structured content JSON, never HTML.** A deterministic renderer fills hand-built themes and escapes every value. Contact details are copied from user input, never from model output. Edits patch the stored content and re-render with no model call. The only model-written code is an optional, parser-sanitized `signatureCss`.
- **Two CloudFront distributions**: the app (JS allowed) and user sites (`script-src 'none'`). They cannot be merged: CloudFront picks the response-headers policy before the Host-rewrite function runs.
- **Domain modes**, selected by CDK context `domainName` + `sitesDomainName` (both or neither; the stack throws otherwise):
  - *Domainless* (current): no ACM/Route 53; sites are path-based at `<sites-dist>.cloudfront.net/{slug}/`.
  - *Domain mode*: sites at `{slug}.<sites-domain>`, a separate registrable domain from the brand domain.
  - Switching must stay a config change + redeploy + re-render. So: **no domain literal anywhere in code, themes, or tests**; `urls.ts` is the only module that knows the mode (CSP, CORS, Origin checks derive from it); themes use relative asset URLs.
- **Local development has no mock backend.** `npm run dev` serves only the static frontend; the API, Lambdas, and generated sites are the deployed stack, which allows `http://localhost:5173` in CORS and in the sites' `frame-ancestors`.
- **Safety is four independent layers** (Bedrock Guardrail incl. explicit `ApplyGuardrail` on output text, pre-screen classifier, `policy.ts` checks on content + rendered HTML, post-publication reports/quarantine). The rate limit runs before any Bedrock call.
- MVP sites carry only a WhatsApp CTA. The contact form, SES email, WhatsApp flows, and custom domains are post-MVP and specified in the plans.

## Conventions
- Our frontend (`web/`) is Astro, built to static files; interactive parts are plain TypeScript in Astro scripts, and the API URL comes from a runtime `config.js`. Generated business sites are never Astro: `render.ts` builds them in Lambda.
- ESM TypeScript everywhere, `moduleResolution: "Bundler"`, extensionless relative imports. The CDK app runs through `tsx` (`infra/cdk.json`).
- `npm run synth` and unit tests must keep passing without AWS credentials (no `fromLookup` in domainless mode).
- User-facing copy is Spanish (es-419) first, with Portuguese (pt-BR).
