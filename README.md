# SEO Approval Agent

Checks SYU CMS subtasks in **Ready For SEO Review** (blogs, colleges, exams, courses), approves the ones that pass, and auto-fixes failed blogs with Claude.

## What it checks
- CTA boxes linking to the SYU leads form (2–3, where that page type uses CTAs)
- Meta title, meta description, primary keyword use, H1/H2 structure, URL slug
- Word count against similar published pages (learnt per content type and tab)
- Image alt text and hero image (blogs only)
- Internal links, empty links, competitor links
- Date is today, writer name is set (blogs)

## New page or update?
A task is an **update** when its parent task has `updateData` set or its URL is already live on the website (blog, college, exam or course). Update tasks never get a new URL.

## Blog process
Never changes the article body text. The H1 is rewritten from the content in both cases (update and new).
- **URL exists (update):** URL kept. Meta title and meta description rewritten from the current content, a new feature image, internal links on exact keywords, image alt text. CTAs: existing ones stay (off-topic text is rewritten); one is added after the intro if missing; if there are none, 2 are added.
- **New URL:** URL created from the content, then meta title, meta description, feature image, CTAs (2, or 3 for long articles) and internal links on exact keywords.
- Internal links, only when the article has fewer than 4: keyword phrases found word-for-word (another blog's keyword, or Claude's anchor copied from the text; never a website address or the article's own keyword). If that still leaves fewer than 3, "👉 Also Read: <related title>" lines go before later sections.
- CTA placement: after the intro text (after any "👉 … Direct Link" line, never above the intro), before a middle section, before the FAQs — max 3, at least 150 words of text between CTAs. A CTA always goes after a link line, never before it; a heading that is only a link counts as a text line. CTA lines without the lead-form link become CTA boxes; CTAs under a heading or inside the FAQs are moved; CTAs too close together are thinned and re-placed.
- Also: competitor links removed, date set to today, a missing writer name filled.
- Feature image (1200×675): campus photo of the college/exam (or a drawn study desk), its logo in a white circle, title on a navy brush stroke, topic + year on a yellow one, course books and a "Results"-style laptop, SYU brand top right. Only the text, logo, photo and book labels change per article.

## Colleges, exams and courses (per silo)
Each silo (overview, admissions, results, …) is checked on its own. It is an **update** when the college/exam/course already has that silo published or live on the website (`/college|exam|course/<overview url>/<silo url>`) — the URL is kept. A **new** silo gets a URL built like published ones (overview: `<name>-cid|eid|mci-<number>`; other silos: the URL other entities use, e.g. `results`).
The fix rewrites the H1 (page display title), meta title and meta description from the current content and sets CTAs by content length (1 under 600 words, 2 under 1,500, else 3; max 3; off-topic CTAs rewritten). Text and videos are never changed.

## Approval
**Auto-approve (on by default, switch on the dashboard):** during each run, an update that passes every check is saved in the CMS and approved straight away — no click needed. Updates that still fail a check wait on the dashboard: **Fix** makes the update again, **Submit** saves and approves it. Submit only works when the update passes and the writer hasn't changed the draft since. A check with no failures scores 100; warnings are notes only.

Approval works like the CMS screen: upload image (media + mediaRef) → Start SEO review → Save → Approve by SEO. `DRY_RUN=true` blocks all CMS changes.

## Run locally
```
npm install
cp .env.example .env   # fill in the values
npm start              # http://localhost:3000
```

## Deploy
`render.yaml` sets up a Render web service. Add the secret values from `.env.example` in the Render dashboard.
