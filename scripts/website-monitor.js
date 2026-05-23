const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE_URL = process.env.WEBSITE_URL || "https://sameer-local-azure.sameersaurabh.xyz";
const REPORT_DIR = process.env.REPORT_DIR || path.join(process.cwd(), "reports");
const TIME_ZONE = process.env.REPORT_TIMEZONE || "Asia/Kolkata";
const VIEWPORT_DESKTOP = { width: 1440, height: 900 };
const VIEWPORT_MOBILE = { width: 390, height: 844 };

function nowParts() {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(now);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return { now, local, stamp };
}

function cleanText(value, max = 500) {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function routeStatus(page, route) {
  const started = Date.now();
  const response = await page.goto(`${BASE_URL}${route}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1000);
  return {
    route,
    status: response ? response.status() : null,
    ms: Date.now() - started,
    title: await page.title(),
    bodySample: cleanText(await page.locator("body").innerText().catch(() => ""), 260),
  };
}

async function collectFeedState(page, label) {
  return page.evaluate((label) => {
    const eventLinks = [...document.querySelectorAll('a[href*="/event/"]')];
    const cards = eventLinks.map((a) => {
      const text = a.innerText.replace(/\s+/g, " ").trim();
      return {
        href: a.href,
        text: text.slice(0, 380),
        isNse: /^NSE\b|\bNSE-/.test(text) || text.includes("NSE-equities") || text.includes("NSE-sme"),
      };
    });
    const cls = (window.__layoutShiftEntries || [])
      .filter((entry) => !entry.hadRecentInput)
      .reduce((sum, entry) => sum + entry.value, 0);
    const longTasks = window.__longTasks || [];
    const nav = performance.getEntriesByType("navigation")[0];

    return {
      label,
      statusText: document.body.innerText.match(/\b(LIVE|DISCONNECTED)\b/)?.[1] || null,
      eventCount: Number(document.body.innerText.match(/(\d+)\s+events/)?.[1] || 0),
      eventLinkCount: eventLinks.length,
      nseEventCount: cards.filter((card) => card.isNse).length,
      nonNseVisibleCount: cards.filter((card) => !card.isNse).length,
      newestNse: cards.find((card) => card.isNse) || null,
      buttons: [...document.querySelectorAll("button")].map((button) => ({
        text: button.innerText.trim(),
        title: button.title || "",
        ariaLabel: button.getAttribute("aria-label") || "",
      })),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      cls,
      longTaskCount: longTasks.length,
      maxLongTaskMs: longTasks.length ? Math.round(Math.max(...longTasks.map((task) => task.duration))) : 0,
      navigation: nav
        ? {
            domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
            loadEventMs: Math.round(nav.loadEventEnd),
            responseEndMs: Math.round(nav.responseEnd),
            transferSize: nav.transferSize,
            encodedBodySize: nav.encodedBodySize,
            decodedBodySize: nav.decodedBodySize,
          }
        : null,
    };
  }, label);
}

async function installPerformanceObservers(page) {
  await page.evaluate(() => {
    window.__layoutShiftEntries = [];
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        window.__layoutShiftEntries.push(
          ...list.getEntries().map((entry) => ({
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
          })),
        );
      }).observe({ type: "layout-shift", buffered: true });
    } catch (_) {}
    try {
      new PerformanceObserver((list) => {
        window.__longTasks.push(
          ...list.getEntries().map((entry) => ({
            duration: entry.duration,
            startTime: entry.startTime,
          })),
        );
      }).observe({ type: "longtask", buffered: true });
    } catch (_) {}
  });
}

function classifyFailures(failures) {
  return {
    expectedAbortions: failures.filter((failure) => failure.error.includes("ERR_ABORTED")),
    realFailures: failures.filter((failure) => !failure.error.includes("ERR_ABORTED")),
  };
}

function verdict(report) {
  const issues = [];
  if (report.feed.initial.statusText !== "LIVE") issues.push(`Feed status is ${report.feed.initial.statusText || "unknown"}, expected LIVE.`);
  if (!report.feed.initial.eventLinkCount) issues.push("Live feed rendered no event links.");
  if (!report.feed.initial.nseEventCount) issues.push("No NSE events were visible in the live feed.");
  if (!report.feed.nseFilter.eventLinkCount) issues.push("NSE filter rendered no event links.");
  if (report.feed.nseFilter.nonNseVisibleCount > 0) issues.push(`NSE filter left ${report.feed.nseFilter.nonNseVisibleCount} non-NSE event(s) visible.`);
  if (report.feed.nseFilter.cls > 0.1) issues.push(`High layout shift after NSE filtering: ${report.feed.nseFilter.cls.toFixed(3)}.`);
  if (report.mobile.firstEventWidth && report.mobile.firstEventWidth < 180) issues.push(`Mobile NSE/feed card width is only ${report.mobile.firstEventWidth}px, so rendering is squeezed.`);
  if (report.mobile.horizontalOverflow) issues.push("Mobile viewport has horizontal overflow.");
  if (report.consoleIssues.length) issues.push(`${report.consoleIssues.length} console warning/error(s) detected.`);
  if (report.network.realFailures.length) issues.push(`${report.network.realFailures.length} real network request failure(s) detected.`);
  if (report.adminPublic) issues.push("/admin is publicly accessible.");
  return issues.length ? { status: "ISSUES FOUND", issues } : { status: "PASS", issues: [] };
}

function markdownReport(report) {
  const lines = [];
  lines.push(`# Website Monitor Report`);
  lines.push("");
  lines.push(`- Run time: ${report.run.local} (${TIME_ZONE})`);
  lines.push(`- URL: ${BASE_URL}`);
  lines.push(`- Verdict: ${report.verdict.status}`);
  lines.push("");
  lines.push(`## Route Checks`);
  for (const route of report.routes) {
    lines.push(`- ${route.route}: HTTP ${route.status}, ${route.ms}ms`);
  }
  lines.push("");
  lines.push(`## Live Feed`);
  lines.push(`- Status: ${report.feed.initial.statusText || "unknown"}`);
  lines.push(`- Total events: ${report.feed.initial.eventCount}`);
  lines.push(`- Visible NSE events: ${report.feed.initial.nseEventCount}`);
  lines.push(`- NSE filter events: ${report.feed.nseFilter.eventLinkCount}`);
  lines.push(`- NSE filter settle time: ${report.feed.nseFilter.settleMs}ms`);
  lines.push(`- Non-NSE visible after NSE filter: ${report.feed.nseFilter.nonNseVisibleCount}`);
  lines.push(`- Newest NSE: ${report.feed.initial.newestNse ? report.feed.initial.newestNse.text : "none"}`);
  lines.push("");
  lines.push(`## Performance And Stability`);
  lines.push(`- DOMContentLoaded: ${report.feed.initial.navigation?.domContentLoadedMs ?? "n/a"}ms`);
  lines.push(`- Load event: ${report.feed.initial.navigation?.loadEventMs ?? "n/a"}ms`);
  lines.push(`- CLS after NSE filter: ${report.feed.nseFilter.cls.toFixed(4)}`);
  lines.push(`- Long tasks: ${report.feed.nseFilter.longTaskCount}, max ${report.feed.nseFilter.maxLongTaskMs}ms`);
  lines.push(`- Mobile first event width: ${report.mobile.firstEventWidth || "n/a"}px`);
  lines.push("");
  lines.push(`## Network And Console`);
  lines.push(`- Console issues: ${report.consoleIssues.length}`);
  lines.push(`- Expected aborted prefetch/stream requests: ${report.network.expectedAbortions.length}`);
  lines.push(`- Real request failures: ${report.network.realFailures.length}`);
  lines.push("");
  lines.push(`## Security/Access`);
  lines.push(`- /admin publicly accessible: ${report.adminPublic ? "yes" : "no"}`);
  lines.push("");
  lines.push(`## Issues`);
  if (report.verdict.issues.length) {
    for (const issue of report.verdict.issues) lines.push(`- ${issue}`);
  } else {
    lines.push("- None detected in this run.");
  }
  lines.push("");
  lines.push(`## Event Detail`);
  lines.push(report.eventDetail ? `- ${report.eventDetail.url}: HTTP/render OK in ${report.eventDetail.loadMs}ms` : "- No event detail page tested.");
  return lines.join("\n");
}

(async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const run = nowParts();
  const consoleIssues = [];
  const failures = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT_DESKTOP });
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) consoleIssues.push({ type: msg.type(), text: msg.text() });
  });
  page.on("requestfailed", (request) => {
    failures.push({
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText || "failed",
    });
  });

  const routes = [];
  for (const route of ["/", "/settings", "/monitoring", "/admin"]) {
    routes.push(await routeStatus(page, route));
  }

  const adminPublic = routes.find((route) => route.route === "/admin")?.status === 200;

  const feedStarted = Date.now();
  await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 30000 });
  await installPerformanceObservers(page);
  await page.waitForTimeout(5000);
  const initial = await collectFeedState(page, "initial");

  const nseClickStarted = Date.now();
  await page.getByRole("button", { name: /NSE/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const nseFilter = await collectFeedState(page, "nse filter");
  nseFilter.settleMs = Date.now() - nseClickStarted;
  initial.feedLoadMs = Date.now() - feedStarted;

  let eventDetail = null;
  const firstNseHref = initial.newestNse?.href || nseFilter.newestNse?.href;
  if (firstNseHref) {
    const detailStarted = Date.now();
    const response = await page.goto(firstNseHref, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1000);
    eventDetail = {
      url: page.url(),
      status: response ? response.status() : null,
      loadMs: Date.now() - detailStarted,
      bodySample: cleanText(await page.locator("body").innerText().catch(() => ""), 300),
    };
  }

  const mobilePage = await browser.newPage({ viewport: VIEWPORT_MOBILE, isMobile: true });
  await mobilePage.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 30000 });
  await mobilePage.waitForTimeout(3000);
  const screenshotPath = path.join(REPORT_DIR, `mobile-${run.stamp}.png`);
  await mobilePage.screenshot({ path: screenshotPath, fullPage: true });
  const mobile = await mobilePage.evaluate((screenshotPath) => {
    const first = document.querySelector('a[href*="/event/"]');
    const rect = first ? first.getBoundingClientRect() : null;
    return {
      eventLinkCount: document.querySelectorAll('a[href*="/event/"]').length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      firstEventWidth: rect ? Math.round(rect.width) : null,
      bodySample: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 300),
      screenshotPath,
    };
  }, screenshotPath);

  await browser.close();

  const network = classifyFailures(failures);
  const report = {
    run,
    baseUrl: BASE_URL,
    routes,
    adminPublic,
    feed: { initial, nseFilter },
    eventDetail,
    mobile,
    consoleIssues,
    network,
  };
  report.verdict = verdict(report);

  const jsonPath = path.join(REPORT_DIR, `report-${run.stamp}.json`);
  const mdPath = path.join(REPORT_DIR, `report-${run.stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownReport(report));

  console.log(markdownReport(report));
  console.log(`\nSaved report files:\n- ${mdPath}\n- ${jsonPath}\n- ${screenshotPath}`);

  if (process.env.FAIL_ON_ISSUES === "true" && report.verdict.issues.length) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
