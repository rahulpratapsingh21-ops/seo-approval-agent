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

## What auto-fix does (blogs)
Never changes the article text or H1. Rewrites meta title and meta description; sets the URL only for new pages; adds internal links and image alt text; adds CTAs when there are fewer than 2 and rewrites CTAs that don't match the title (on-topic CTAs are left alone); removes competitor links; sets the date to today and fills a missing writer name; creates a branded feature image when there is no hero image. Fixes appear on the dashboard to copy into the CMS (or are saved directly when `SAVE_FIXES=true`).

## Run locally
```
npm install
cp .env.example .env   # fill in the values
npm start              # http://localhost:3000
```

## Deploy
`render.yaml` sets up a Render web service. Add the secret values from `.env.example` in the Render dashboard.
