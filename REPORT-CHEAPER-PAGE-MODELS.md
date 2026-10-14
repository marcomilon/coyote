# Cheaper models for writing landing pages

Report, 2026-10-12. Question: which models cheaper than Claude Opus 5.5 could write Coyote's pages without losing design quality, what OpenRouter offers, and how other builders handle it.

## Summary

- **An Opus page costs about $0.64 at list price** (median of our 63 bench pages: 18k input tokens, 28k output tokens; recorded costs $0.39 to $0.82). Output tokens are about 90% of that, so the output price decides the cost.
- **Several models score close to Opus on design and cost 5x to 40x less.** On the Design Arena website leaderboard (human votes on generated sites, updated 2026-10-12), Opus 5.5 scores 1334. Xiaomi MiMo-V2.6-Pro (1312) would cost about $0.03 a page, Gemini 3.8 Flash (1305) about $0.12, GLM-5.3 (1302) about $0.14, Claude Haiku 5.5 (1271) about $0.016.
- **Meta Muse Spark 1.3 ranks first (1361) at about $0.14 a page**, and Kimi K3 (1339) ties Opus, but Kimi's $10/M output makes it only about 2x cheaper.
- **The cheapest test is Claude Haiku 5.5**: same Anthropic API and SDK as `page-writer.ts`, so it is one entry in `PAGE_MODELS`. It is also on Bedrock and is 10x cheaper than the Haiku 4.5 we use now for questions and template filling, while scoring far higher on design (1271 vs 1127).
- **base64.com is not a site builder** (it is a domain seller, mobile games and consulting). The likely intended one is **Base44** (Wix's AI builder); its approach is below.
- **Recommendation**: run a bake-off with the existing bench (`opus:sites`) on our 8 example businesses: Haiku 5.5, Sonnet 5.5, Gemini 3.8 Flash, MiMo-V2.6-Pro and Muse Spark 1.3 against Opus. Leaderboards measure generic prompts; only our own businesses, skill and page checks tell us if a model is good enough. The model choice stays yours.

## How the cost is worked out

Per page = 18k input tokens × input price + 28k output tokens × output price, using OpenRouter list prices (fetched from `openrouter.ai/api/v1/models` today) or Anthropic's pricing page. Caveats:

- Output tokens include thinking. Other models think more or less than Opus, so their real token counts will differ; the bake-off measures them.
- Photos (`make_image`, $0.04 each) are extra and the same for every model.
- "Win rate vs Opus" is what the Elo gap means: the share of head-to-head votes the model would be expected to win against Opus 5.5. 50% is a tie; 45% means people preferred Opus slightly more often.

## Candidates

| Model | Design Arena (website) | Win rate vs Opus | $ in / out per M | ≈ $ per page | vs Opus cost | Where |
|---|---|---|---|---|---|---|
| Claude Opus 5.5 (today) | 1334 (#3) | 50% | 4 / 20 | 0.64 | 1x | Anthropic API |
| Meta Muse Spark 1.3 | 1361 (#1) | 54% | 1.25 / 4.25 | 0.14 | 4.5x cheaper | OpenRouter |
| Moonshot Kimi K3 (open weights) | 1339 (#2) | 51% | 0.73 / 10 (cheapest host, fp4) | 0.29 | 2x | OpenRouter, Bedrock catalog |
| Claude Sonnet 5.5 | 1329 (#4) | 49% | 2 / 10 | 0.32 | 2x | Anthropic API, Bedrock |
| OpenAI GPT-6.1 Sol | 1324 (#5) | 49% | 2 / 10 | 0.32 | 2x | OpenRouter |
| Xiaomi MiMo-V2.6-Pro | 1312 (#9) | 47% | 0.435 / 0.87 | 0.03 | 20x | OpenRouter |
| Google Gemini 3.8 Flash | 1305 (#11) | 46% | 0.75 / 3.75 | 0.12 | 5x | OpenRouter, Google API |
| Z.AI GLM-5.3 (open weights) | 1302 (#13) | 45% | ~0.08 / 4.8 (varies by host) | 0.14 | 4.5x | OpenRouter, Bedrock catalog |
| Alibaba Qwen3.7 Plus | 1274 (#26) | 41% | 0.32 / 1.28 | 0.04 | 15x | OpenRouter |
| Claude Haiku 5.5 | 1271 (#28) | 41% | 0.10 / 0.50 | 0.016 | 40x | Anthropic API, Bedrock |
| MiniMax M3 | 1262 (#35) | 40% | 0.30 / 1.20 | 0.04 | 15x | OpenRouter |
| DeepSeek V4 Pro 0813 | 1258 (#38) | 39% | 0.66 / 1.98 | 0.07 | 9x | OpenRouter |
| Claude Haiku 4.5 (our `page-model haiku` and template filler) | 1127 (#78) | 23% | 1 / 5 | 0.16 | 4x | Anthropic API, Bedrock |

Notes on the table:

- All candidates support tool calls (needed for `make_image`) and reasoning on OpenRouter. Kimi K3, Muse Spark, MiMo, Gemini and the Claude models also accept images (needed for the owner's photos); **GLM-5.3 is text only**, so it would not see the owner's photos.
- Gemini 3.8 Flash caps output at 65k tokens; our largest page used 59k. Tight but fits.
- Open-weight models (Kimi, GLM) are served by many hosts at different prices and quantizations. The cheapest hosts often run fp4, which can lower quality. Pin the host or quantization (below).
- Arena scores move every week and the boards disagree (Arena's WebDev board ranks differently). Treat a 20 to 30 point gap as "about the same".
- Haiku 5.5 costs 5x more for prompts over 100k tokens; our pages stay well under.

## What OpenRouter gives us

- One OpenAI-compatible API and one key for about 460 models, including all the non-Anthropic candidates above. Prices are the providers' own; OpenRouter charges a fee when buying credits.
- **Provider routing** per request: `provider.order` / `only` to pin a host, `quantizations` to refuse fp4, `data_collection: "deny"` to skip hosts that keep prompts, `allow_fallbacks` to fail over when a host is down. For Kimi K3 the hosts range from $10 to $24 per M output.
- **Variants**: `:batch` halves the price on some models but is not interactive, so it does not fit a waiting owner. Meta's `muse-spark-1.3-contributor` tier is $0.10 / $0.20 but is a "contributor" tier (read as: our data may be used); not for owners' data.
- Fit with our code: `page-writer.ts` uses the Anthropic SDK. OpenRouter models need a second, OpenAI-style client path (messages, tool calls and image inputs map one to one), with the key in Secrets Manager like `coyote/anthropic-api-key`. The page checks, guardrail and photo flow stay as they are.
- It is useful for the bake-off even if production ends up elsewhere: try ten models with one key, then move the winner to its direct API or Bedrock.

## Staying on AWS (Bedrock)

The Bedrock catalog in us-east-1 already lists `anthropic.claude-haiku-5-5`, `anthropic.claude-sonnet-5-5`, `moonshotai.kimi-k3`, `zai.glm-5.3` and `minimax.minimax-m2.5`. These would use the existing `ConverseCommand` path and IAM, no new vendor. Before relying on it, check model access (the account refuses Opus 5.5 on Bedrock) and Bedrock's prices for these models, which were not checked for this report.

## How Base44 does it

Base44 (Wix) builds full apps and sites from a chat, not single static pages, but its model strategy is relevant:

- **Auto mode by default**: it picks a model per message. The picker lists its own in-house model ("Base 1"), Sonnet 5.5, Opus 5.5, Gemini 3.8 Flash, GPT-5.6 Terra, GPT-6.1 Sol, GPT-6 Astra and Fable 5.1. Choosing a model by hand needs a paid Builder plan and costs more credits; "Discuss" mode uses a cheap fixed model (0.3 credits a message).
- **Credits scale with the change**: about 0.5 credit for a small visual change, 3 to 4 for an app-wide change. Cheap edits go to cheap models; expensive models are for big builds.
- **Design comes from a theme, not from each answer**: a theme panel (color roles, fonts) restyles everything at once, plus prompt presets for directions (neo-brutalism, glassmorphism...). Version history and "Revert" on every prompt.

What it suggests for Coyote: we already split the same way (Opus for the first page, Haiku for chat edits, templates for cheap pages). The open step is to route the first page by value: a cheap strong model (Haiku 5.5, Gemini Flash, MiMo) for the free draft, and Opus only for a paid "Rediseñar" or a published site. That fits "free draft, paid publish" and lowers the cost of a draft that never converts.

## Suggested next steps

1. Add `haiku55` (`claude-haiku-5-5`) and `sonnet` (`claude-sonnet-5-5`) to `PAGE_MODELS` and run `npm run opus:sites -w services/generator -- --model …` on `examples/*.json`, side by side with Opus. No new vendor, a few dollars.
2. Add an OpenRouter client path to the bench only (`--model openrouter:<id>`) and run Gemini 3.8 Flash, MiMo-V2.6-Pro, Muse Spark 1.3 and Kimi K3 with the host pinned and fp4 refused. Compare look, page-check failures, made-up contact details, token counts and time.
3. Separately: Haiku 5.5 on Bedrock as `BEDROCK_MODEL_ID` (questions, template filling, chat edits) is 10x cheaper than Haiku 4.5 and much stronger at design. It is a change in `models.ts` only.
4. If a cheap model is close enough, decide the routing (cheap model for drafts, Opus for paid redesigns) and update `PLAN.md`.

## Sources

- OpenRouter model list and prices: https://openrouter.ai/api/v1/models (and `/api/v1/models/<id>/endpoints` for per-host prices)
- Design Arena website leaderboard: https://benchlm.ai/benchmarks/designArenaWebsite
- Arena WebDev leaderboard: https://arena.ai/leaderboard/code/webdev
- Open-model comparisons: https://www.morphllm.com/best-open-source-coding-model-2026
- Anthropic prices: https://platform.claude.com/docs/en/about-claude/pricing
- Base44 model picker: https://docs.base44.com/Building-your-app/AI-chat-modes
- Base44 design tools: https://docs.base44.com/Building-your-app/Design
- Base44 credits: https://docs.base44.com/Account-and-billing/Credits
- base64.com: https://base64.com
- Our token usage: `out/design/*/results.json` (63 Opus pages)
