# Model-written sites (design first)

## Context
The fixed themes (about 70 lines each) look outdated. Claude writes much better landing pages when left free, and good design is the core of the product. The new approach: **Claude (Sonnet 5 or Haiku 4.5) writes each site's full HTML and CSS.** When it lacks information, it **asks the business owner follow-up questions, shown as a form**, before it builds the site. The owner gets a **magic URL** where they can see the result and ask for changes in free text.

The project isn't live yet, so **nothing is published in this plan**. There is no public `{slug}/` page, no publish step and no review. Publishing, admin review and the go-live email come in a later plan.

This reverses the rule "the model writes content JSON, never HTML". Safety rests on three things:
1. Contact details and links come from **placeholders that our code fills**.
2. A strict **HTML/CSS sanitizer**.
3. The existing guardrail, pre-screen and policy checks, run on the text pulled out of the page.

## Flow
1. The form is submitted. `submit.ts` runs unchanged: rate limit → brand list → pre-screen → slug claim.
2. The **clarify** step in the `generate` Lambda makes one forced tool call, `plan_site`. It returns either `{ ready: true }` or `{ questions: Question[] }`. When there are questions, the job becomes `NEEDS_INPUT`.
3. The web app renders the questions as a form built by our own code. The owner answers them, or skips with "Generar así". Either way the app calls `POST /jobs/{id}/answers`.
4. The answers are checked (lengths, input guardrail, pre-screen). Then the **write** step makes one forced tool call, `write_site`, which returns `{ html, heroScene? }`. After that: sanitize → check the text → hero image → fill the placeholders → save the draft.
5. The job becomes `DONE` and returns the **magic URL** `/mi-sitio#token=…`. This reuses the existing owner token (`core/token.ts`), now issued when generation ends instead of at publish (`handlers/publish.ts:25-47`). The create page shows the result and the link, with "Guarda este enlace".
6. Only one round of questions is allowed: after the answers, the model has to build.

### Drafts (private, visible only through the magic URL)
- Each version of the site is written to `_draft/{draftId}/`, where `draftId` is a random 128-bit ID. The site record stores `currentDraftId` and keeps the last few versions.
- `cf-rewrite.js` serves `_draft/` (in both domain modes) with a `noindex` header and never serves `{slug}/` for now.
- `_draft/` has no expiry. `_preview/` stops being used.
- Mi sitio calls `GET /me`, which returns the `draftUrl`, and shows it in an iframe at phone and desktop widths. `frame-ancestors` already allows the app.

### Questions (model output shown in our app, so kept strict)
```ts
Question = {
  id: string,                    // [a-z0-9_]{1,30}
  label: string,                 // ≤120 chars, owner's language
  help?: string,                 // ≤160
  type: 'text' | 'textarea' | 'choice' | 'multi' | 'yesno',
  options?: string[],            // 2–6, ≤40 chars each, for choice/multi
}
// max 4 questions; all optional for the owner
```
- **What the model may ask:** only things that change the site, such as services and prices, what makes the business different, hours, the style they like, and delivery or home visits. It must never ask for phone numbers, links, addresses or personal identifiers.
- **Checks on the questions:** labels and options go through `outputAllowed` and `checkContent`. The frontend always escapes them (`textContent`).
- **Answers:** 500 characters max each. They are stored with the site and passed inside the guarded `<answers>` block (`answersBlock`, `prompt.ts:96`).
- **Edits:** they use the same mechanism. If a change request is unclear, the model can ask first.

### Writing the site
- **New `core/site-writer.ts`** makes the `plan_site`, `write_site` and `edit_site` calls through `callTool` (`core/bedrock.ts:63`) and `callWithRetry` (`pipeline.ts:83`). The write and edit calls get maxTokens ≈ 16k.
- **Timeouts:** the generate Lambda gets 10 minutes; the stuck-job cutoff in `jobs.ts:97` goes to 12 minutes.
- **Prompts** (`prompt.ts`). The model is told to:
  - write a modern, mobile-first page that makes the kind and character of the business clear
  - cover the four jobs: who they are, what they do, how to reach them, and where they are (address, a "Cómo llegar" button, hours)
  - write the copy in es-419 or pt-BR
  - follow the placeholder contract
  - use only the allowed tags and CSS, with Google Fonts through `<link>` only
  - draw icons and illustrations as inline SVG
  - add no forms, scripts or external URLs

  `BANNED_PHRASES` stays.
- **Images:** uploaded photos and the logo go to Claude as image blocks, so it designs around them. In the page they appear only as `{{photo:1..3}}` and `{{logo}}`. When there are no photos and `heroScene` is set, `generateHero` (`core/images.ts`) fills `{{hero}}`. If that fails, the element with `{{hero}}` is removed.
- **Placeholders:** `{{whatsapp_url}}`, `{{whatsapp_display}}`, `{{maps_url}}`, `{{address}}`, `{{instagram_url}}`, `{{facebook_url}}`, `{{photo:N}}`, `{{logo}}`, `{{hero}}`. The new `core/fill.ts` fills them:
  - it escapes every value
  - it builds the Maps URL with the logic at `render.ts:43-48`, going through `urls.ts`
  - it appends the platform footer (`render.ts:93`)
- **Stored per site:** the unfilled HTML (the "source") and `site.json` (answers, question answers, contact, media, lang). Filling the source again makes the page with no model call. That covers contact edits and a domain switch (`refill-all` replaces `rerender-all`).

### Sanitizer and checks (`core/sanitize.ts`, extending `policy.ts`)
The document is rebuilt from an allowlist (parsed with htmlparser2):

