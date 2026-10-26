# SEO Approval Agent

Checks SYU CMS subtasks in **Ready For SEO Review** (blogs, colleges, exams, courses), approves the ones that pass, and auto-fixes failed blogs with Claude.

## What it checks
- CTA boxes linking to the SYU leads form (2–3, where that page type uses CTAs)
- Meta title, meta description, primary keyword use, H1/H2 structure, URL slug
- Word count against similar published pages (learnt per content type and tab)
- Image alt text and hero image (blogs only)
- Internal links, empty links, competitor links

## What auto-fix does (blogs)
Rewrites meta title, meta description, URL and H1; adds CTAs, internal links and image alt text; removes competitor links; creates a branded feature image. Fixes appear on the dashboard to copy into the CMS (or are saved directly when `SAVE_FIXES=true`).

## Run locally
```
npm install
cp .env.example .env   # fill in the values
npm start              # http://localhost:3000
```

## Deploy
`render.yaml` sets up a Render web service. Add the secret values from `.env.example` in the Render dashboard.
