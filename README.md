# Coyote

AI website generator for LatAm small businesses. Three questions in (plus a few follow-ups when needed), a single-page site out.

Design and progress live in [`PLAN.md`](PLAN.md) (MVP) and [`PLAN-PHASE2.md`](PLAN-PHASE2.md) (WhatsApp).

## Requirements
- Node 22+ (24 locally)
- AWS CLI profile `coyote` (us-east-1). Only needed to deploy and to call Bedrock.

## Commands
| Command | What it does |
|---|---|
| `npm install` | Install all workspaces |
| `npm run build` | Type-check every workspace and build the frontend into `web/dist` |
| `npm test` | Run unit tests (vitest) |
| `npm run synth` | `cdk synth`; needs no credentials |
| `npm run diff` | `cdk diff` against the deployed stack |
| `./coyote.sh deploy` | Deploy the `Coyote` stack with the `coyote` profile; writes `infra/cdk-outputs.json`. `npm run deploy` is an alias |
| `./coyote.sh help` | List the project commands |
| `npm run dev` | `astro dev` for `web/` on http://localhost:5173 against the deployed API (stop: `npx astro dev stop` in `web/`) |

## Layout
- `infra/` — CDK app, one stack (`Coyote`)
- `services/generator/` — Lambda code and local scripts
- `web/` — our frontend (Astro from Phase 5): landing, form, "Mi sitio", legal pages

## Runbook

All commands use the AWS profile `coyote` (override with `COYOTE_AWS_PROFILE`).

| I want to… | Do this |
|---|---|
| Deploy | `./coyote.sh deploy`. It builds the frontend, checks that every Lambda bundle loads, then runs `cdk deploy`. |
| Send email ("Mis sitios", "your site is ready") | Set `senderEmail` in the `context` of `infra/cdk.json` (or pass `-c senderEmail=you@example.com` on every deploy: a deploy without it removes the sender). SES emails that address a verification link: click it. While SES is in the sandbox, verify each test recipient too: `aws sesv2 create-email-identity --email-identity them@example.com --profile coyote`. |
| Get alert emails | `./coyote.sh subscribe-alerts you@example.com`. AWS sends one confirmation email per topic. **Do not click** "Confirm subscription": copy its link address and run `./coyote.sh confirm-alerts '<link>'`. Confirming through the API disables the no-login unsubscribe link, which mail scanners otherwise follow, silently removing the subscription. `./coyote.sh protect-alerts` fixes subscriptions that were confirmed by clicking. |
| See what is happening | CloudWatch dashboard **Coyote** (requests, rejections, tokens, API errors). |
| Investigate an alarm | `./coyote.sh abuse-report`: requests per visitor (hashed IP), rejections with the layer that stopped them, and the newest drafts. Open them and look at them. |
| Take a site down for good | `./coyote.sh unpublish <slug>`. Deletes the pages and blocklists the slug. |
| Bring back a quarantined site | `./coyote.sh restore <slug>`. Three distinct visitors reporting a site quarantine it automatically; each report emails the admin. |
| See how the stack is set up | `./coyote.sh status`: stack state, URLs, the page writer's model, skill (and the ones available), look nudge, and the Bedrock models. |
| Switch the page writer | `./coyote.sh page-model haiku` while testing the workflow (cheap, plain designs), `./coyote.sh page-model opus` for real designs, `./coyote.sh page-model` to see which is on. Applies to the whole stack from the next job and survives deploys. |
| Experiment with the page writer's skill | `./coyote.sh page-skill` shows the active skill and the available ones. `./coyote.sh page-skill add hallmark ~/.claude/skills/hallmark/SKILL.md` uploads one (or replaces it); `./coyote.sh page-skill hallmark` switches to it, `./coyote.sh page-skill none` turns the skill off, `./coyote.sh page-skill frontend-design` goes back. For traditional, photo-led pages: `./coyote.sh page-skill add classic services/generator/skills/classic/SKILL.md`, then `page-skill classic` with `page-look off` (its tones fight the skill). No deploy; applies from the next job and survives deploys. Only SKILL.md is sent, not the skill's other files. The generate log names the model and skill of each job. To compare skills without touching the stack, see "Compare page writer settings". |
| Turn the look nudge off | `./coyote.sh page-look off` sends new-site requests without the 3 random tones / light-or-dark / no-ticker sentence; `on` brings it back, no argument shows it. No deploy; from the next job. Locally: `opus:sites -- --look off`. |
| Stop made photos | `./coyote.sh page-images off` stops the page writer's photos for every site, even when the owner left "Fotos creadas con IA" on; `on` brings them back, no argument shows it. No deploy; from the next job. Locally: `opus:sites -- --images on,off`. |
| Compare page writer settings | `npm run opus:sites -w services/generator -- --only <example> --skills none,frontend-design,hallmark --look on,off` writes every combination for the businesses in `examples/<id>.json` (or the bake-off list) with production's request and page checks, and a gallery at `out/design/<run>/index.html` (cost, time, tokens, check result per page). `--repeat`, `--model haiku` (cheap dry run), `--effort`. About $0.50 a page on Opus; nothing on the stack changes. |
| Re-render every site | `./coyote.sh refill-all`, after changing the page checks or the domains. Finishes each site's current draft again from its stored page, with no model call. |
| Change the model | Edit `DEFAULT_MODEL_ID` (content writer) or `DEFAULT_PRESCREEN_MODEL_ID` in `services/generator/src/core/models.ts` (or deploy with `-c modelId=…` / `-c prescreenModelId=…`), then deploy. The IAM permissions follow them. |
| Check Bedrock quota or throttling | Service Quotas → Amazon Bedrock, and the `GenerationFailures` alarm. |
| Stop paying anything while away | `./coyote.sh destroy`. Deletes the whole stack and all its data after you type `destroy <account id>`. `./coyote.sh deploy` brings back a fresh stack with new URLs; then run `subscribe-alerts` again. |

### Alarms
`DraftRate` (>20 generated sites/h), `RateLimited` (>20/h), `Rejected` (>15/h, someone probing), `GenerationFailures` (>3/h), `Quarantined` (any), `TokensPerDay` (>2M), `GenerateErrors`, `Api5xx`, `Api4xx`. Plus an AWS Budget of $20/month (alerts at 80% and 100%) and Cost Anomaly Detection (≥ $5 impact).
