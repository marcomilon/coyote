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
| `npm run build` | Type-check every workspace |
| `npm test` | Run unit tests (vitest) |
| `npm run synth` | `cdk synth` for `dev`; needs no credentials |
| `npm run diff:dev` | `cdk diff` against the deployed `dev` stack |
| `npm run deploy:dev` | Deploy `dev` with `--profile coyote`; writes `infra/cdk-outputs.dev.json` |
| `npm run dev` | Serve `web/` on http://localhost:5173 against the deployed `dev` API |

## Layout
- `infra/` — CDK app (`Coyote-dev`, `Coyote-prod`)
- `services/generator/` — Lambda code, themes, local scripts
- `web/` — our frontend (Astro from Phase 5): landing, form, "Mi sitio", legal pages
