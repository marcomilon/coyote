# Coyote — AI website generator for LatAm small businesses

## Goal
A public web form asks 3 questions. Opus writes the page (a model first asks the owner a few follow-up questions when the answers are thin), checks finish it, and the owner publishes it on their own domain (Mi sitio → Dominio). Everything runs on AWS. Until the publishing plan, every site is a private draft seen only through the owner's magic link.

## Decisions
- **LLM**: Claude Opus 5.5 through Anthropic's API (the user's key) writes each page; Claude Haiku 4.5 on Amazon Bedrock asks the follow-up questions; Nova 2 Lite pre-screens.
- **Hosting**: one subdomain per site (wildcard cert + CloudFront rewrite).
- **Auth**: none. Rate-limited.
- **Stack**: TypeScript everywhere (CDK, Lambda, Astro frontend).
- **One environment.** A single stack, `Coyote`, in this AWS account, which is the development sandbox: `localhost:5173` may call the API, `cdk destroy` deletes all data, and the rate limit is relaxed. No dev/prod split in code, names, or URLs. If a real production environment is ever needed, it is a **separate AWS account** running the same stack (`COYOTE_AWS_PROFILE=<prod profile> ./coyote.sh deploy`). Real users only ever go on that account; nothing in this one is meant to survive.
- **IaC**: every AWS resource is defined in CDK. Manual one-offs are marked 👤 in the phases.
- **Region**: us-east-1 for everything, except the one image-model call (us-east-1 has no text-to-image model: Stable Image Core in us-west-2). One stack, no cross-region references. Bedrock, CloudFront SaaS Manager, and ACM for CloudFront are native there. CloudFront edges in São Paulo, Bogotá, Santiago, Buenos Aires, and Mexico City serve the sites. Only the API round-trip (~100 ms per submission) is slower than sa-east-1.
- **Opus 5.5 writes each page, with the frontend-design skill as its system prompt** and a request written like a chat message. Rules in the prompt made the designs worse, so the rules are checks on the finished page (`page-check.ts`): what can be repaired is repaired; a page that fails a content check is rejected, and one that never arrives fails the job. There is no fallback. Opus uses the owner's photos when there are any, makes photos with a tool instead of drawing SVG illustrations when the owner left "Fotos creadas con IA" on, and otherwise draws its images as SVG. Pages may use inline JavaScript, Tailwind and libraries from a few CDNs; the sites CSP gives scripts no network access. Changes go through the chat (Mi sitio and the QR chat, below): Haiku 4.5 answers with text changes on an outline of the page, contact changes are swapped into the page with no model call, and a change that needs design work is offered as a new design ("Rediseñar"): Opus writes a complete new page with the request, the page's current texts and photos, and a new look (Diseños, below).
- **MVP sites have only the WhatsApp CTA.** The contact form and SES email are post-MVP. They are built with WhatsApp lead delivery first (`PLAN-PHASE2.md`), email second.
- **Our frontend is Astro, built to static files.** Search and link previews: canonical, full `hreflang`, Open Graph (`/og.png`), JSON-LD on the home page, `robots.txt`, and `sitemap.xml` (public pages only), all built from the site's address (`astro.config.mjs` reads it from the CDK context through `urls.ts`; a domainless build leaves them out). Each owner's pages are `noindex`. Generated business sites are not Astro: Opus writes them and `page-check.ts` finishes them in Lambda.
- **Local toolchain**: Node 24, CDK CLI, SAM (not used).

## Domains
One domain, `<domain>`: the app (`www.<domain>`; the bare domain redirects there), the API (`api.<domain>`), email (`no-reply@<domain>`), private drafts (`draft.<domain>/{draftId}/`), and our own landing examples (`{slug}.<domain>`). Needs a Route 53 hosted zone.

Customer pages are never public on our domain: drafts show only inside the app (see "Drafts"), and owners publish only on their own domain (Mi sitio → Dominio, "Post-MVP: Custom domains"). So a phishing page cannot flag the app, API, or email through Safe Browsing or mail reputation, and no separate sites domain is needed.

The `cdk.json` context `domainName` selects the mode:
1. **Domainless**: unset. No ACM, no Route 53, no aliases. App at its `dxxxx.cloudfront.net` URL, API at the default `execute-api` URL. Drafts at `https://<sites-dist>.cloudfront.net/_draft/{draftId}/`, examples at `/{slug}/`. (A `cloudfront.net` hostname cannot do wildcard subdomains.)
2. **`ventas314.com`** (now): `domainName = ventas314.com`. App at `www.ventas314.com`, API at `api.ventas314.com`, drafts at `draft.ventas314.com`, examples at `{slug}.ventas314.com`. The domain stays registered in another AWS account; its name servers point to the `ventas314.com` hosted zone in this account (👤 created by hand; the stack only looks it up, so `destroy` keeps it).

`consideralohecho.com` serves only the project landing page (`landing/index.html`, a static file hosted outside the stack).

