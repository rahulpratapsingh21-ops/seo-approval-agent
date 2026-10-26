// Quick test: node src/cli.js <live blog URL>
import * as cheerio from 'cheerio';
import { runChecks, reviewMessage } from './checks.js';

const url = process.argv[2];
if (!url) { console.log('Usage: node src/cli.js <blog url>'); process.exit(1); }

const html = await (await fetch(url)).text();
const $ = cheerio.load(html);
// Article body = the element holding the most editor paragraphs.
let body = null, best = 0;
$('.editor-paragraph').parent().each((_, el) => {
  const n = $(el).children('.editor-paragraph').length;
  if (n > best) { best = n; body = el; }
});
const page = {
  title: $('h1').first().text().trim(),
  metaTitle: $('title').text().trim(),
  metaDescription: $('meta[name="description"]').attr('content') || '',
  primaryKeywords: process.argv[3] || $('h1').first().text().split(/[:–-]/)[0].trim(),
  pageUrl: new URL(url).pathname,
  html: body ? $.html(body) : '',
};
const result = runChecks(page);
console.log(reviewMessage(result));
console.log(`\nCTA boxes: ${result.ctaCount}, words: ${result.words}, verdict: ${result.status.toUpperCase()}`);