**HTML**
- **Allowed:** layout and text tags, plus inline SVG (no `foreignObject`, no `<a>`/`<use>` inside SVG, no animation that sets attributes).
- **Forbidden:** `script`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `base`, `meta` (except charset and viewport), and `on*` attributes.
- `<link>` only as a stylesheet on `fonts.googleapis.com`.
- `href` may only be a placeholder or `#anchor`. `src` may only be a placeholder or `data:image/svg+xml`.

**CSS** in `<style>` and `style=` is parsed with css-tree (the same approach as `sanitizeSignatureCss`, `core/css.ts`):
- no `@import` and no `@font-face`
- `url()` only with `data:image/svg+xml` or a placeholder
- size limits

**Text**
- **What's extracted:** visible text, `alt`/`title`/`aria-label`, SVG `<text>`, and CSS `content:`. Hidden text (display:none, opacity 0, font-size 0, off-screen) is rejected.
- **Checks on it:** `checkContent`, a rejection of phone numbers or URLs written into the text, `outputAllowed`, and the banned phrases.

**After filling:** `checkHtml` runs as the final check, and every `wa.me` link must match the owner's number.

**On failure:** one retry with feedback, then REJECTED or FAILED as today.

### Edits in the magic URL (free text)
- Mi sitio gets a "¿Qué quieres cambiar?" textarea and the contact fields. It calls `POST /me/edit { instruction?, contact? }`, which starts an async job:
  - An instruction runs the optional clarify step, then `edit_site` (current source + instruction → new source). The result goes through the same sanitizer and checks, and becomes a new draft.
  - A contact-only change just refills the placeholders.
- Mi sitio polls the job, shows the questions form if the model asks, then reloads the iframe with the new draft. It also offers "Deshacer", which goes back to the previous version.
- `updateContent` and the structured-patch UI (`core/owner.ts:58`, `ContentPatch`) are removed.
- Rate limit: 10 edits per day per site.
- Unpublish, republish and the publish route are removed until the publishing plan. Delete stays.

### Web app (`web/`)
- **`create.ts`:**
  - a new `NEEDS_INPUT` state renders the questions form
  - at `DONE`, it shows the draft and the magic URL instead of "Publicar"
  - copy: "Tarda 1–2 minutos"
- **`my-site.ts`:** draft iframe, edit box, questions form, undo, delete.
- **`strings.ts`:** new es and pt copy. Copy that promises "¡Tu sitio está en línea!" or publishing goes away.

### Infra
- Generate Lambda timeout: 10 minutes.
- Routes:
  - added: `POST /jobs/{id}/answers`, `POST /me/edit`
  - removed: `POST /jobs/{id}/publish`, `POST /me/unpublish`, `POST /me/republish`
- `cf-rewrite.js` changes: serve `_draft/`, stop serving `{slug}/`. Update its tests.
- S3: no lifecycle expiry on `_draft/`.
- IAM for the model follows `modelId` (`generator-api.ts:146-177`). The sites CSP is unchanged.

### Docs
- **PLAN.md:** rewrite Decisions `:14`, Generation `:116`, Content safety `:136`, Design quality `:178`, Site ownership `:233` and Preview `:241`. Add "Phase 5c — Model-written sites" to the tracker, with a 👤 item for the later publishing, review and email plan.
- **PLAN-PHASE2.md:** update Flow B (`:58`).
- **CLAUDE.md:** update the Architecture bullets and the themes convention.
- **README:** document `refill-all`.

## Steps
0. 👤 **Bedrock access for Claude:** the Anthropic use-case form (PLAN.md Phase 0). Everything else is blocked on it.
1. **Offline bake-off:** `site-writer` + sanitizer + fill run through `scripts/local-generate.ts` on 10 fixed businesses (salon, dentist, mini market, hardware store, bakery…), with canned answers to the questions. Run each on both Haiku 4.5 and Sonnet 5, and build a screenshot sheet at mobile and desktop widths (extending `themes:sheet`). **👤 The user picks the model and judges the quality.** Iterate on the prompt until the sites are good.
2. **Sanitizer tests** with hostile fixtures: hidden text, a fake login, a smuggled `wa.me` link, `url()` exfiltration, SVG tricks, meta refresh, injected questions. Then `npm test`.
3. **Pipeline:** clarify → `NEEDS_INPUT` → answers → write → sanitize → fill → draft + magic URL. Update `flows.test.ts` and `pipeline.test.ts`.
4. **Web:** the questions form, the magic-URL page, and the es/pt copy.
5. **Free-text edits** with undo. Update `owner.test.ts`.
6. **Remove publishing** (routes, `{slug}/` serving). Add `refill-all`. Update the docs.
7. **Deploy and live check.**
8. **Cleanup:** delete the themes, the brief, `ModelContent` rendering, `variety.ts` and the theme sheet.

## Verification
- `npm run build`, `npm test` and `npm run synth` (without credentials) pass.
- The hostile fixtures are rejected or neutralized, and the 48 `verify:live` safety fixtures still pass.
- **Live checks:**
  1. From `npm run dev`, submit a vague salon: the questions form appears.
  2. Answer it: the draft reflects the answers, and the magic URL opens Mi sitio with the draft.
  3. Submit a detailed dentist: it goes straight to the draft.
  4. Check that "Generar así" skips the questions.
  5. Check that the WhatsApp and Maps links match the form input.
  6. Check that `{slug}/` returns 404.
  7. In Mi sitio, send "cambia el horario del sábado a 9–13": a new draft shows the change, and "Deshacer" brings back the previous one.
