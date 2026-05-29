const fs = require("fs");
const path = require("path");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://sameer-local-azure.sameersaurabh.xyz/";
const REPORT_DIR = process.env.UPTIME_REPORT_DIR || path.join(process.cwd(), "uptime-reports");
const TIME_ZONE = process.env.REPORT_TIMEZONE || "Asia/Kolkata";
const TIMEOUT_MS = Number(process.env.UPTIME_TIMEOUT_MS || 15000);
const OK_STATUS_MIN = Number(process.env.OK_STATUS_MIN || 200);
const OK_STATUS_MAX = Number(process.env.OK_STATUS_MAX || 399);
const EXPECTED_TEXTS = (process.env.EXPECTED_TEXTS || "MediaAnalytics,Live Feed")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function runClock() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    stamp: now.toISOString().replace(/[:.]/g, "-"),
    local: new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(now),
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Frontend Uptime Check");
  lines.push("");
  lines.push(`- Run time: ${report.run.local} (${report.timeZone})`);
  lines.push(`- URL: ${report.url}`);
  lines.push(`- Verdict: ${report.ok ? "PASS" : "FAIL"}`);
  lines.push(`- HTTP status: ${report.status || "no response"}`);
  lines.push(`- Response time: ${report.responseMs}ms`);
  lines.push(`- Content type: ${report.contentType || "unknown"}`);
  lines.push(`- Body size: ${report.bodyBytes} bytes`);
  lines.push("");
  lines.push("## Checks");
  lines.push(`- Status in OK range (${report.okStatusRange.min}-${report.okStatusRange.max}): ${report.statusOk ? "yes" : "no"}`);
  lines.push(`- Frontend markers present: ${report.markersOk ? "yes" : "no"}`);
  for (const marker of report.expectedTexts) {
    lines.push(`- Marker "${marker}": ${report.markerResults[marker] ? "found" : "missing"}`);
  }
  lines.push("");
  lines.push("## Notes");
  if (report.errors.length) {
    for (const error of report.errors) lines.push(`- ${error}`);
  } else {
    lines.push("- Root endpoint is responding and serving the expected frontend HTML markers.");
  }
  return lines.join("\n");
}

(async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const run = runClock();
  const started = Date.now();
  const report = {
    run,
    timeZone: TIME_ZONE,
    url: FRONTEND_URL,
    okStatusRange: { min: OK_STATUS_MIN, max: OK_STATUS_MAX },
    expectedTexts: EXPECTED_TEXTS,
    markerResults: {},
    errors: [],
    ok: false,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(FRONTEND_URL, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "frontend-uptime-check/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    clearTimeout(timeout);

    const body = await response.text();
    report.responseMs = Date.now() - started;
    report.status = response.status;
    report.statusText = response.statusText;
    report.finalUrl = response.url;
    report.contentType = response.headers.get("content-type") || "";
    report.bodyBytes = Buffer.byteLength(body);
    report.statusOk = response.status >= OK_STATUS_MIN && response.status <= OK_STATUS_MAX;

    for (const marker of EXPECTED_TEXTS) {
      report.markerResults[marker] = body.includes(marker);
    }
    report.markersOk = EXPECTED_TEXTS.every((marker) => report.markerResults[marker]);

    if (!report.statusOk) {
      report.errors.push(`HTTP status ${response.status} is outside the accepted range.`);
    }
    if (!report.markersOk) {
      const missing = EXPECTED_TEXTS.filter((marker) => !report.markerResults[marker]);
      report.errors.push(`Missing expected frontend marker(s): ${missing.join(", ")}.`);
    }
    if (report.bodyBytes < 100) {
      report.errors.push("Response body is unexpectedly small.");
    }

    report.ok = report.errors.length === 0;
  } catch (error) {
    report.responseMs = Date.now() - started;
    report.status = null;
    report.contentType = "";
    report.bodyBytes = 0;
    report.statusOk = false;
    report.markersOk = false;
    report.errors.push(`Request failed: ${error.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : error.message}`);
  }

  const jsonPath = path.join(REPORT_DIR, `uptime-${run.stamp}.json`);
  const mdPath = path.join(REPORT_DIR, `uptime-${run.stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(report));

  console.log(toMarkdown(report));
  console.log(`\nSaved uptime reports:\n- ${mdPath}\n- ${jsonPath}`);

  if (!report.ok) {
    process.exitCode = 1;
  }
})();
