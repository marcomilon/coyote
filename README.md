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
| `npm run synth` | `cdk synth`; needs no credentials |
| `npm run diff` | `cdk diff` against the deployed stack |
| `./coyote.sh deploy` | Deploy the `Coyote` stack with the `coyote` profile; writes `infra/cdk-outputs.json`. `npm run deploy` is an alias |
| `./coyote.sh help` | List the project commands |
| `npm run dev` | Serve `web/` on http://localhost:5173 against the deployed API |

## Layout
- `infra/` — CDK app, one stack (`Coyote`)
- `services/generator/` — Lambda code, themes, local scripts
- `web/` — our frontend (Astro from Phase 5): landing, form, "Mi sitio", legal pages
