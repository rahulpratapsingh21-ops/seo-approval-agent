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
- **URL exists (update):** URL kept. Meta title and meta description rewritten from the current content, a new feature image, internal links on exact keywords, image alt text. CTAs: if there is one, none are added (off-topic CTA text is rewritten); if there are none, 2 are added.
- **New URL:** URL created from the content, then meta title, meta description, feature image, CTAs (2, or 3 for long articles) and internal links on exact keywords.
- Internal links: where another published blog's keyword appears word-for-word in the article (max 4, never on the article's own primary keyword).
- Also: competitor links removed, date set to today, a missing writer name filled.
- Feature image (1200×675): campus photo of the college/exam (or a drawn study desk), its logo in a white circle, title on a navy brush stroke, topic + year on a yellow one, course books and a "Results"-style laptop, SYU brand top right. Only the text, logo, photo and book labels change per article.

## Colleges, exams and courses (per silo)
Each silo (overview, admissions, results, …) is checked on its own. It is an **update** when the college/exam/course already has that silo published or live on the website (`/college|exam|course/<overview url>/<silo url>`) — the URL is kept. A **new** silo gets a URL built like published ones (overview: `<name>-cid|eid|mci-<number>`; other silos: the URL other entities use, e.g. `results`).
The fix rewrites the H1 (page display title), meta title and meta description from the current content and sets CTAs by content length (1 under 600 words, 2 under 1,500, else 3; max 3; off-topic CTAs rewritten). Text and videos are never changed.

## Fix and Submit
Every task gets its SEO update prepared on the dashboard. **Fix** makes it again; **Submit** uploads the new feature image, saves the update into the CMS draft and approves. Submit only works when the update passes all checks and the writer hasn't changed the draft since. A check with no failures scores 100; warnings are notes only.

Submit works like the CMS screen: upload image (media + mediaRef) → Start SEO review → Save → Approve by SEO. `DRY_RUN=true` blocks all CMS changes.

## Run locally
```
npm install
cp .env.example .env   # fill in the values
npm start              # http://localhost:3000
```

## Deploy
`render.yaml` sets up a Render web service. Add the secret values from `.env.example` in the Render dashboard.
