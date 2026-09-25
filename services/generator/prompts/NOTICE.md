# Notice

`design-guide.md` is the design guide in the system prompt of the `write_site` and `edit_site` calls (`src/core/prompt.ts`). It is built from:

- Anthropic's `frontend-design` skill (https://github.com/anthropics/skills), licensed under the Apache License 2.0 (`LICENSE.txt` in this folder). **We changed it**: rewritten for one-page small-business sites generated without JavaScript (CSS-only motion, used sparingly; bold or calm depending on the business; creativity in the hero and decoration while the key sections stay easy to scan), and the parts about React, frameworks, and dashboards removed.
- A subset of Vercel's Web Interface Guidelines (https://github.com/vercel-labs/web-interface-guidelines), MIT License, Copyright (c) Vercel, Inc.
- Coyote's own rules for small-business pages (mobile first, the four jobs, WhatsApp always in reach, "Cómo llegar", hours).

Judge any change to the guide on the screenshot sheet (`npm run sites:sheet`).
