import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const DATE = process.env.CRAWL_DATE || new Date().toISOString().slice(0, 10);
const LIMIT = 15;

const SOURCES = [
  {
    id: 'lazada-supermarket',
    listingUrl:
      'https://www.lazada.com.ph/tag/supermarket/?spm=a2o4l.homepage.search.d_go&q=supermarket&catalog_redirect_tag=true',
    collectLinks: async (page) => {
      return page.$$eval('a[href*="-i"]', (as) => {
        const seen = new Set();
        const out = [];
        for (const a of as) {
          let href = a.href;
          if (!href || seen.has(href)) continue;
          if (!/\/products\//.test(href) && !/-i\d+/.test(href)) continue;
          seen.add(href);
          const title =
            a.getAttribute('title') ||
            a.querySelector('[class*="title"]')?.textContent?.trim() ||
            a.textContent?.trim()?.slice(0, 120) ||
            '';
          out.push({ url: href.split('?')[0], title });
          if (out.length >= LIMIT) break;
        }
        return out;
      });
    },
  },
  {
    id: 'lazada-tshirt',
    listingUrl:
      'https://www.lazada.com.ph/tag/tshirt/?q=tshirt&catalog_redirect_tag=true',
    collectLinks: async (page) => {
      return page.$$eval('a[href*="-i"]', (as) => {
        const seen = new Set();
        const out = [];
        for (const a of as) {
          let href = a.href;
          if (!href || seen.has(href)) continue;
          if (!/\/products\//.test(href) && !/-i\d+/.test(href)) continue;
          seen.add(href);
          const title =
            a.getAttribute('title') ||
            a.querySelector('[class*="title"]')?.textContent?.trim() ||
            a.textContent?.trim()?.slice(0, 120) ||
            '';
          out.push({ url: href.split('?')[0], title });
          if (out.length >= LIMIT) break;
        }
        return out;
      });
    },
  },
  {
    id: 'allegro-tshirt',
    listingUrl: 'https://allegro.pl/listing?string=tshirt',
    collectLinks: async (page) => {
      return page.$$eval('a[href*="/oferta/"]', (as) => {
        const seen = new Set();
        const out = [];
        for (const a of as) {
          const href = a.href?.split('?')[0];
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const title = a.getAttribute('title') || a.textContent?.trim()?.slice(0, 120) || '';
          out.push({ url: href, title });
          if (out.length >= LIMIT) break;
        }
        return out;
      });
    },
  },
];

function outDir(marketplace) {
  return path.join(REPO, 'screenshots', DATE, marketplace);
}

async function detectBlockers(page) {
  const url = page.url();
  const title = await page.title();
  const bodyText = await page
    .locator('body')
    .innerText({ timeout: 5000 })
    .catch(() => '');
  const flags = [];
  if (/captcha|recaptcha|punish|verify/i.test(url + bodyText)) flags.push('captcha_or_punish');
  if (/403|blocked|access denied|nie jesteś robotem|robot/i.test(bodyText)) flags.push('bot_wall');
  if (/slider|captcha-dialog|nc_1_n1z/i.test(bodyText)) flags.push('slider_captcha');
  return { url, title, flags, bodySnippet: bodyText.slice(0, 500) };
}

async function crawlSource(browser, source) {
  const dir = outDir(source.id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { marketplace: source.id, listingUrl: source.listingUrl, products: [], blockers: null };

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: source.id.startsWith('allegro') ? 'pl-PL' : 'en-PH',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(source.listingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    meta.blockers = await detectBlockers(page);
    await page.screenshot({
      path: path.join(dir, 'listing.png'),
      fullPage: true,
      timeout: 120000,
    });

    let links = [];
    try {
      links = await source.collectLinks(page);
    } catch (e) {
      meta.linkError = String(e);
    }

    for (let i = 0; i < links.length && i < LIMIT; i++) {
      const { url, title } = links[i];
      const pdpPage = await context.newPage();
      try {
        await pdpPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await pdpPage.waitForTimeout(2000);
        const num = String(i + 1).padStart(2, '0');
        await pdpPage.screenshot({
          path: path.join(dir, `pdp-${num}.png`),
          fullPage: true,
          timeout: 120000,
        });
        const blocker = await detectBlockers(pdpPage);
        meta.products.push({ index: i + 1, url, title, blockers: blocker.flags });
      } catch (e) {
        meta.products.push({ index: i + 1, url, title, error: String(e) });
      } finally {
        await pdpPage.close();
      }
    }

    fs.writeFileSync(path.join(dir, 'listing.json'), JSON.stringify(meta, null, 2));
  } catch (e) {
    meta.fatalError = String(e);
    fs.writeFileSync(path.join(dir, 'listing.json'), JSON.stringify(meta, null, 2));
    try {
      await page.screenshot({ path: path.join(dir, 'listing.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
  }
  return meta;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = {};
  for (const source of SOURCES) {
    console.log(`Crawling ${source.id}...`);
    results[source.id] = await crawlSource(browser, source);
    console.log(JSON.stringify(results[source.id], null, 2));
  }
  await browser.close();
  fs.writeFileSync(
    path.join(REPO, 'screenshots', DATE, 'crawl-summary.json'),
    JSON.stringify(results, null, 2)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
