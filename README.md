# Coyote

AI website generator for LatAm small businesses. Three questions in, a published single-page site out.

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
- `services/generator/` — Lambda code, themes, local scripts
- `web/` — our frontend (Astro from Phase 5): landing, form, "Mi sitio", legal pages

## Runbook

All commands use the AWS profile `coyote` (override with `COYOTE_AWS_PROFILE`).

| I want to… | Do this |
|---|---|
| Deploy | `./coyote.sh deploy`. It builds the frontend, checks that every Lambda bundle loads, then runs `cdk deploy`. |
| Get alert emails | `./coyote.sh subscribe-alerts you@example.com`. AWS sends one confirmation email per topic. **Do not click** "Confirm subscription": copy its link address and run `./coyote.sh confirm-alerts '<link>'`. Confirming through the API disables the no-login unsubscribe link, which mail scanners otherwise follow, silently removing the subscription. `./coyote.sh protect-alerts` fixes subscriptions that were confirmed by clicking. |
| See what is happening | CloudWatch dashboard **Coyote** (requests, rejections, tokens, API errors). |
| Investigate an alarm | `./coyote.sh abuse-report`: requests per visitor (hashed IP), rejections with the layer that stopped them, and the newest published sites. Open the new sites and look at them. |
| Take a site down for good | `./coyote.sh unpublish <slug>`. Deletes the pages and blocklists the slug. |
| Bring back a quarantined site | `./coyote.sh restore <slug>`. Three distinct visitors reporting a site quarantine it automatically; each report emails the admin. |
| Re-render every site | `./coyote.sh rerender-all`, after changing a theme, the renderer, or the domains. |
| Change the model | Edit `DEFAULT_MODEL_ID` in `services/generator/src/core/models.ts` (or deploy with `-c modelId=…`), then deploy. The IAM permission follows it. |
| Check Bedrock quota or throttling | Service Quotas → Amazon Bedrock, and the `GenerationFailures` alarm. |
| Remove everything | `cd infra && npx cdk destroy --profile coyote`. This account is a sandbox: all data is deleted. |

### Alarms
`PublishRate` (>20 sites/h), `RateLimited` (>20/h), `Rejected` (>15/h, someone probing), `GenerationFailures` (>3/h), `Quarantined` (any), `TokensPerDay` (>2M), `GenerateErrors`, `Api5xx`, `Api4xx`. Plus an AWS Budget of $20/month (alerts at 80% and 100%) and Cost Anomaly Detection (≥ $5 impact).
