import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const DATE = process.env.CRAWL_DATE || '2026-11-10';
const ROOT = path.join(process.cwd(), 'screenshots', DATE);

const SOURCES = [
  {
    key: 'lazada-supermarket',
    listingUrl:
      'https://www.lazada.com.ph/tag/supermarket/?spm=a2o4l.homepage.search.d_go&q=supermarket&catalog_redirect_tag=true',
    productLinkFilter: (href) =>
      href.includes('lazada.com.ph/products/'),
    normalize: (href) => href.split('?')[0],
    selector: 'a[href*="/products/"]',
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
  },
  {
    key: 'lazada-tshirt',
    listingUrl:
      'https://www.lazada.com.ph/tag/tshirt/?q=tshirt&catalog_redirect_tag=true',
    productLinkFilter: (href) =>
      href.includes('lazada.com.ph/products/'),
    normalize: (href) => href.split('?')[0],
    selector: 'a[href*="/products/"]',
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
  },
  {
    key: 'allegro-tshirt',
    listingUrl: 'https://allegro.pl/listing?string=tshirt',
    productLinkFilter: (href) => href.includes('allegro.pl/oferta/'),
    normalize: (href) => href.split('?')[0],
    selector: 'a[href*="/oferta/"]',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  },
];

async function dismissOverlays(page) {
  const sels = [
    'button:has-text("Akceptuję")',
    'button:has-text("OK")',
    'button:has-text("Accept")',
    '[data-testid="accept-home-view-button"]',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
      await el.click().catch(() => {});
    }
  }
}

async function extractProducts(page, source) {
  return page.evaluate(
    ({ selector, productLinkFilter }) => {
      const anchors = Array.from(document.querySelectorAll(selector));
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        let href = a.href;
        if (!href || !productLinkFilter(href)) continue;
        href = href.split('?')[0];
        if (seen.has(href)) continue;
        seen.add(href);
        const title = (a.getAttribute('title') || a.innerText || '')
          .trim()
          .split('\n')[0]
          .slice(0, 200);
        out.push({ url: href, title });
        if (out.length >= 15) break;
      }
      return out;
    },
    {
      selector: source.selector,
      productLinkFilter: source.productLinkFilter.toString(),
    }
  );
}

// evaluate can't take functions — inline per source instead
async function extractProductsFixed(page, source) {
  return page.evaluate(
    ({ selector, hostPart }) => {
      const anchors = Array.from(document.querySelectorAll(selector));
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        let href = a.href;
        if (!href || !href.includes(hostPart)) continue;
        href = href.split('?')[0];
        if (seen.has(href)) continue;
        seen.add(href);
        const title = (a.getAttribute('title') || a.innerText || '')
          .trim()
          .split('\n')[0]
          .slice(0, 200);
        out.push({ url: href, title });
        if (out.length >= 15) break;
      }
      return out;
    },
    {
      selector: source.selector,
      hostPart:
        source.key === 'allegro-tshirt'
          ? 'allegro.pl/oferta/'
          : 'lazada.com.ph/products/',
    }
  );
}

async function crawlSource(browser, source) {
  const outDir = path.join(ROOT, source.key);
  fs.mkdirSync(outDir, { recursive: true });
  const context = await browser.newContext({
    locale: source.locale,
    timezoneId: source.timezoneId,
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': source.locale,
    },
  });
  const page = await context.newPage();
  const result = {
    key: source.key,
    listingUrl: source.listingUrl,
    finalListingUrl: null,
    listingTitle: null,
    blocker: null,
    products: [],
  };

  try {
    const resp = await page.goto(source.listingUrl, {
      waitUntil: 'networkidle',
      timeout: 120000,
    });
    result.httpStatus = resp?.status();
    await page.waitForTimeout(5000);
    await dismissOverlays(page);
    result.finalListingUrl = page.url();
    result.listingTitle = await page.title();
    if (
      /punish|recaptcha|blocked|captcha/i.test(page.url()) ||
      /blocked/i.test(result.listingTitle)
    ) {
      result.blocker = `Bot wall at listing (${result.finalListingUrl})`;
    }
    await page.screenshot({
      path: path.join(outDir, 'listing.png'),
      fullPage: true,
    });

    const urls = await extractProductsFixed(page, source);
    if (urls.length === 0 && !result.blocker) {
      result.blocker = 'No product links found on listing (empty or changed DOM)';
    }

    for (let i = 0; i < urls.length; i++) {
      const { url, title } = urls[i];
      const idx = String(i + 1).padStart(2, '0');
      const row = { index: i + 1, url, listTitle: title };
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
        await page.waitForTimeout(2500);
        await dismissOverlays(page);
        row.pdpTitle = await page.title();
        row.finalUrl = page.url();
        if (/punish|recaptcha|blocked|captcha/i.test(page.url())) {
          row.blocker = 'Bot wall on PDP';
        }
        await page.screenshot({
          path: path.join(outDir, `pdp-${idx}.png`),
          fullPage: true,
        });
      } catch (e) {
        row.error = String(e.message || e);
      }
      result.products.push(row);
    }
  } catch (e) {
    result.blocker = String(e.message || e);
    await page.screenshot({
      path: path.join(outDir, 'listing.png'),
      fullPage: true,
    }).catch(() => {});
  }

  fs.writeFileSync(
    path.join(outDir, 'products.json'),
    JSON.stringify(
      { crawledAt: new Date().toISOString(), ...result },
      null,
      2
    )
  );
  await context.close();
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const summary = [];
  for (const source of SOURCES) {
    console.log('Crawling', source.key);
    summary.push(await crawlSource(browser, source));
  }
  await browser.close();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
