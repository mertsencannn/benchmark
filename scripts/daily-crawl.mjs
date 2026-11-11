#!/usr/bin/env node
/**
 * Headless daily PDP crawl for benchmark sources.
 * Usage: node scripts/daily-crawl.mjs YYYY-MM-DD
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SOURCES = [
  {
    id: "lazada-supermarket",
    url: "https://www.lazada.com.ph/tag/supermarket/?spm=a2o4l.homepage.search.d_go&q=supermarket&catalog_redirect_tag=true",
    linkPattern: /lazada\.com\.ph\/products\//i,
  },
  {
    id: "lazada-tshirt",
    url: "https://www.lazada.com.ph/tag/tshirt/?q=tshirt&catalog_redirect_tag=true",
    linkPattern: /lazada\.com\.ph\/products\//i,
  },
  {
    id: "allegro-tshirt",
    url: "https://allegro.pl/listing?string=tshirt",
    linkPattern: /allegro\.pl\/oferta\//i,
  },
];

const MAX_PDP = 15;

function todayArg() {
  return process.argv[2] || new Date().toISOString().slice(0, 10);
}

async function collectLinks(page, pattern) {
  return page.evaluate((reSource) => {
    const re = new RegExp(reSource, "i");
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      let href = a.href || a.getAttribute("href") || "";
      if (href.startsWith("//")) href = "https:" + href;
      if (!re.test(href)) continue;
      const clean = href.split("?")[0];
      if (seen.has(clean)) continue;
      seen.add(clean);
      const title =
        a.getAttribute("title") ||
        a.querySelector("img")?.alt ||
        a.textContent?.trim().slice(0, 200) ||
        "";
      out.push({ url: clean, title });
      if (out.length >= 20) break;
    }
    return out;
  }, pattern.source);
}

async function pageBlockers(page) {
  const url = page.url();
  const title = await page.title();
  const bodySnippet = await page
    .evaluate(() => document.body?.innerText?.slice(0, 800) || "")
    .catch(() => "");
  const lower = (url + title + bodySnippet).toLowerCase();
  if (
    lower.includes("captcha") ||
    lower.includes("recaptcha") ||
    lower.includes("punish") ||
    lower.includes("robot") ||
    lower.includes("access denied") ||
    lower.includes("403") ||
    lower.includes("blocked") ||
    lower.includes("verify you are human")
  ) {
    return { blocked: true, reason: `blocker signals in page (${title || url})` };
  }
  return { blocked: false };
}

async function crawlSource(browser, date, source) {
  const dir = path.join(REPO_ROOT, "screenshots", date, source.id);
  fs.mkdirSync(dir, { recursive: true });
  const result = {
    id: source.id,
    listingUrl: source.url,
    listingScreenshot: null,
    blockers: [],
    pdps: [],
  };

  const context = await browser.newContext({
    locale: source.id.startsWith("allegro") ? "pl-PL" : "en-PH",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    const resp = await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    if (resp && resp.status() >= 400) {
      result.blockers.push(`HTTP ${resp.status()} on listing`);
    }
    await page.waitForTimeout(3000);
    const listBlock = await pageBlockers(page);
    if (listBlock.blocked) result.blockers.push(listBlock.reason);

    const listingPath = path.join(dir, "listing.png");
    await page.screenshot({ path: listingPath, fullPage: true });
    result.listingScreenshot = listingPath;

    let links = [];
    try {
      links = await collectLinks(page, source.linkPattern);
    } catch (e) {
      result.blockers.push(`link extraction failed: ${e.message}`);
    }

    if (links.length === 0) {
      result.blockers.push("no product links found on listing");
    }

    for (let i = 0; i < Math.min(links.length, MAX_PDP); i++) {
      const { url, title: listTitle } = links[i];
      const idx = String(i + 1).padStart(2, "0");
      const pdpPath = path.join(dir, `pdp-${idx}.png`);
      const metaPath = path.join(dir, `pdp-${idx}.json`);
      try {
        const pdpResp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        await page.waitForTimeout(2000);
        const pdpBlock = await pageBlockers(page);
        const status = pdpResp?.status();
        const pdpTitle = await page.title().catch(() => listTitle);
        await page.screenshot({ path: pdpPath, fullPage: true });
        const entry = {
          index: i + 1,
          url,
          title: pdpTitle,
          listTitle,
          httpStatus: status ?? null,
          blocked: pdpBlock.blocked,
        };
        fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));
        result.pdps.push(entry);
        if (pdpBlock.blocked) result.blockers.push(`PDP ${idx}: ${pdpBlock.reason}`);
      } catch (e) {
        result.blockers.push(`PDP ${idx} (${url}): ${e.message}`);
        result.pdps.push({ index: i + 1, url, error: e.message });
      }
    }
  } catch (e) {
    result.blockers.push(`listing crawl failed: ${e.message}`);
  } finally {
    await context.close();
  }

  fs.writeFileSync(
    path.join(dir, "crawl-meta.json"),
    JSON.stringify(result, null, 2)
  );
  return result;
}

async function main() {
  const date = todayArg();
  console.log(`Crawl date: ${date}`);

  const browser = await chromium.launch({ headless: true });
  const summary = [];
  try {
    for (const source of SOURCES) {
      console.log(`\n=== ${source.id} ===`);
      const r = await crawlSource(browser, date, source);
      summary.push(r);
      console.log(
        `PDPs: ${r.pdps.length}, blockers: ${r.blockers.length}`,
        r.blockers.slice(0, 3)
      );
    }
  } finally {
    await browser.close();
  }

  const outPath = path.join(REPO_ROOT, "screenshots", date, "crawl-summary.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ date, summary }, null, 2));
  console.log("\nWrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
