# Test plan: Meta Muse Spark 1.3 as the page writer

Goal: find out if Muse Spark 1.3 writes pages as good as Opus 5.5's for less money. Nothing in the stack changes until the test says yes and you decide.

## Why this model

- First on the Design Arena website leaderboard (1361, Opus 5.5 is 1334), so it may design at least as well as Opus.
- About 4x cheaper by list price: $1.25 / $4.25 per million tokens (Opus: $4 / $20). With Opus's token counts (18k in, 28k out) a page is about $0.14 against $0.64.
- It has what the page writer needs: image input (the owner's photos), tool calls (`make_image`), reasoning with an effort setting, 1M context, no practical output limit.
- Only through OpenRouter (`meta/muse-spark-1.3`), served by Meta itself. Not on Bedrock, not on the Anthropic API.

What we don't know yet: its token counts (it may think more or less than Opus), its Spanish and Portuguese, whether it follows the frontend-design skill, whether it makes up contact details, and how often Meta's moderation (`is_moderated: true`) refuses a normal business.

## What we build (bench only)

The bench (`npm run opus:sites`) gets a second client. `page-writer.ts` and the stack stay as they are.

1. **OpenRouter client** in `services/generator/src/core/openrouter.ts`: OpenAI-style chat completions at `https://openrouter.ai/api/v1/chat/completions`, streaming, `AbortSignal` with the page writer's deadline. It returns the same `{ text, stopReason, usage }` as `anthropicWritePage`, so `parsePage`, `checkPage` and the gallery work unchanged.
2. **Same request as Opus**: the skill as the system message, the owner's photos as `image_url` data URLs, each after its file name and caption, then `pagePrompt()`. `max_tokens` 64000. `reasoning: { effort }` from `--effort`.
3. **make_image loop**: the same tool as a function definition, at most 6 rounds, the same photo cap. One difference: OpenAI-style tool results are text only, so the made photo goes back in a user message right after the tool result ("Saved as assets/photo-1.jpg", then the image).
4. **Routing and privacy**: `provider: { only: ["Meta"], allow_fallbacks: false, data_collection: "deny" }`. Never the `muse-spark-1.3-contributor` tier (cheaper, but it is the tier for experimentation and our data may be used).
5. **Bench switch**: `--model openrouter:meta/muse-spark-1.3` picks the OpenRouter client. Usage comes from the response's `usage` (incl. reasoning tokens). The cost comes from a price in `models.ts` (`'meta/muse-spark-1.3': { input: 1.25, output: 4.25 }`).
6. **Key**: `OPENROUTER_API_KEY` in the environment for local runs. 👤 Create an OpenRouter account, add about $10 of credit, set a spending limit on the key.

Tests: a unit test for the request builder (system, photos, prompt, tool, provider settings) and the tool loop with a fake client, like the existing page-writer tests.

## Test runs

All with `--skills frontend-design --look on`, the 8 businesses in `examples/*.json`.

| Run | What | Pages | ≈ Cost |
|---|---|---|---|
| 1. Smoke | `colombia-arepas`, Muse only | 1 | $0.15 |
| 2. Main | 8 businesses × Muse and Opus, same look nudge per business | 16 | $1.20 + $5.10 |
| 3. Repeat | `--repeat 2` on Muse, to see if it varies | 8 more | $1.20 |
| 4. Photos | `--images on` and owner photos (the examples with `photos`) on Muse | 4 | $0.60 + $0.16 photos |
| 5. Effort | 2 businesses at `--effort medium` and `low` | 4 | $0.40 |

Total about $9, most of it the Opus side of run 2. If run 1 fails badly (no page, broken HTML, wrong language), stop there.

## How we judge

From each run's `results.json` and gallery (`out/design/<run>/index.html`):

- **Design**: you look at the pages side by side, Muse against Opus, without knowing which is which if possible. Is it as good on desktop and on a phone (390px)? Does it follow the look nudge, or always the same style?
- **Checks**: how many pass `checkPage`, how many needed repairs, any made-up phone numbers or emails, any policy text.
- **Language**: natural es-419 and pt-BR, *tú* or *vos* as asked, no English left in.
- **Photos**: does it use the owner's photos well, and does `make_image` work (good scenes, no text in photos, stays under 4)?
- **Money and time**: real cost per page (with reasoning tokens) and seconds per page. The generate Lambda has 10 minutes.
- **Refusals**: any page refused by Meta's moderation, and for which business.

Muse passes if: design at least as good as Opus on most of the 8, checks pass as often as Opus's, cost per page under $0.25, every page in under 8 minutes, no refusals of normal businesses.

## If it passes (production, after your decision)

- `page-writer.ts`: the OpenRouter client as a second `WritePage`, chosen by model ID; `PAGE_MODELS` gets `muse`, so `./coyote.sh page-model muse` switches it with no deploy.
- Secret: 👤 `coyote/openrouter-api-key` in Secrets Manager, read like `coyote/anthropic-api-key`; CDK grants the generate Lambda read access.
- The admin notice's cost line uses the new price; chat edits and redesigns use the same switch.
- Data: owners' business details and photos go to OpenRouter and Meta. Check both terms (no training on our data, retention) before turning it on for real owners.
- Keep Opus as the default until a few days of real sites look good on Muse.
- Update `PLAN.md` (page writer section and Bedrock models note in `CLAUDE.md`).

## Checklist

- [ ] 👤 OpenRouter account, credit, key with a spending limit
- [ ] OpenRouter client + `--model openrouter:<id>` in the bench, unit tests
- [ ] Run 1 (smoke)
- [ ] Runs 2–5
- [ ] 👤 Compare the pages, decide
- [ ] (if yes) Production wiring above