Context keys: `domainName`, and optionally `hostedZoneName` when the domain lives in a parent zone. Our own inbound mail (`info@<domain>`) goes to ImprovMX, a free forwarder, not to SES (forwarded spam would count against the account that sends the sign-in links): context `mailMx` (the bare domain's MX) and `apexTxt` (its TXT values: the forwarder's SPF and Google's site verification). SES sends with DKIM only, so that SPF is the domain's only one; a custom MAIL FROM later goes on a subdomain and does not touch it. Domain mode looks up the zone; the result is cached in `infra/cdk.context.json` (committed), and `account` in `cdk.json` names the account when synth runs with no credentials (CI).

Switching domain = change the context, redeploy, run `./coyote.sh refill-all`. To keep it that simple:
- No domain literal in code, prompts, or tests.
- `urls.ts` (`exampleUrl(slug)`, `draftUrl(draftId)`, `appUrl`, `apiUrl`, the map URLs) is the only code that knows the mode. CSP, CORS, and Origin checks derive from it.
- Pages reference their images with relative URLs, so a page works at `/_draft/{id}/`, at `/{slug}/`, and at a domain root. Drafts in domain mode live at `draft.<domain>/{draftId}/`.

## AWS profile
The project uses the AWS CLI profile **`coyote`** (account `887799775985`, IAM user `coyote`, default region us-east-1).
- Root npm scripts pass `--profile coyote` to `cdk`. Local scripts set `AWS_PROFILE=coyote`. Never fall back to the default profile.
- CI only builds, tests, and synths; it never touches AWS.
- Without the profile: no `cdk deploy`, no model calls from the local scripts. `cdk synth` still works in domainless mode (no `fromLookup`).

## Architecture

```
browser ──(form, es/pt)──> CloudFront #1 [www.<domain>] ──> S3 appBucket (generator UI + "Mi sitio", JS allowed)
   │
   └── POST /generate ──> API Gateway HTTP API [api.<domain>] ──> submit Lambda ──> DynamoDB jobs (PENDING)
                                     (rate limit → pre-screen → slug claim)  │ async invoke (failure → job FAILED)
                                                        v
                                                 generate Lambda ──> Bedrock (Claude Haiku 4.5): plan_site → questions?
                                                        │              ──> Opus 5.5 writes the page ──> page checks + guardrail ──> S3 _draft/{draftId}/index.html
                                                        └──> DynamoDB sites (currentDraftId, drafts) + jobs (NEEDS_INPUT | DONE, draftUrl)
   browser polls GET /jobs/{id} ──> {status, questions?, draftUrl?, magic link once → Mi sitio}; answers → POST /jobs/{id}/answers

visitor ──> https://draft.<domain> (in the app's frame) or an example ──> CloudFront #2 (wildcard alias, sites CSP: inline scripts and a few CDNs, no network access)
              CloudFront Function: Host → path rewrite  /{slug}/index.html  ──> S3 sitesBucket (OAC, private)
```

- **Async + polling**: generation takes 20–60 s; API Gateway caps sync responses at 30 s.
- **Two distributions**: CloudFront picks the cache behavior (and its response-headers policy) from the original path, before the viewer-request function rewrites by Host. One distribution cannot give sites their own script policy (scripts without network access) while the generator UI runs its own JS.

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
    src/core/prompt.ts    # plan_site prompts
    src/core/site-writer.ts     # plan_site (follow-up questions)
    src/core/page-writer.ts     # Opus writes the page (frontend-design skill + a chat-like request)
    src/core/page-check.ts      # checks and repairs on the finished page; contact swaps
    src/core/chat.ts      # the QR chat: messages, Haiku text edits on the page
    src/core/page-outline.ts    # the page with placeholders for the chat model, find/replace changes
    src/core/bedrock.ts   # Converse tool call, effort, caching, images
    src/core/content.ts   # contact details and media schemas (zod)
    src/core/drafts.ts    # draft storage (_draft/, _src/, _media/), refill
    src/core/questions.ts # the model's follow-up questions and the owner's answers
    src/core/policy.ts    # text checks: scam phrases, credential requests, card numbers, brands
    src/core/slug.ts      # slugify, reserved/brand list, atomic claim
    src/core/urls.ts      # all URLs, domainless + domain modes
    src/core/ratelimit.ts # per-IP daily counter in DynamoDB
    scripts/opus-sites.ts       # examples/*.json through the real page writer, per skill × look → out/design/<run>/index.html
    test/                 # vitest: flows, owner, chat, page checks, policy, prompt snapshot
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
- Drafts open at their real URLs (domainless: `https://<sites-dist>.cloudfront.net/_draft/{draftId}/`; with a domain: `draft.<domain>/{draftId}/`). CSP, rewrite, and guardrails are the real ones. Each test site costs about $0.40–0.60 (Opus 5.5).
- The form UI (phase 5) therefore needs phases 3–4 deployed. Before that, only static layout and copy work on `web/` is possible.

## The 3 questions (form)
1. **Nombre del negocio** — business name.
2. **¿Qué hace tu negocio?** — free text: industry, products/services, city/country. Drives language, tone, currency.
3. **¿Cómo te contactan?** — WhatsApp number (the main CTA in LatAm), address, Instagram/Facebook (optional).

A language selector (es / pt) sets the site's language. The owner's **email is required**: it links the site to "Mis sitios" and gets the "ready" email. It is not an answer: it never reaches a model or the page.

## Generation (`services/generator/src/core`)
- **Page writer** (`page-writer.ts`, `page-check.ts`): Claude Opus 5.5 (`claude-opus-5-5`, `PAGE_MODEL` overrides; effort `PAGE_EFFORT`, default high, one level lower for edits) through Anthropic's API, streaming, with the frontend-design skill (`frontend-design.ts`, Apache-2.0, bundled verbatim) as the system prompt. Each request starts from nothing, so Opus converged on one look per kind of business; a new site's request adds one sentence offering 3 random tones from the skill's own list and a light or dark page (`pickLook`). The request is worded like the chat request that gave the best designs (business, owner's answers, contact details, photo file names, "don't invent facts"), with the photos attached as images; no tags, notes, or rules in it: safety is the checks on the finished page. The owner's contact details are sent as they are (phone numbers included), so the page shows them exactly. The language line names the business's country, from its WhatsApp number ("Spanish as it is written in Peru, without slang"), so the words, prices and tú/vos are local without overdoing the slang; a Brazilian number or the Portuguese form get Brazilian Portuguese (WhatsApp numbers must be from the form's country list); +1 (Puerto Rico, Dominican Republic, US) gets Latin American Spanish. Measured: $0.40–0.60 and 3–4 minutes per page; an edit about $0.50. The API key is the Secrets Manager secret `coyote/anthropic-api-key` (👤 created by hand), readable only by `generate`. Opus goes through Anthropic's API because the Bedrock account refuses it. `./coyote.sh page-model haiku|opus` switches the page writer for the whole stack (SSM parameter `/coyote/page-model`, default opus, read by `generate` for each job): Claude Haiku 4.5, without the effort setting, makes testing the workflow cheap. For design experiments, `./coyote.sh page-skill` switches the skill the same way, with no deploy: SSM `/coyote/page-skill` names a `<name>.md` in a private skills bucket (`page-skill add <name> <SKILL.md>` uploads one; frontmatter stripped), or `none` for no system prompt and no "use the … skill" in the request. The default is the bundled frontend-design, which the stack writes to the bucket and which `generate` falls back on when the switch can't be read. The repo also keeps `classic` (`services/generator/skills/classic/SKILL.md`), for traditional, photo-led pages like website-builder templates; the look nudge's tones come from frontend-design's list and would fight it, so it runs with `page-look off`. `classic-bold` (`services/generator/skills/classic-bold/SKILL.md`) combines classic's structure and photos with frontend-design's type, color and details. `./coyote.sh page-look off` (SSM `/coyote/page-look`, default on) drops the look nudge from new sites' requests, so the skill's effect can be judged on its own. `./coyote.sh page-images off` (SSM `/coyote/page-images`, default on) stops the photos the page writer makes, for everyone. The generate log names the model, skill, look, and images switch of each job.
- **Template pages** (`template.ts`, `template-writer.ts`): a second, cheaper way to make pages, switched for the whole stack with `./coyote.sh page-mode design|template` (SSM `/coyote/page-mode`, default design, read per job; no deploy). Design is the page writer above. In template mode, Opus has designed a few templates ahead of time (`npm run templates:make -w services/generator`: frontend-design skill, a random tone each, a short placeholder contract in the request) and Haiku 4.5 on Bedrock fills one per site: `pick_template` chooses from the library's descriptions (no call with one template), then `fill_page` writes the words, with a schema built from the template's slots and their length limits. Our code fills the template: the words (escaped), list items, the business name, address and contact links from the form, the owner's photos first and then made photos for the slots still empty (the scene comes from `fill_page`, then `imageMaker` as above; only with "Fotos creadas con IA" and `page-images` on), and the head (title, description, Open Graph, LocalBusiness JSON-LD). A slot with no photo keeps the drawing Opus put in the template. The finished page goes through the same page checks and output guardrail. Templates are HTML with data attributes (`data-text`/`data-max`/`data-optional`, `data-repeat`, `data-image`/`data-aspect`, `data-contact`/`data-contact-label`, `data-if`, `data-goal`; see `template.ts`). The library is `services/generator/templates/` (`index.json` + `<id>.html`), deployed to `templates/` in the skills bucket; `./coyote.sh page-templates add|rm` checks a template, changes the repo's library and uploads it at once. The draft record keeps `template: {id, fill}`; Rediseñar in template mode takes a template none of the site's designs used, and never the current one (no pick call when only one is left) and fills it from the current words and the request; photo changes keep the template; a page Opus wrote gets a fresh pick. Chat and contact edits work on the page as in design mode. Target cost: a few cents in model calls plus $0.04 per made photo.
- **The owner's goal**: the form asks "¿Qué quieres que hagan tus clientes?" ("Solo ver mi sitio", WhatsApp, call, visit, book; "Solo ver mi sitio" preselected, it says "get to know the business"; the form's one number is labeled "Teléfono" and the request calls it "Phone and WhatsApp", so pages offer both calling and WhatsApp). A new site's request adds one sentence, "The owner mostly wants visitors to …". On the bench (`--goal off,on`, same look per pair) it moved the main button and the section order: a plumber's page went from 0 call buttons to 11, an arepería's from "Pedir por WhatsApp" first to "Cómo llegar" and the address at the top.
- **Made photos** (`images.ts`, the `make_image` tool in `page-writer.ts`): the form has a "Fotos creadas con IA" switch, on by default (`answers.aiImages`, kept with the site, so Rediseñar edits follow it). When it and `page-images` are on, Opus gets a `make_image` tool: it describes a scene in English and an aspect, and the job checks the scene with `ApplyGuardrail`, makes the photo with Stable Image Core on Bedrock in us-west-2 ($0.04, about 10 s; negative prompt: no text, signs, logos, deformed hands), saves it as `_media/{slug}/assets/gen-<id>-<aspect>.jpg` (e.g. `gen-1a2b3c4d-16x9.jpg`), and runs Rekognition on it: moderation, and `DetectText`, which refuses a photo with legible words (sure words of 3+ letters), since the model misspells whatever it writes, in English. The tool description asks for scenes without text, signs, labels, menus, packaging or storefronts. Opus sees each photo it gets back; a refused one comes back as an error and Opus leaves that image out, never failing the job. The request asks for photos instead of SVG illustrations, and the tool description prefers scenes of the business's products, work and place, with people only when the scene needs them, and asks for people who look like ordinary people of the business's country, without stereotyped features. At most 4 per page (a refused scene counts, a failed image model call doesn't); the shapes are the ones Stable Image Core accepts (16:9, 3:2, 1:1, 2:3, 9:16); each result tells Opus how many are left, and once none are, to write the page (the tool stays offered: with it turned off there, Opus ended with no page). Calls in one reply run together, and every tool round shares the page's 9-minute deadline. Every made photo the page uses is kept in `media.generated` and copied into each draft like the uploads. A redesign is offered the newest 8 made photos the current page shows, so a page uses at most 12. The earlier hero photo was removed because one photo chosen without seeing the page invented a shop; here Opus picks the scenes for its own design. Hands: the image model draws six fingers despite its negative prompt, so the scene descriptions avoid hands, and Haiku looks at each made photo (`hands.ts`, `check_hands`, about $0.002) and refuses one with a hand drawn wrong, like a photo with writing; if the check itself fails, the photo is kept.
- **Page writer cost in the tool loop**: each `make_image` round sends the whole request again, so the request is cached (breakpoints on the skill, the first message, and each round's newest turn; later rounds read it at a tenth of the price). A round whose reply already holds the page, in its text or inside a tool call, ends the write: no round writes the page twice. A tool call without a scene is logged with its fields and size.
- **Checks on a written page**: links only to the owner's WhatsApp, phone, email, Instagram, Facebook, or Google Maps (others become `#`); no outside images, other iframes than the Google map, scripts or stylesheets from other hosts, `<base>`, or form actions (all removed); no redirects in scripts, meta refresh, or phone numbers and emails the owner never wrote (the page is rejected; numbers and emails in the description, the answers to the questions, and edit requests count as the owner's, so a second branch or an orders email is fine); the visible text passes `checkTexts` and the output guardrail. A classic script that declares a browser's fixed global at its top level (`const top`, `let location`…) is wrapped in a block, since the browser refuses the whole script otherwise (a page whose fade-ins never ran looked empty). Then the overflow guard, a first-in-head script that shows any still-transparent content after load when a page script failed, and the platform footer are added. The checks run again on every render.
- **Models**: Claude Haiku 4.5 writes the follow-up questions and answers the chat; the pre-screen stays on Amazon Nova 2 Lite. Both defaults live only in `src/core/models.ts`; `BEDROCK_MODEL_ID` and `PRESCREEN_MODEL_ID` override them. ≈ $0.003 per site on Haiku. **Model tiers**: every model has a tier, `paid` or `free`, in `MODELS` in `models.ts`, which also names the page writer's models and holds the prices. Paid: Opus 5.5, Sonnet 5.5, Stable Image Core (its photos only come from a page write). Free: Haiku 4.5 and 5.5, Nova 2 Lite. A page write is paid when the model that wrote it is paid (`writerModel`: the page writer in design mode, Haiku in template mode). Photo swaps call no model and are free. The job keeps `tier`, and the admin notice shows it. A model missing from `MODELS` counts as paid. A new model needs a tier before it is used: the tests check that every model in `models.ts` has one, and synth refuses a `modelId` or `prescreenModelId` context without one. Claude models get `toolChoice: auto` with the tool named in the prompt (newer models reject a forced tool); effort is sent only to models that accept it.
- **Follow-up questions**: before writing, `plan_site` returns ready or up to 4 typed questions. With questions the job becomes `NEEDS_INPUT`; the owner answers or skips ("Saltar preguntas y continuar") through `POST /jobs/{id}/answers`, and the job resumes. One round only. When the description doesn't say what the business offers, `plan_site` sets `enough: false` and names the question that asks it (`offersQuestion`): the owner must answer that one (new sites only). No skip, and an empty answer, or answers the pre-screen finds unclear, send the owner back to the questions (400 `required`). Free-text answers go to the model inside `<answers>` after the input guardrail and the pre-screen; contact answers (phone, email, address, social) are validated like the form and go into the contact details, never to the model.
- **Token budget**: the Opus page is most of the cost (above); `plan_site` and the pre-screen are a few thousand tokens each. Log `usage` from every call into `jobs` and expose cost per site as a CloudWatch metric.
- **Model call**: `BedrockRuntimeClient` + `ConverseCommand`, explicit `maxTokens`, `retryMode: "adaptive"`. Model IDs from env `BEDROCK_MODEL_ID` / `PRESCREEN_MODEL_ID`. Use the `us.` inference profile; check IDs with `aws bedrock list-inference-profiles --region us-east-1 --profile coyote`.
- **Contact details are never model output.** WhatsApp number, social handles, address, and email come from the owner (form, questions, chat) into `answers.contact`; the page writer gets them as they are, and the page checks reject any number or email the owner never wrote.
- **Stored state**: per draft, the record (answers, notes, edit requests, the written page, its design) under `_src/<slug>/`, the finished page and its images under `_draft/<draftId>/`. The `sites` item holds `currentDraftId`, the last 5 drafts and the designs. Finishing a page again (`refill-all`) is a pure function of the record.
- **Designs** (`SiteRecord.designs`, `drafts.ts`): a design is a complete page the page writer made, the first page or a redesign the owner asked for (an edit job with an instruction). Everything else (texts, contact, chat, photo changes, swaps, logos) is a new version of the current design. Each design `{id, draftId, at, kind, request, look}` points at its latest version and records what it used (`look`: layout, tones, background, fonts, template), and each version's record names its design (`SiteDoc.design`). A design's latest version is kept even when it falls out of the last 5 drafts; up to 10 designs (`MAX_DESIGNS`), the oldest one not in use goes first. **A redesign is written fresh**: no old HTML in the request, but the page's current texts to use again (`pageTexts`), the owner's own texts word for word (`keep`), the owner's photos and the made photos the page shows (attached, so they're reused instead of made again), a new look (`pickLook`: a layout from `LAYOUTS` none of the site's designs used, or the one used longest ago; none of their tones while at least 3 stay free; the other background than the design shown), what the site's designs looked like (`designTraits`: the current page's fonts, main colors and background, plus every design's fonts) with "make the new design look very different", and the request, at full effort, always with the frontend-design skill and a look whatever `page-skill` and `page-look` say (a structure-keeping skill like classic-bold only changed fonts and colors). `restoreTexts` and `restorePhotos` then put back owner texts and photos the new page reworded or left out. In template mode a redesign takes another template and fills it from the current words. **Mi sitio → Tus diseños** (pt: Seus designs) lists them ("Diseño N", date, "Primer diseño" or the request, "En uso"), "Ver" opens one in a new tab (`/ver?design=<id>`), and "Usar este diseño" (`POST /me/design { design }`) saves that design's latest version again as a new version: no model call, nothing charged, a chat note, and "Deshacer" goes back to the design shown before. 409 `busy` while an edit runs. Undo of a fresh redesign removes that design; undo of an update moves its design back to the version before.
- **Slug**: slugify(business name). Claimed atomically in `submit` with a conditional put on `sites` (`attribute_not_exists(slug)`). Clean slug first; 4-char random suffix only on collision. Refused before claiming: reserved words (`www`, `api`, `app`, `mail`, `preview`, `draft`, `admin`, `static`, anything starting with `_`), the `blocklist` table, and the brand-impersonation list (a published site's path and custom-domain origin use the slug).
- **Rate limit**: API Gateway throttles the whole API at 50 rps (burst 100), with lower limits on the costly routes (`POST /generate`, `/jobs/{id}/answers`, `/uploads`, `/me/chat`, `/me/edit` at 5 rps; `/report/{slug}` and `/account/login` at 2 rps; `GET /me/chat` at 25 rps), so a flood on one route leaves the others working. Every API Lambda first counts requests per IP per minute (`perIpLimit`, 240/min, a DynamoDB counter with TTL; it lets requests through if the count fails), then the daily quotas (e.g. 3 sites/IP/day). Checked before the pre-screen call, so a blocked request spends no Bedrock money.
- **One free draft per email** (`core/free-draft.ts`): a page model call (Opus, about $0.50) is most of a draft's cost, and an owner pays for one site, so each email gets one free draft. Only a paid-tier page write (see Model tiers) uses it: in template mode or with `page-model haiku`, drafts are free and capped only by the rate limits. Submit reads the page-mode and page-model switches for this, and checks the count before any model call (409 `has_draft`: the form links to "Mis páginas web"); the claim itself is atomic, in the generate Lambda right before the page writer, so waiting on questions or a rejected request uses nothing, and two sites sent at once get one draft (the other job ends REJECTED with `rejectedBy: limit`). A failed page gives it back; deleting the draft does not. The count lives in the rate-limit table under `free-draft#<email hash>` for 5 years. Support or testing: `./coyote.sh free-draft <email>`. **3 free designs per email** (`core/paid-writes.ts`): each email gets 3 paid-tier page writes, the first design and 2 redesigns. Each one is claimed atomically in the generate job right before the writer runs, and given back when the job fails. Free-tier writes and photo swaps use none. When none are left, Mi sitio shows a banner ("Usaste tus 3 diseños gratis"), and a redesign answers 402 `no_designs`: the chat answers a redesign request with no "Rediseñar" offer but the design pack's buy button (`buyDesigns` on the reply; the same checkout as the banner, `buy-designs.ts`; it reads the page switches too), the photo changes say so, while text and contact edits keep working. `GET /me` sends `designsLeft` (undefined while page writes are free-tier). The owner Lambda reads the page switches for this, through `aws/page-tier.ts`. **Design packs** (`core/payments.ts`, `aws/paddle.ts`, PLAN-PAYMENTS.md): when none are left the banner sells 3 more designs for USD 4.90, a one-time Paddle payment that can be bought again. `POST /me/checkout` makes the Paddle transaction on our server, for the site owner's email; Paddle's webhook (`POST /paddle/webhook`, signature checked on the raw body) adds 3 to `designs-bought#<email hash>` once per transaction, and the allowance is 3 plus that. `./coyote.sh usage <email>` shows designs left; `./coyote.sh add-designs <email> <n>` gives designs without a payment. **Calls per email** (`core/email-usage.ts`): every model call is counted for the owner's email, by tier, with its cost in micro-USD. That covers the pre-screen at submit and on answers, the whole generate run (new sites and redesigns), and the chat. The counts are kept all time (5 years) and per month (about 13 months), under `usage#<email hash>` in the rate-limit table. A failed count is only logged. A job that times out loses its count, as it loses its cost notice. `./coyote.sh usage <email>` shows them. Once paid publishing exists, a published site should not count. WAF deferred: add it in front of the API (through CloudFront) if a real attack ever comes.
- **CAPTCHA**: Cloudflare Turnstile (free, usually invisible) on the three anonymous forms that cost money or send email: create (`POST /generate`), the sign-in link (`/account/login`) and report. The check runs on the form's first focus or on submit, not on page load, and the widget mode in Cloudflare is Non-interactive (👤), so nobody is asked to click. The form sends the widget's token as `turnstileToken` in the JSON body; the Lambda checks it with Cloudflare (`aws/turnstile.ts`) right after body validation, before any count, model call or email. A refused or missing token → 403 `captcha`; Cloudflare not answering lets the request through (the rate limits still apply). `/uploads` (cheap, 20/IP/day) and `/jobs/{id}/answers` (gated by a checked submit) are not covered: a token works once. Switch: SSM `/coyote/captcha` (`./coyote.sh captcha on|off`, read at most once a minute, starts off). The secret key is in Secrets Manager `coyote/turnstile` (👤 created by hand); the public site key is the CDK context `turnstileSiteKey`, written into `config.js` (no key: no widget). The app CSP allows `https://challenges.cloudflare.com` in `script-src` and `frame-src`.
- **Frozen accounts** (`core/freeze.ts`): each refusal of the owner's own text (the input guardrail, or a policy rejection by the pre-screen) on the form, the answers, a redesign request or the chat counts for their email (`refusals#<email hash>`, 24 h from the first). The 5th freezes the account (`frozen#<email hash>`): new sites, edits, the chat and design changes answer 423 `frozen`, the draft stays viewable, Mi sitio and the chat say the account is paused, and the admin gets one notice with the last refused text. Refused output (page checks, output guardrail) and unclear descriptions don't count. Only `./coyote.sh unfreeze <email>` lifts it; `./coyote.sh usage <email>` shows it. A refused chat message and its refusal stay out of the history sent with later messages, so one blocked attack doesn't block the chat for good.
- **Guardrail on the input**: only the requester's text is sent as `guardContent`. Our own prompts name the banned categories and would otherwise trip the topic filters on every request.
- **Bundling**: Lambdas are bundled to CommonJS with the AWS SDK included. `./coyote.sh deploy` loads every bundle before deploying, because unit tests run unbundled code and cannot see this kind of failure.
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
   - Word filter: custom scam phrases only ("verifica tu cuenta", "atualize seus dados"). No managed profanity list: it matches single words with no context and blocked "ají de gallina"; insults are caught in context by the content filters, the pre-screen and `policy.ts`.
   - Blocked → fixed message, job `REJECTED` with a generic reason. Never show guardrail details to the user.
   - IAM: the generator role's `bedrock:InvokeModel` has a `bedrock:GuardrailIdentifier` condition, so a call without the guardrail is denied.

2. **Pre-screen classifier** (Nova 2 Lite, `PRESCREEN_MODEL_ID`; tool use, ~200 tokens)
   - Input: business name, description, address (never the phone number). Output tool `classify`: `{ reason, decision: "allow" | "reject", category, confidence, clarity: "clear" | "thin" | "unusable", offers }`. A reject below `REJECT_MIN_CONFIDENCE` (0.5) is not trusted; the other layers still apply. About 1.5k tokens per call (the rules are in the system prompt).
   - It judges meaning, so it catches what the hardcoded list cannot: look-alike spellings ("B4ncol0mbia"), impersonation with no brand named, and prompt injection in the answers (treated as a reason to reject).
   - Reject list mirrors the denied topics, plus an impersonation check (name/description matches a bank, government agency, courier, or major brand).
   - Runs in `submit` after the rate limit, so rejected requests never reach generation or S3. Returns HTTP 422 with "No podemos crear este sitio".
   - Clarity: `unusable` (no real business: keyboard mashing, greetings, tests, a question to us) or `offers: false` (the answers don't say what the business sells or what service it gives: slogans, only a name, "tienda online") returns 422 `{ error: "unclear" }` after a policy check, with no admin notice and the day's rate-limit try given back; the form asks the owner to describe the business again. Our own examples (the form's placeholder and the example in that message, `core/example-about.ts`) copied back as the description, or as the answer to the required question, are sent back the same way before any model call. `thin` goes on to `plan_site`'s questions. The description also needs 3 words. Runs again on the owner's free-text answers to the model's questions and on every edit request.

3. **Policy checks** (`policy.ts`, pure functions, unit-tested)
   - On the text a visitor can read (`checkTexts`, run by the page checks on the finished page): scam phrases, credential requests (a credential word plus a request verb in one sentence, so "la clave de nuestro pan" passes), and card numbers (Luhn). Match → `REJECTED`.
   - Brand impersonation (`brands.ts`), two scopes. Business name and slug: banks, payment companies, couriers, government agencies, big platforms (Bancolombia, BBVA, Itaú, Nubank, Mercado Pago, SAT, AFIP, Correios, DHL, WhatsApp, …). Title and headline: only banks, payment companies, and couriers, so an accountant can write "declaraciones ante el SAT" and anyone can write "pide por WhatsApp".
   - On the page's markup: the page checks (`page-check.ts`, "Generation" above).
   - Any failure → `REJECTED`, nothing uploaded.

4. **After publication**
   - Pages are white label: we add no footer, link or name of ours to them. Reports come through the app page `/reportar?sitio={slug}`, which calls `POST /report/{slug}`. Reports go to an SNS topic (email to the admin). Auto-unpublish only after N reports from distinct IP hashes (otherwise anonymous reports can be used against competitors). Quarantine moves the S3 prefix to `_quarantine/`, is reversible, and shows on the owner's "Mi sitio" page.
   - `jobs` stores the 3 answers, IP hash, guardrail outcome, and classifier decision for 90 days.
   - `./coyote.sh unpublish <slug>`: removes the pages and adds the slug to `blocklist` so it cannot be claimed again. `./coyote.sh restore <slug>` undoes a quarantine.
   - CloudWatch metric + alarm on `REJECTED` rate (a spike means probing).

**Detecting abuse.** Every alarm emails the admin through one SNS topic (`alerts`).
- Lambdas emit metrics with CloudWatch EMF (no extra API calls): `Submitted`, `RateLimited` (429s), `Rejected`, `NeedsInput`, `Generated`, `Edited`, `Failed`, `TokensIn`/`TokensOut`.
- Alarms: sites generated per hour above normal; `RateLimited` spike (someone hitting the cap repeatedly); `REJECTED` rate spike (probing); tokens per day above budget; API Gateway 4xx/5xx and throttle count; `generate` errors.
- Money: AWS Budget alert plus AWS Cost Anomaly Detection (free) on the account.
- One CloudWatch dashboard with the metrics above.
- `./coyote.sh abuse-report`: reads `jobs` for the last 24 h and prints the top IP hashes by requests, their decisions and categories, and the newest drafts. This is the tool for "who is doing this", since metrics only say "something is happening".
- Reports (the app page `/reportar`) arrive by email through `abuse-reports`.
- The admin gets a notice (`notices.ts`, SNS topic `SiteNotices`) for every new site (business, slug, owner's email, draft link, cost by step from the list prices in `models.ts` (model calls and photos; Rekognition, guardrail, Lambda left out), the page writer's settings for that job (model, effort, skill, look, photos, the owner's photo choice; the values the job already read, no extra calls), models and tokens, description), every owner's change the page writer makes ("Rediseño" for a request from Mi sitio or the chat, "Cambio de fotos" for photos added, taken out or described: the request, the photo change, the new draft, the same cost and settings lines), and every rejected request or change (who rejected it and why: brand, pre-screen, guardrail, images, page checks; with the cost of the model calls it made, so a page written and then refused shows it), and every job that failed on our side ("Sitio falló" / "Cambio falló": the error and the cost recorded before it; a call that fails partway reports no tokens, and a timeout, caught by the `job-failed` Lambda, loses the run's calls, which the notice says). Chat text edits (Haiku, a fraction of a cent) send none. `./coyote.sh subscribe-alerts <email>` subscribes to it with the other topics.

Policy text (es/pt) lives in the terms page, linked from the form. The submit button states acceptance.

## Design quality
A model left alone produces the same page every time: purple-to-blue gradient hero, "Bienvenidos a…", three centered icon cards, Inter/Roboto, generic copy. The page writer is the answer: Opus 5.5 with the frontend-design skill as its system prompt, a request worded like a chat message, and one sentence offering 3 random tones and a light or dark page so pages don't converge (`pickLook`). Rules in the prompt made the designs worse; safety is in the page checks. Review design changes with `npm run opus:sites -w services/generator` (real Opus calls, about $0.50 a page), which compares skills, the look nudge, and made photos side by side in `out/design/<run>/index.html`. (Hand-built themes filled by Haiku came first; they looked dated and were deleted. `PLAN-MODEL-SITES.md` has an earlier attempt at model-written pages.)

## Images
1. **The owner's photos come first** (form step "Fotos (opcional)": a logo and up to 6 photos, with thumbnails; Mi sitio → "Tus fotos" adds, replaces, or takes out photos later)
   - `POST /uploads` returns S3 presigned POST URLs (max 2 MB each, file names and types fixed by us: `_uploads/{uploadId}/logo.png`, `photo-N.jpg`; 20 requests per IP per day). The form uploads before submitting; Mi sitio uploads, then sends `POST /me/edit { uploadId?, removePhotos? }`.
   - The browser resizes (logo ≤ 512 px PNG, photos ≤ 1600 px JPEG), which also strips EXIF. `generate` moderates and copies the files to `_media/<slug>/assets/` under unique names (`logo-<id>.png`, `photo-<id>.jpg`), so later photos never overwrite ones a page uses; every draft gets its own copy next to the page. No image library runs in the Lambdas. The images go to the models as image blocks: to Haiku when it plans its questions, and to Opus, which places them in the page by their file names.
   - Moderation: Rekognition `DetectModerationLabels` on every upload (~$0.001/image). Any explicit/violent/hate label → job `REJECTED` (a Mi sitio change keeps the site as it was); the lifecycle rule deletes the uploads.
   - Each photo may carry a short description from the owner ("¿Qué muestra?", at most 100 characters), on the form and in Tus fotos. It is screened with the owner's other text (pre-screen and guardrail), kept as `media.captions`, given to Haiku with the image, and given to Opus as a text block right before each image (file name and description) and in the photo list.
   - Tus fotos also lists the photos the page writer made that the page shows (`GET /me` → `made`), each with "Cambiar por mi foto". `POST /me/edit { uploadId, replaceMade: [files], newCaptions? }` (nothing else in the same request) is an edit job that moderates the uploads, adds them to the site's photos, and swaps each made photo's file for the owner's in the page (`swapMadePhotos`: img src, srcset and CSS backgrounds; the alt text becomes the owner's description when given; in template mode the fill's photo record too), with no questions and no page writer. The usual page checks run on the result. It doesn't use a design (uploads have their own cap); the notice says "N en lugar de creadas con IA, sin rediseño". A new logo works the same way when the page already shows the old one: an upload holding only `logo.png`, with no request, captions or other photo changes, becomes an edit job with `swapLogo` that swaps the old logo's file for the new one (no page writer, free tier, outside the 3 free designs). Every written page gets its logo spot tagged by our code when it is checked (`logo.ts`; never asked of the page writer): `data-logo` on the header's brand link (the first header link classed as a logo or brand, or naming the business) and `data-logo-mark` on its image or the mark the writer drew (inline SVG, or an empty element classed as a mark). A new logo goes into that spot the same way: in place of the mark, or before a text-only name, sized by an inline style. Only a page with no logo file and no logo spot sends the new logo to the page writer, as a redesign.
- Redesigns keep the owner's photos the page shows. The edit request names them ("Keep the owner's photos that the page shows now (…) on the page, unless the change asks otherwise"), and afterwards `restorePhotos` puts each one the new page left out back in place of a made photo of a similar shape (this redesign's first), unless the request is about photos or the logo. Shapes: a made photo's is in its name (`gen-<id>-16x9.jpg`, from the aspect the page writer asked for; older names have none and are never used), an owner's photo's is read from its PNG or JPEG header (`imageRatio`); similar means at most 1.35 times wider or taller (a 4:3 photo fits a 3:2 or square frame, a portrait one never a 16:9). A photo with no frame of its shape stays out rather than be cropped badly. Taken-out photos are no longer in media, so they don't count. One with no made photo to replace is reported as lost, and the edit notice counts them.
- A photo change in Mi sitio (added, taken out, or described) is an edit job with no questions: the new photos are merged into the site's images (a new logo replaces the old one, at most 6 photos) and Opus is asked to place them and take out the removed ones. The page checks drop any `assets/` image that is not one of the site's files.
   - `_uploads/` has a 1-day lifecycle rule. Pages must look good with zero photos.

2. **Made photos fill the gaps, only when the owner wants them.** With "Fotos creadas con IA" on, Opus makes the photos its design needs beyond the owner's (`make_image`, at most 4) instead of drawing SVG illustrations; otherwise it draws them as SVG. (An earlier hero photo, one scene picked before the page existed, invented a shop that does not exist.)

Infra: an `uploads` Lambda with `s3:PutObject` on `_uploads/*` (it signs the POST); `rekognition:DetectModerationLabels` for `generate`; bucket CORS for browser POSTs. Refused moderation categories: explicit and non-explicit nudity, violence, visually disturbing, hate symbols, drugs and tobacco, gambling. Alcohol and swimwear pass (restaurants and beachwear shops exist).

## Site ownership (magic link)
No passwords, no Cognito. Whoever has the link owns the site. The email given in the form is the recovery channel: "Mis sitios" (below) sends a sign-in link to it. The owner's phone (product phase 2) comes later.
- When the first draft of a new site is ready, the create page goes straight to the link: `https://www.<domain>/mi-pagina-web#token=<slug>.<secret>` (the first `GET /jobs/{id}` after `DONE` takes it off the job). The token is in the fragment so it never reaches logs or referrers; the page then keeps it in the browser (localStorage) and leaves only `#sitio=<slug>` in the address, so a shared or screenshotted address does not hand over the site (the QR still carries the token, for the phone). Token = random 32 bytes, stored hashed in `sites`, 1-year expiry. The link is not shown for saving; the owner comes back through "Mis sitios".
- A lost link is recovered through "Mis sitios" (email). WhatsApp re-issue (template `enlace_mi_sitio` to `sites.ownerPhone`) comes with product phase 2.
- "Mi sitio" page, in tabs: "Vista previa" (the current draft at phone and desktop width, following every change live); "Tus textos" (every text a visitor reads, as fields grouped under the page's headings, with the title and meta description last; see Text edits); "Tus fotos" (the logo and photos: take some out, add new ones; saving starts a redesign that places them); "Tus diseños" (every design, pick the one in use; see Designs); "Actualizar tu página" (the chat, the same one the QR opens on the owner's phone: text and contact changes, undo, and a "Rediseñar" offer that starts an edit job (pre-screen, optional questions, a new design by Opus, the page checks and the output guardrail, a new draft); a site made before the chat can no longer be changed there); "Deshacer" (back to the previous draft; the last 5 are kept); delete my data. "Dominio" (search a name, register it for the site; see Custom domains). Post-MVP: last 30 days of messages, pause notifications, add/verify email, connect the domain to the site.
- API: `GET /me`, `POST /me/edit { instruction?, contact?, texts?, uploadId?, removePhotos? }`, `POST /me/undo`, `DELETE /me`, `GET /me/chat`, `POST /me/chat { text }`, all with `Authorization: Bearer <token>`, 60 requests per site per day (`GET /me` has its own cap of 1000, so opening Mi sitio and `/ver` never uses up changes; `GET /me/chat` has its own cap of 3000, for polling), redesigns limited only by the email's designs, 30 chat messages per site per day. `POST /jobs/{id}/answers` answers the model's questions (the job ID is the credential). Unpublish and republish come back with the publishing plan.

## Mis sitios (email sign-in)
Every site made with one email is listed at `/mis-paginas-web` (`/pt/meus-sites`), from any device.
- `account.ts`. Account key `emailId = sha256(lowercased email)`. The `accounts` table (pk `pk`, sk `sk`, TTL) holds `email#<id>` → a profile (email, lang) and one row per site; `login#<hash>` sign-in links; `session#<id>` sessions. The email is stored there and on the create job (redacted with the site).
- The first draft of a new site links it (`sites.ownerEmailId`) and sends "Tu sitio está listo" with a sign-in link. No other email goes out unasked; questions, rejections, failures, and edits send nothing, and a send failure never fails the job.
- The create page says "no cierres esta pestaña" while questions may still come (job `stage: clarify`); once `plan_site` has none (`stage: write`, returned by `GET /jobs/{id}`) it says the page can be closed and the email will follow.
- `POST /account/login { email, lang }` always answers 202; the email goes out only to an existing account, at most 3 per email and 10 per IP a day. The link (`#login=<secret>`) works once, for an hour: `POST /account/session` turns it into a session `@<id>.<secret>` (30 days, `localStorage`). `GET /account` lists the sites with their drafts.
- A site is reached with `<slug>.@<id>.<secret>`: the shape of a magic link, so Mi sitio, the chat, the QR, and the live preview take it unchanged; `authenticate` checks the session and that the site is in its account.
- The page lists the sites; one selected shows its preview (following the chat's changes) and Mi sitio.
- Deleting a site unlinks it; the account goes with its last site. Sites made before this are not linked.
- Email: SES `SendEmail`, branded HTML with a plain-text version, fixed subjects, business names the only owner text. From: domainless, the CDK context `senderEmail` (an address verified in SES; unset = no email, sign-in answers 503); domain mode, `no-reply@<domain>` with DKIM (`urls.ts` `mailFrom`). While SES is in the sandbox, recipients must be verified too, so `ses:SendEmail` covers the account's identities. Test runs send to `success@simulator.amazonses.com`.

## Text edits (Tus textos)
- `page-texts.ts` reads the written page (`doc.page`) with htmlparser2 and lists every text a visitor reads: text in the body (not scripts, styles, `<template>`, `<noscript>`, or a drawing's `<title>`/`<desc>`), the `<title>`, and the meta description. Each entry is a block: the nearest paragraph, heading, list item, button, label or cell around the text, whatever formatting is inside (`Pan <strong>recién</strong> horneado` is one entry), or a layout element with words of its own; links or spans alone in a layout element (buttons in a row) are entries of their own. A `<br>`, and sibling elements that touch (`<span class="block">Panadería</span><span>Rosa</span>`), read as a space. Each entry has its place in the list, its text, the h1/h2 it is under, and the pieces of source it comes from. Words a script writes and image alt texts are not listed; the chat still changes those.
- Each field has a label saying what the text is (título principal, título de sección, subtítulo, párrafo, botón, menú, elemento de lista, pie de página, texto…), from its element: the heading level, a link alone in `nav`/`header` (menú) or elsewhere (botón), a block inside `footer`, and so on.
- Texts of one card share a box with a border: the largest element around them with 2 to 8 texts, no h1 or h2, and other elements with texts next to it (a numbered point, a service, a price list, a contact card).
- A text that shows the owner's contact details (`showsContact` in `page-check.ts`) is read-only: contact changes go through the chat, which keeps the links in step.
- `POST /me/edit { texts: [{ id, from, to }] }`: each change must still have the text it had (`from`), or the save gets 409 `stale` and Mi sitio loads the list again. The new text is mapped back word by word (longest common subsequence of words, spaces and punctuation): kept words stay in their formatting, a word that replaces another takes its place, and words added at the edge of formatting go to the plainer side, so `Pan de <em>barrio</em>` → "Pan de barrio en Lima" keeps "en Lima" out of the `<em>`. Each piece is escaped and written where it was; no model call. Then the page checks and the output guardrail on the new texts, and a new draft that "Deshacer" can undo. Numbers and emails the owner typed are kept in `requests`, as in a chat request. 409 `busy` while a redesign runs (it would drop the change). Empty texts are refused; taking out a part of the page goes through the chat.

- Redesigns keep the texts the owner wrote. The draft record keeps `ownerTexts`: the texts a Tus textos save or a chat edit put on the page, while they stay there (`ownerTextsAfter`). An edit job sends them in the request ("The owner wrote these texts themselves; keep them word for word unless the change asks otherwise", in template mode in Haiku's fill request). After the page comes back, `restoreTexts` puts back any the new page reworded: into the entry with the same role that shares at least half its words, unless the owner's request names the text (a word of 5+ letters from it). The page checks and the output guardrail run again on the result (if they fail, the unrestored page is used). The edit notice says how many were kept, put back, or lost.

## Chat edits (QR)
The owner looks at the draft on a computer and asks for changes from their phone.
- The create page shows a QR code next to the draft. It opens `/chat#token=<magic-link token>` (`/pt/chat` in Portuguese) on the phone: the same token as Mi sitio.
- `POST /me/chat` stores the owner's message and a pending reply in the `chat` table and starts the `chat` Lambda. One reply at a time; no messages while an Opus edit job runs (its result would drop the chat's changes). Drafts made before the page writer have no chat.
- The `chat` Lambda (`chat.ts` `runChatTurn`): pre-screen on the message (Nova), then Haiku 4.5 (`edit_page` tool) with the last 10 messages (guarded) and an outline of the page (`page-outline.ts`: styles, scripts, SVG, data URIs, and long class attributes replaced by `⟦n⟧` placeholders; phone numbers masked as for Opus). Actions: `edit` (find/replace changes, each `find` must match once; one retry with the problems), contact changes (only details the owner wrote; applied like the contact form), `ask`, `redesign`, `none`. A reply to a text edit ends with a tip that any text can also be changed in Tus textos (our wording, not the model's), when the page has texts there and none of the recent replies gave it.
- An edit goes through the usual checks (`checkPage`, output guardrail on the new text and the reply) and saves a new draft. A change that does not apply or fails the checks gets a reply and a "Rediseñar" offer.
- "Rediseñar" on the phone calls `POST /me/edit { instruction, from }` (the Opus edit job, with its questions) and follows it in the chat. `from` is the reply that offered it: the job marks that reply `redesignStarted`, and its button stays disabled from then on. One redesign at a time: while an edit job is running or waiting for answers, another `POST /me/edit` with an instruction gets 409 `busy` (before the daily limit counts it). "Deshacer" is `POST /me/undo`; the chat asks before undoing.
- Redesigns and undos leave notes in the chat (`chat-notes.ts`), stored like the replies, so a reload or another device shows them: `POST /me/edit` stores a pending "Rediseñando…" note that names its job (`job.chatAt` points back), and the generate job (or the failure handler) fills it in with how it ended. A finished redesign's note carries the new draft, so it can be undone, and an "Abrir en otra pestaña" link. If the job ends without a word (stuck past its cutoff), `GET /me/chat` fails the note. While a note is pending the chat follows its job again after a reload, questions included. Undo adds a "volví a la versión anterior" note.
- The phone polls `GET /me/chat?after=<at>` every 2 s while a reply is pending, 6 s otherwise. The create page polls it every 5 s while visible (for an hour after the last change) and swaps the preview when the draft changes. `GET /me/chat` has its own API Gateway throttle (25 rps, burst 50), above the stage's 5/10.
- Messages expire after 90 days and are deleted with the site.

## Drafts and publishing
- Every version is a draft at `_draft/<draftId>/` (random 128-bit ID), served by the sites distribution with `X-Robots-Tag: noindex` and the sites CSP (inline scripts and the listed CDNs, no network access); `frame-ancestors` lets the app show it. A site is public only once its plan is paid, on its own domain (custom domains, step 5).
- Drafts show only inside the app's pages, so a draft link is useless for phishing. The sites rewrite returns 404 when `Sec-Fetch-Dest` is `document` (the link opened in a tab) or missing (old browsers); `frame-ancestors` stops other sites from framing it. "Abrir en otra pestaña" opens `/ver#token=…` (`/pt/ver`): the draft full screen under a "Borrador privado" bar that is always shown.
- Drafts do not expire; old versions beyond the last 5 are deleted.
- Each site also has a **preview**, `_draft/<previewId>/`: a stable URL that follows `currentDraftId` (a copy made whenever the pointer moves: new draft, undo, `refill-all`), served with `no-cache` so a reload always shows the current version. The `/ver` page shows it; the versioned drafts stay for undo.
- **Paying publishes.** A site with an active plan and a registered domain gets a live copy at `_live/<slug>/`, served on the domain by the live distribution (custom domains, step 5). It follows every change (`refreshPreview` copies to it). A plan that ends takes it down; paying again puts it back.
- 👤 Later: admin review and the go-live email.

## Landing examples
- The landing's "Negocios como el tuyo" cards show the example sites (Taller Ruiz, Panadería Rosa, Salón Luna; inputs in `examples/{mx-taller,co-panaderia,ar-salon}.json`), made by Opus with photos through `opus:sites --images on`. They are the only public pages before the publishing plan.
- Residencial Oliva (`examples/peru-inmobiliaria.json`) is a fourth example, written from the owner's own logo and photos (`photos` in the example file, sent as production sends them). It is on the landing like the others: a fourth hero phone tab ("Inmobiliaria") and a fourth "Negocios como el tuyo" card (2 × 2, then one row).
- Their slugs are `EXAMPLE_SITES` (`core/examples.ts`), reserved for owners. The pages live in `examples/sites/<slug>/`, deploy to the sites bucket's `_examples/<slug>/`, and serve at `urls.exampleUrl(slug)` = `{slug}.<domain>` (the sites rewrite allows top-level loads for those slugs only). The app gets their URLs from `config.js` (`examples`). Their footer links name the app's domain, so after a domain switch run `example-page` again for each one before deploying.
- To replace one: run `opus:sites`, then `./coyote.sh example-page <run>/pages/<biz>/<page-dir> <slug>` (copies the page and its photos), take a new 1200×900 screenshot into `web/public/ejemplos/<slug>.jpg`, and deploy.

## Spanish with vos
- Visitors from Argentina, Uruguay and Paraguay (`VOSEO_COUNTRIES`, `core/i18n.ts`) read the app with vos instead of tú. `strings.ts` holds `esVos`, only the strings that differ; `t(lang, vos)` lays it over `es`.
- Every Spanish page is built twice: the usual one and its twin under `web/src/pages/vos/` (legal pages are vos copies of the markdown). The app's rewrite (`cf-app-rewrite.js`) serves the twin at the usual URL when `CloudFront-Viewer-Country` is a voseo country; the canonical points at the usual URL, and the sitemap leaves the twins out. The country chosen in the home page's picker overrides the detected one: it is kept in a `country` cookie (our only cookie, named on the privacy page), which the rewrite reads first, and the page reloads when the choice changes the voice.
- The texts the backend writes for a site (chat replies, chat notes, the "page ready" email) follow the site's phone country (`voiceOf`). The sign-in email has no site and stays tú.
- `npm run dev` has no edge: open `/vos/…` to see the vos pages.

## Privacy and legal
- Privacy and terms pages (es/pt, written in Markdown): what we store (answers, owner WhatsApp number, IP hashes for rate limiting; later owner email and visitor messages for 30 d), why, retention, how to delete (magic-link page or email). Covers the basics of LGPD (BR), LFPDPPP (MX), Ley 1581 (CO), Ley 25.326 (AR).
- IPs stored only as salted hashes. No cookies or analytics on generated sites.
- The privacy page names Anthropic (answers and photos, never the phone number) and the public CDNs the sites load fonts and libraries from.

## Environments and delivery
- **Environment**: one stack (see Decisions). With domains: `www.<domain>` (and the bare domain, which redirects), `api.<domain>`, `*.<domain>` (drafts and examples).
- **CI**: GitHub Actions on every PR: `npm run build` + `npm test` + `cdk synth`. Deploys are manual (`./coyote.sh deploy`); automated deploys with an OIDC role can come with the production account.
- **Runbook** in `README`: deploy, rotate SSM secrets, unpublish a site, check Bedrock quota. No prepaid vendors to top up.
- **Flags**: critic pass, digest mode.

## Infra (CDK, `infra/lib`)
`CoyoteStack` (us-east-1), one per environment. Items marked *(domain mode)* exist only when `domainName` is set. In domainless mode the stack exports `AppUrl`, `ApiUrl`, `SitesBaseUrl`.
- *(domain mode)* ACM certificates, DNS-validated in the zone found by `HostedZone.fromLookup`: `www.<domain>` + `<domain>`, `api.<domain>`, and `*.<domain>`.
- *(domain mode)* Route 53 alias records: `www.<domain>`, `<domain>`, `api.<domain>`, `*.<domain>` (the explicit names win over the wildcard).
- S3 `sitesBucket`: private, versioned, block public access. Lifecycle: noncurrent versions 30 d, `_uploads/` 1 d. Drafts (`_draft/`) never expire. `_src/` (records) and `_media/` (images) are never served. S3 `appBucket`: generator UI.
- **CloudFront #1 — app**: OAC to `appBucket`, aliases `www.<domain>` and `<domain>`. Missing paths get the app's 404 page with status 404 (the private bucket answers 403). A viewer-request function sends the bare domain to `www` (301, path and query kept) and maps clean URLs to Astro's output (`/mi-pagina-web` → `/mi-pagina-web/index.html`). CSP: `script-src 'self'` (Astro is configured to emit external script files, no inline scripts), `connect-src https://api.<domain>`, `frame-src https://draft.<domain>`. HSTS.
- **CloudFront #2 — sites**: OAC to `sitesBucket`, alias `*.<domain>` (the apex and `www` belong to the app distribution). One viewer-request CloudFront Function, both modes unit-tested:
  - `Host == draft.<domain>` → `/_draft/<path>` (only 32-hex draft IDs)
  - `Host == {slug}.<domain>` for a landing example → `/_examples/{slug}/<path or index.html>`; any other host → 404
  - apex → redirect to the app (`https://www.<domain>`)
  - domainless (`Host` is the `cloudfront.net` name): no host rewrite; `/_draft/{id}` → 301 `/_draft/{id}/`; `/_draft/{id}/` → `/_draft/{id}/index.html`; `/` → redirect to the app. `/{slug}/` answers 404 except for the landing examples.
  - ResponseHeadersPolicy: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' <the CDNs in page-check.ts>, with no `connect-src` so scripts have no network access; frame-src https://maps.google.com https://www.google.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action https://api.<domain>; frame-ancestors https://www.<domain>`. HSTS. `X-Robots-Tag: noindex, nofollow` while every page is a private draft.
  - Domainless CSP: `frame-ancestors` uses the app distribution URL. Where an exact URL would make the distributions and the API depend on each other in a circle, a wildcard is used instead: sites `form-action https://*.execute-api.<region>.amazonaws.com`, app `connect-src` the same, app `frame-src https://*.cloudfront.net`. Domain mode uses exact origins everywhere.
  - Cache: default TTL 5 min, so an owner's edit shows up without an invalidation. Missing pages (S3 answers 403) return a small 404 page from `_errors/`.
- `BucketDeployment` of `web/dist/` (the Astro build) plus the generated `config.js` → `appBucket`.
- DynamoDB, MVP: `jobs` (pk `jobId`, TTL 90 d; answers, safety outcomes, usage), `sites` (pk `slug`; status, currentDraftId, drafts, ownerWhatsApp, tokenHash, createdAt), `ratelimit` (pk `ip`, TTL), `blocklist` (pk `slug`), `chat` (pk `slug`, sk `at`, TTL 90 d), `accounts` (pk `pk`, sk `sk`, TTL; "Mis sitios"), `domains` (pk `domain`; slug, status, expiresAt, price; kept when the site is deleted). `mail-suppression` (pk `emailId`; bounced or complaining addresses). Post-MVP: `messages`, `wa_*` (`PLAN-PHASE2.md`), GSI on `sites.ownerPhone`.
- `CfnGuardrail` + `CfnGuardrailVersion` (Standard tier; filters, denied topics, word filters as above). ID/version passed to Lambdas via env.
- Lambdas: `NodejsFunction`, Node 22, esbuild. MVP: `submit` (sync, 15 s), `generate` (async, 5 min, 1 GB, on-failure destination → `job-failed` handler), `status`, `uploads`, `owner` (`/me`), `chat` (async, 2 min, started by `owner`), `account` (`/account/*`), `report`, `domains` (`/me/domain*`, the registrar's API). SES email identity (`senderEmail` in domainless mode, `<domain>` with DKIM in domain mode, sender `no-reply@<domain>`). `submit` also serves `POST /jobs/{id}/answers`. `mail-events` (SES bounces and complaints, the reputation alarms). Post-MVP: `contact`, `digest`, `wa-*`.
- HTTP API on `api.<domain>`: `POST /generate`, `GET /jobs/{id}`, `POST /jobs/{id}/publish`, `POST /uploads`, `/me/*`, `POST /report/{slug}`. CORS locked to `https://www.<domain>`. Throttling.
- SNS topic `abuse-reports` with email subscription.
- IAM: `bedrock:InvokeModel` scoped to the model/profile ARN with the `bedrock:GuardrailIdentifier` condition, plus the image model (us-west-2, `generate` only) without it, since its scene goes through `ApplyGuardrail` first; `bedrock:ApplyGuardrail` on the guardrail; `s3:PutObject`/`DeleteObject` on the sites bucket; DynamoDB RW on the MVP tables; `rekognition:DetectModerationLabels`.
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
- [x] Landing page (v2 from `design_handoff_landing_v2/`: one small script for the country picker and the hero example tabs; the FAQ is `<details name>`). Business facts (prices per country, stats, testimonials, WhatsApp number) live in `web/src/config/landing.ts`, placeholders marked `TODO(`. Look: hand-painted shop signs ("rótulos"), order-ticket form; fonts Bungee, Yellowtail, Hanken Grotesk
- [x] Country preselected (landing picker, phone fields) from CloudFront's viewer country: `GET /geo` on the app distribution is a CloudFront Function (`infra/lib/cf-geo.js`) with an origin request policy that lists `CloudFront-Viewer-Country`; the app CSP allows `connect-src 'self'`. Falls back to the time-zone guess (and always under `npm run dev`)
- [ ] Landing examples: three Opus pages with photos, served publicly at their slugs, screenshots and links on the cards (see "Landing examples")
- [x] Spanish with vos for Argentina, Uruguay and Paraguay: vos twins of every Spanish page picked at the edge by country; chat replies, notes and the ready email by the site's country (see "Spanish with vos")
- [x] Form at `/crear` and `/pt/criar` (3 questions, site language, terms note); validates with the same zod schema as the API (`answers.ts`). The uploads step arrives with the `uploads` route
- [x] `npm run dev` = `astro dev` on :5173 → deployed API (writes `web/public/config.js` from `cdk-outputs.json`). Astro 7 starts the server in the background; stop it with `npx astro dev stop` in `web/`
- [x] Polling/progress state, preview with "Publicar", rejected / rate-limited / failed messages. The job ID lives in the URL hash, so a reload resumes. Checked in headless Chrome against real jobs
- [x] Result screen: link + copy
- [x] Build emits external scripts only; `web/dist/` deployed via `BucketDeployment` (`coyote.sh deploy` builds it first). On the live app: clean URLs work (`/crear`, `/pt/criar`), CSP is `script-src 'self'`, the create script runs and calls the API with no CSP violations

### Phase 5b — Magic link + preview
- [x] Preview iframe, "Publicar", "Genera otra versión" (`POST /jobs/{id}/regenerate`), cap of 2 regenerations per site. A regeneration varies the variety seed, so it offers other themes. Generation results live on the job; the site record and the live page change only on publish
- [x] Magic link: token `<slug>.<secret>`, only the sha256 of the secret stored, 1-year expiry, returned once when the draft is ready; the create page opens Mi sitio with it
- [x] "Mi sitio" page (`/mi-pagina-web`, `/pt/meu-site`) + one `owner` Lambda for `GET /me`, `POST /me/content|regenerate|unpublish|republish`, `DELETE /me`. An edit goes patch → policy → `ApplyGuardrail` → re-render, with no model call. 60 owner requests per site per day. "Delete my data" removes the pages and the site record and redacts the text of every job of that site. Publish, edit, unpublish, republish, and delete invalidate the CDN cache, so they show at once. Verified end to end on the deployed stack
- [x] Privacy and terms pages (es/pt, Markdown)
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
- [x] Opus 5.5 page writer with the frontend-design skill (`page-writer.ts`), checks and repairs on the page (`page-check.ts`), page edits with Opus at one effort lower, contact edits swapped into the page, redesigns limited only by the email's designs; sites CSP with inline scripts and the CDN list; `generate` 10 minutes; privacy page updated
- [x] 👤 Anthropic API key in Secrets Manager (`coyote/anthropic-api-key`)
- [ ] Page-skill switch (`./coyote.sh page-skill`, skills bucket, SSM `/coyote/page-skill`); check: 👤 deploy, add a skill, make a site with it and with `none`; `page-look off`
- [ ] Owner's goal on the form (`answers.goal`); check: bench `--goal off,on` ✓, 👤 deploy, a site with "Llamarte"
- [ ] Made photos: "Fotos creadas con IA" switch on the form, `make_image` tool, `./coyote.sh page-images`; check: bench `--images on,off`, 👤 deploy, a site with the switch on and one with it off
- [x] Opus writes every new site on its own: no themed fallback, no hero photo (SVG instead); a page writer failure fails the job
- [x] Look nudge against same-looking sites: each new site's request offers 3 random tones from the skill's list and a light or dark page (a redesign: other tones and the other background); Opus picks the tone that suits the business (`pickLook`). `opus:sites --repeat 3` shows the spread on one business
- [x] Fewer ticker strips: Opus put a scrolling ticker/marquee on 10 of 12 pages; 3 in 4 new-site requests now ask for a page without one (`pickLook` `noTicker`), the rest say nothing
- [ ] Deploy and check a written page live (CSP, map, photos, Mi sitio edit)
- [ ] Photo descriptions on the form and in Tus fotos; check: unit tests, 👤 deploy, a site with 2 described photos placed to match, and a changed description followed by the new draft
- [ ] Owner photos on the form (logo + 6, thumbnails) and in Mi sitio → "Tus fotos"; check: unit tests, 👤 deploy, a site created with a logo and 6 photos, then one photo added and one taken out in Mi sitio, and a flagged photo refused without losing the site
- [x] Delete the theme pipeline (themes, render, brief, content prompts, Tailwind build, sheets, hero images); every draft is a written page
- [ ] Deploy and live checks, including `verify:live`
- [ ] 👤 AWS Support case: Claude Opus 5.5 and Sonnet 5 refused on the account ("not available for this account")
- [ ] 👤 Later plan: admin review and the go-live email (publishing is built: paying publishes)

### Phase 5d — Chat edits from the phone (QR)
- [x] `chat` table, `chat` Lambda, `GET`/`POST /me/chat` with a poll cap and route throttle; Haiku `edit_page` on a page outline, contact changes, redesign offer; unit and stack tests
- [x] Chat page (`/chat`, `/pt/chat`), QR code on the create page (`uqr`), preview follows the chat's changes
- [ ] Deploy and check live: scan the QR, a text change, a new number, undo, a redesign, the desktop preview updating
- [x] Stable preview URL per site (`refreshPreview`): a tab opened on the computer shows the phone's changes on reload
- [x] QR and live preview on Mi sitio too

### Phase 5g — Tus textos (direct text edits)
- [x] `page-texts.ts` lists the page's texts by block with their places in the source and maps changes back word by word; `GET /me` returns them, `POST /me/edit { texts }` saves them; "Tus textos" tab in Mi sitio. Tested on the example pages
- [ ] 👤 Deploy; check live: change a few texts on an Opus page, a stale list after a chat edit, a text with the phone number shown read-only

### Phase 5f — Template pages (cheaper mode)
- [x] Template format and filler (`template.ts`), Haiku pick and fill (`template-writer.ts`), template mode in the generate job, `template` in the draft record; unit tests
- [x] Switch and library: SSM `/coyote/page-mode`, templates deployed to the skills bucket, `./coyote.sh page-mode`, `page-templates`, mode in `status` and the admin notice; stack test
- [x] `npm run templates:make` (Opus designs, Haiku fills example businesses, gallery with cost per page)
- [x] 👤 Review the first templates and add the good ones (`./coyote.sh page-templates add`): 5 added (vintage-signage, luxury-refined, minimal-dark, soft-pastel, art-deco)
- [ ] 👤 Deploy; check live with `page-mode template`: a new site, a chat edit, a contact edit, Rediseñar, the cost in the notice; then `page-mode design` and a site by Opus. Done: deploy, a new site and a Rediseñar from templates (≈ $0.012 of Haiku each, plus photos), and a site by Opus after switching back. Left: a chat edit and a contact edit on a template site

### Phase 5e — Mis sitios (email sign-in)
- [x] Required email in the form, `accounts` table, sites linked on their first draft, "ready" email with a sign-in link, "you may close this page" once no questions are left
- [x] `/account/login`, `/account/session`, `GET /account`; sessions reach sites as `<slug>.@<session>`; `/mis-paginas-web` page with preview and Mi sitio; privacy pages updated; unit and stack tests
- [ ] 👤 Deploy (the sender is `senderEmail` in `infra/cdk.json`, a personal address until the product is published) and click the SES verification email; verify the test recipients too (SES sandbox)
- [ ] Check live: close the tab after the questions, get the ready email, sign in, scan the QR, change the site from the phone
- [ ] 👤 SES sandbox exit (the brand domain is verified now; ask when outside testers start). First lower the per-IP limit (`rateLimitPerDay`, 100 in this sandbox): out of the sandbox, the form can send the ready email to any address typed in it

### Phase 6 — Hardening
- [x] Report endpoint (`POST /report/{slug}`) + `reportar` / `pt/denunciar` pages + SNS email per report. One visitor counts once per site; 3 distinct visitors quarantine it (pages moved to `_quarantine/`, status `quarantined`, the owner cannot republish it)
- [x] `./coyote.sh unpublish <slug>` (delete + blocklist), `restore <slug>`, `rerender-all` (now `refill-all`)
- [x] EMF metrics from the Lambdas (namespace `Coyote`); 9 alarms → SNS `alerts`; dashboard `Coyote` (`infra/lib/monitoring.ts`)
- [x] 👤 Alert emails: both topics subscribed and confirmed with authenticated unsubscribe. The stack does not create email subscriptions: a subscription confirmed by clicking the email link can be removed by any mail scanner that follows the unsubscribe link (this happened). `./coyote.sh subscribe-alerts <email>`, then `confirm-alerts '<link>'` per topic; `protect-alerts` repairs click-confirmed ones
- [x] AWS Budget ($20/month, alerts at 80% and 100%) + Cost Anomaly Detection (≥ $5)
- [x] `./coyote.sh abuse-report` (requests per hashed IP, rejections by layer, newest published sites)
- [x] `README` runbook
- [x] Full "Verification" section passes on the deployed stack (contact form excluded: post-MVP). `npm run verify:live -w services/generator` runs the 48 safety fixtures through the deployed API: 48/48. Layers that stopped the 27 bad cases: guardrail 18, pre-screen 5, brand list 4
- [ ] Switch to `ventas314.com` (config set; 👤 zone delegated): first real deploy of domain mode; subdomain rewrite verified
- [ ] 👤 Choose the final domain name (`<domain>`). Choosing the brand also unblocks Meta Business verification (`PLAN-PHASE2.md` step 1), which takes weeks, so decide early if WhatsApp is next
- [ ] 👤 **Before any public launch: create the production AWS account** and its CLI profile. Add one production switch to the stack then (retain data + point-in-time recovery, no `localhost` in CORS or `frame-ancestors`, rate limit 3/IP/day) and deploy the same code there. Never launch publicly from the sandbox account: moving live sites, records, and a domain to another account later is real migration work
- [ ] 👤 **Launch gate**: final domain set, redeploy, re-render

### Phase 6b — CAPTCHA (Cloudflare Turnstile)
- [x] Check in submit, sign-in link and report (`core/captcha.ts`, `aws/turnstile.ts`); widget on the three forms (`web/src/scripts/turnstile.ts`), es/vos/pt messages, privacy pages; switch `/coyote/captcha`, secret grants, CSP, `turnstileSiteKey` in `config.js`; `./coyote.sh captcha`; unit and stack tests
- [x] 👤 Cloudflare dashboard → Turnstile → add a widget (Managed; hostnames: the app domain, and `localhost` for `npm run dev`); put the site key in `infra/cdk.json` (`turnstileSiteKey`); create the secret: `aws secretsmanager create-secret --name coyote/turnstile --secret-string '<secret key>' --profile coyote`
- [ ] 👤 Deploy, `./coyote.sh captcha on`, then check live: a site from the form, a sign-in link, a report; `/generate` with no token answers 403. Done: deployed, on; with no token or a fake one, create, sign-in link and report answer 403 (Cloudflare accepts the secret). Left: a site from the form in a browser

**MVP line.** Product phase 2 (`PLAN-PHASE2.md`) runs here: WhatsApp creation, contact form, leads on WhatsApp.

### Phase 7 — Email fallback (SES)
- [ ] SES identity + DKIM on `<domain>` (sender `no-reply@<domain>`; in the stack since Phase 5e) + MAIL FROM + DMARC
- [ ] 👤 Sandbox exit request approved
- [ ] Owner email add/verify in "Mi sitio"
- [ ] Email branch in the `contact` Lambda (built in product phase 2)
- [x] `mail-events` (bounce/complaint) and the `mail-suppression` table, for the sign-in and ready emails (see "SES reputation protection"). Checked live: sends to the SES bounce and complaint simulators landed in the table
- [ ] List-Unsubscribe + pause link
- [x] Reputation kill switch + alarms
- [ ] Digest mode

### Phase 8 — Custom domains
- [ ] 👤 Porkbun account: prepaid credit, API access for all domains, WHOIS privacy on by default, API spend limit; API key (read, domains, purchase, dns) in Secrets Manager `coyote/porkbun-api` as `{apikey, secretapikey}`
- [x] Confirm `.com` is `apiRegisterable` (a real `.com` registered through the tab)
- [x] Registrar (`aws/porkbun.ts`) + availability check across the TLDs (`core/domains.ts`)
- [x] Mi sitio "Dominio" tab: search, a confirm card (Coyote is the registrant), register behind `./coyote.sh domain-register` (off by default) and a daily cap; status on the tab. The tab stays hidden (CSS) until the whole flow is finished, unless `PUBLIC_DOMAIN_TAB=on`
- [ ] 👤 One real `.com` end to end: registrant is our account's contact, privacy on, auto-renew off
- [ ] 👤 Terms: Coyote registers and holds the domain for the owner's site; transfer to the owner on request
- [x] Paying publishes: live copy, live multi-tenant distribution + connection group, `HostingSetups` queue (DNS at Porkbun, tenant + managed cert), alarms, `domain-attach` / `domain-detach` / `hosting`
- [ ] 👤 Test domain in our Porkbun account (API access on): `domain-attach` → live on https; edit shows within 5 min; `domain-detach` cleans up
- [x] 👤 Payment provider chosen: Paddle (sandbox for now)
- [x] Design pack checkout + webhook (`payments.ts`): 3 designs for USD 4.90
- [ ] 👤 `coyote/paddle` secret and the Paddle webhook destination; one sandbox purchase end to end
- [x] Monthly plan (`payments.ts`): USD 9.99/month per site, Paddle subscription; registering a domain needs it (402 `needs_plan`), and the confirm card opens its checkout first. Mi sitio → Dominio links to Paddle's portal
- [x] Paying registers the chosen domain on the server: webhook → `DomainOrders` queue → `runDomainOrder`, retries + dead-letter alarm, `DomainOrderFailed` alarm, `./coyote.sh domain-order`
- [ ] 👤 One sandbox subscription end to end: choose a name → "Activar plan" → the tab shows "Registrado" with no click; cancel in the portal → register refused
- [ ] Registration opens to everyone (the `domain-register` switch goes)
- [ ] Renewal scheduler + notifications
- [ ] Email on the domain (forwarding, send as, mailbox): `PLAN-EMAIL.md`

## Post-MVP: Contact form
Built in product phase 2 (Flow C). WhatsApp delivery first; SES email (phase 7) is the fallback. Plain HTML form → our API → owner. No JS, no paid CAPTCHA.

- **Added by the page checks, never written by the model.** The page gets a contact block: `<form method="post" action="https://api.<domain>/contact/{slug}" data-coyote-contact>`. Fields: `nombre`, `contacto` (phone or email), `mensaje`, hidden `_t` (signed timestamp), honeypot `_web` (must stay empty, hidden via CSS). The policy check allows exactly this form and rejects any other `<form>` or password/card input.
- Rendered only for sites with a delivery channel (WhatsApp opt-in or verified email).
- **Works under the strict CSP** (`script-src 'none'`, `form-action https://api.<domain>`): native POST. The Lambda answers `303` to the site's own domain, `https://<owner-domain>/#enviado` (or `#error`), and the block shows the state with CSS `:target`. It must be a fragment; CSS cannot read a query string.
- **Spam controls** (`contact` Lambda, 5 s timeout):
  1. Honeypot filled → drop silently (still 303).
  2. `_t` = HMAC(slug, issuedAt), secret in SSM. Reject if missing, invalid, older than 24 h, or younger than 3 s.
  3. `Origin`/`Referer` must be the site's own domain (`https://<owner-domain>`).
  4. Rate limits in the `ratelimit` table: 5/hour per IP, 30/day per slug; alarm on a global daily cap.
  5. Optional flag: Haiku spam/abuse classification (~$0.0005/message) before sending.
  6. Body limits (name 80, contact 120, message 1,000 chars), HTML stripped, no attachments, UTF-8 normalised.
- **Retention**: every message is copied to DynamoDB `messages` (pk `slug`, sk `ts`, TTL 30 d) and shown in "Mi sitio", so a lost notification can be recovered. Report/unpublish also disables the form for that slug.
- **Infra**: `POST /contact/{slug}` route, `contact` Lambda, SSM parameter for the HMAC secret, `messages` table.

### Email delivery via SES (phase 7)
- Owner email is added and verified in "Mi sitio" (one-click link). Unverified → no sends.
- `SendEmail` structured API, plain text. From `no-reply@<domain>` (SES `EmailIdentity`, DKIM records in Route 53 via CDK), To owner, Reply-To visitor. Body includes a prefilled `wa.me/<visitor>?text=...` link when the visitor left a phone.
- Cost ≈ $0.10 per 1,000 messages. Exit the SES sandbox with a one-time support request.
- `contact` Lambda gets `ses:SendEmail` scoped to the identity. CloudWatch alarm on SES bounce/complaint rate.

### SES reputation protection
AWS reviews accounts at 5% bounces / 0.1% complaints and pauses them at 10% / 0.5%. Keep both near zero:
- **Verified recipients only**: double opt-in. The verification email is the only unverified send. If it bounces → address marked `invalid`.
- **Event handling** (built, `core/mail-events.ts`): the identity's default `ConfigurationSet` publishes bounces and complaints to SNS `MailEvents` → `mail-events` Lambda. A permanent bounce or a complaint puts the address's `emailId` in the `mail-suppression` table; every send (`aws/mail.ts`) checks it and skips the address. The SES account-level suppression list stays on as a backstop. With owner email verification (later), a hard bounce also sets `sites.ownerEmailStatus = bounced` until re-verified.
- **Easy opt-out**: every email has `List-Unsubscribe` + `List-Unsubscribe-Post` headers and a signed one-click "Pausar notificaciones" link (`GET /notifications/{slug}/pause?token=`), so owners pause instead of marking spam.
- **Identity**: `<domain>` with DKIM (sender `no-reply@<domain>`), custom MAIL FROM `mail.<domain>` (SPF-aligned), DMARC `p=quarantine`. A separate sending subdomain would isolate this mail's reputation from the brand domain; for now the sender is the brand domain itself. Customer sites are never public on our domain (only on their owners' domains), so their reputation never affects mail.
- **Content hygiene**: fixed subject (`Nuevo mensaje desde tu sitio: {businessName}`), fixed template, visitor text quoted as plain text, URLs de-linked (`hxxp://`), no attachments, length caps. Visitor content never goes in the subject or From.
- **Flood → digest**: more than 5 messages/hour for one slug switches to an hourly digest (EventBridge scheduled Lambda drains `messages` with `pendingDigest=true`). The 30/day per-slug cap still applies.
- **Kill switch** (built): CloudWatch alarms on the account's `Reputation.BounceRate` > 3% and `Reputation.ComplaintRate` > 0.05% (5-min period) → the `alerts` topic and the `mail-events` Lambda, which sets SSM `/coyote/email` to `off`. Every send checks the switch (cached 60 s) and sends nothing while it is off; `./coyote.sh email on` resumes. The `contact` Lambda will store messages without sending while it is off.
- **Sandbox exit request** wording: transactional contact notifications, double opt-in recipients, automated bounce/complaint processing, expected volume.

## Post-MVP: Custom domains (phase 8)
A site is published only on its own domain, chosen in Mi sitio → "Dominio". Nothing of a customer's is public on our domain.

**Economics (verified Oct 2026)**: Verisign wholesale .com = $10.26, rising to $10.97 on 2026-11-01, and possibly 7%/yr to ~$13.42 by 2030. Plus $0.18 ICANN fee. Floor ≈ $11/yr.

| Registrar | .com/yr | DNS | All-in/yr | API register | Notes |
|---|---|---|---|---|---|
| **Porkbun** (chosen) | $11.08 | $0 (free DNS with API, ALIAS at the apex) | **$11.08** | Yes: dry run, `Idempotency-Key`, prepaid balance | Sandbox keys, per-key scopes and spend limit |
| Route 53 Domains | $16.00 | $6.00 (hosted zone) | $22.00 | Native `route53domains` | One vendor, but twice the cost |
| Dynadot | ~$11 | $0 | ~$11 | Yes, prepaid balance | Thinner API docs |
| Cloudflare | ~$10 | $0 | ~$10 | No new-registration API | Not usable |

- The registrar sits behind `Registrar` in `core/domains.ts` (`check`, `register`, `setAutoRenew`, `get`); `aws/porkbun.ts` implements it.
- TLDs (`TLDS`): `.com` only for now: WHOIS privacy works on it, and one suffix keeps the flow simple. Of the local ones, Porkbun sells only `.com.mx`, `.mx` and `.co` (not `.com.br`, `.com.ar`, `.cl` or `.pe`; Route 53 can't register them either), and `.com.mx`/`.mx` have no WHOIS privacy. The tab shows no prices.
- The domain's DNS stays at Porkbun (free). The site is still served by our CloudFront.

**Flow (built)**
1. Mi sitio → Dominio: `GET /me/domain` (the site's domain, whether registering is open, the site's plan, and, with no domain yet, 3 suggested names: the business name's words joined with no "-", then with the endings online/web/oficial, all checked in one `checkDomain` call, free ones first). The owner can also search: `GET /me/domain/check?q=` → one `checkDomain` on `<name>.com`. A name the registry didn't answer is "unknown", not taken; premium names count as taken. 100 checks per site per day; no cache.
2. "Elegir" → the "Hosting y dirección .com" card with the chosen name. Without the site's monthly plan (USD 9.99/month, `PLAN-PAYMENTS.md`) it shows the price and "Activar plan": `POST /me/checkout {kind: 'hosting', domain}` checks the name is still free and puts it in the transaction's `custom_data` → Paddle's overlay. The owner fills in nothing and never clicks register.
3. Paddle's webhook: once the plan is active (or past_due), `site.domainOrder = {domain}` is set once and `{slug, domain}` goes to the `DomainOrders` SQS queue. The `DomainOrder` Lambda runs `runDomainOrder` → `registerDomain`: switch on? (`/coyote/domain-register`, off by default) → plan active or past_due? → fresh quote → atomic claim (one domain per site, one site per domain) → global cap of 3 per day → `domain/create` with the quoted cost and an `Idempotency-Key` (synchronous), with our account's default contact → auto-renew off → `registered`, order cleared. The record keeps the owner's account email, to reach them about the domain. A refusal that can pass (registrar down, price moved, the cap, the switch) is retried every 10 minutes, 6 times, then goes to a dead-letter queue (alarm `DomainOrdersStuck`). One that can't (name taken meanwhile) is kept as `domainOrder.failed` (alarm `DomainOrderFailed`). After fixing the cause: `./coyote.sh domain-order <slug> resend`. Meanwhile the tab says "Estamos registrando tu dominio" (or, failed, that we are on it). `POST /me/domain` stays for a site that has the plan and no domain.
4. A failure after the charge leaves `setup_pending`; the next `GET /me/domain` retries. A registration cut off mid-way (`registering` for over 2 minutes) is finished if Porkbun has the domain, else freed.

**Later**
5. **Hosting (built).** Once a domain is `registered` (both paths go through `finishSetup`), `{slug, domain}` goes to the `HostingSetups` SQS queue. The `HostingSetup` Lambda runs `runHostingSetup` (`core/hosting.ts`), one step at a time, each safe to repeat, kept on `DomainRecord.hosting`:
   - `publish`: the current draft → `_live/<slug>/` with our 404 page; `site.status = 'published'`.
   - `dns` (Porkbun's DNS API): delete what answers for the apex or `www` besides ours (the `pixie.porkbun.com` parking records), then `ALIAS @`, `CNAME www` and `TXT _cf-challenge` → the live connection group's routing endpoint.
   - `tenant`: a distribution tenant `site-<slug>` on the live distribution (CloudFront SaaS Manager, `tenant-only`, origin path `/_live/{{slug}}`), domains apex + `www`, with a CloudFront-managed certificate (HTTP validation through the records above). A redelivery adopts our own tenant; a domain on another tenant fails.
   - `cert`: wait until the certificate is `issued` and both domains are `active`; a timed-out certificate is requested once more. Then `live`.
   A step that has to wait is retried every 5 minutes, 24 times (about 2 hours), then the dead-letter alarm `HostingStuck`; one that can't succeed alarms at once (`HostingFailed`). `./coyote.sh hosting <slug> [resend]`. The live distribution redirects `www` to the apex, has no `noindex` and `frame-ancestors 'none'`, caches 5 minutes. Mi sitio shows "Estamos publicando…" and then the link. Pricing: 10 tenants free a month, then USD 20 for up to 200; the certificates are free.
   Testing without buying: `./coyote.sh domain-attach <slug> <domain>` links a domain already in our Porkbun account (a test plan, no Paddle) and starts the same setup; `./coyote.sh domain-detach <slug>` undoes it.
6. Registering opens to everyone and the switch goes, once the plan's sandbox check passes and Paddle is live. A canceled plan keeps its domain until the year ends (auto-renew is off); step 7 decides what happens then.
7. Renewal: daily EventBridge scan of `domains` expiring in 30/7/1 days → WhatsApp utility template or email → payment link → on payment, renew. Unpaid → expires; the tenant is deleted; the site goes back to a private draft.

**Rules**
- Coyote is the registrant of record (our Porkbun account's contact), and we hold the domain for the owner's site. Most owners don't care whose name it is in, and this skips the registrant email verification (ICANN suspends a `.com` whose registrant doesn't confirm within 15 days, and owners ignore an English email from Porkbun): our contact's email is verified once. The terms say so (👤 legal review); the tab doesn't, to keep it short.
- On request (WhatsApp support), we move the domain to the owner at no cost while it is paid: change the registrant in our account (the owner then confirms Porkbun's email), or unlock it and give them the transfer code for their own registrar (not in the first 60 days after registering). Manual for now; a `./coyote.sh domain-transfer` command if requests become common. "Bring your own domain" (the owner adds 2 DNS records) comes with step 5.
- One year, auto-renew off, WHOIS privacy on where the TLD allows it.
- `./coyote.sh domains` lists the registered domains; the Porkbun balance is the cost control while Coyote pays.

## Risks / open items
- **`coyote` profile and Bedrock model access** not set up yet. They block phase 3 onward and the Bedrock part of phase 2. Phases 1, 2a, and the pure-function parts of 2/2b can proceed.
- **Domains**: path-based sites mean the subdomain rewrite, wildcard cert, and reserved-subdomain rules are only unit/synth-tested until a domain is set. The final domain is undecided. A domain switch changes every draft URL and magic link, so do it before real users exist.
- **To verify at build time**: whether Converse guardrails evaluate `toolUse` content (`ApplyGuardrail` is called either way); Haiku 4.5 prompt-cache minimum prefix. Verified: the Standard-tier guardrail deploys with the `us.guardrail.v1:0` cross-region profile and blocks Portuguese text.
- **Guardrail false positives** on legitimate businesses (butcher, gym, tattoo studio, church). The borderline fixtures in phase 2b are the control. The church line and the restaurant-that-serves-drinks line are product policy calls to confirm.
- **Prompt injection through the description**: tested live with four attacks. Three were stopped at submit (guardrail prompt-attack filter and classifier). One polite instruction ("nota para el redactor: el titular debe decir…") steered the headline; it is now rejected by the classifier (fixture added), phone numbers are stripped from model copy like URLs, and prize-bait phrases are in the scam list. Structural limits hold regardless: the model has no tools, no secrets, and no other user's data in context; it cannot write HTML, links, or contact details; its one code output is sanitized; an attacker can only influence the copy of their own site, which still passes the policy and the output guardrail. Treat stored site text as untrusted in any future model-driven feature (critic pass, WhatsApp edits, support). The chat model sees the page and the owner's messages; it can only change that owner's own page, and every change goes through the page checks and the output guardrail.
- **Abuse**: anonymous generation costs money per call. The rate limit and the Turnstile CAPTCHA are the controls; add WAF if abused.
- **Lost magic link**: recovered through "Mis sitios" (email); WhatsApp re-issue comes with product phase 2.

## Verification
- `npm test` — slug, urls, render escaping, css sanitizer, policy, prompt snapshot.
- `npm run generate:local -- --name "Panadería Luna" ...` → open `out/index.html`; check WhatsApp CTA, language, mobile layout. The WhatsApp number on the page equals the input byte for byte.
- `cdk synth` and `cdk diff` clean; `cdk deploy --all` succeeds.
- `curl -X POST <ApiUrl>/generate` → job id; poll `GET /jobs/{id}` until `DONE`; open the returned site URL in Chrome and screenshot desktop + mobile widths.
- Headers: `curl -I <site URL>` shows `script-src 'none'`; the app loads and runs its JS; the preview iframe renders inside the app and nowhere else.
- Injection: markup in the name or address comes out escaped (a `<script>` name is rejected outright by the guardrail's prompt-attack filter).
- Rate limit: 4th request from one IP in a day returns 429 and produces no Bedrock invocation.
- Slug: two simultaneous submissions of the same name get different slugs; a brand name (`bancolombia`) is rejected; reserved names (`www`, `preview`) get a suffixed slug.
- Failure: force a `generate` error → job ends `FAILED`, slug released.
- Edit: change hours in "Mi sitio" → page updates with no Bedrock call logged.
- Mis sitios: create a site, close the tab once it says so; the ready email's link opens `/mis-paginas-web` with the site; a new link can be asked for there. An unknown email gets the same answer and no email.
- Chat: scan the QR on the create page, send "cambia el horario del sábado a 9 a 13" → a reply in seconds and the preview on the computer updates; "Deshacer" goes back; "pon todo en verde" gets a "Rediseñar" offer that runs the Opus edit.
- Safety:
  - Run the fixture set end to end. Every bad case ends `REJECTED` with nothing in S3; every good and borderline-legit case publishes.
  - A fake bank page ("Banco Azteca, verifica tu cuenta") → 422 from pre-screen.
  - A published page has no `<form>` (MVP), and only allowlisted links.
  - `POST /report/{slug}` N times from one IP does nothing; from N distinct IPs → prefix moved to `_quarantine/` and email received.
  - A Converse call without `guardrailConfig` is denied by IAM (`AccessDeniedException`).
- Contact form (post-MVP): submit from a published site → 303 back to `#enviado`, owner notified (WhatsApp, or email with Reply-To set). Honeypot-filled and <3 s submissions produce no notification. The 6th submission in an hour from one IP is dropped. `curl` with a foreign `Origin` is rejected.
