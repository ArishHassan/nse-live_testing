# Website NSE Feed Monitor

This folder contains a cloud-ready monitor for `https://sameer-local-azure.sameersaurabh.xyz`.

It validates:

- NSE feed load handling
- live-feed fetch/population status
- NSE filter correctness
- newest visible NSE event
- event detail rendering
- console and network failures
- rendering stability and layout shift
- mobile rendering at 390px width
- `/admin` public accessibility

## Run Locally

```bash
npm ci
npx playwright install chromium
npm run monitor
```

Reports are saved under `reports/` as Markdown, JSON, and a mobile screenshot.

## Run While Your Laptop Is Closed

Push this folder to a GitHub repository. The included GitHub Actions workflow runs on GitHub servers, so your laptop does not need to be open.

Schedule in Asia/Kolkata:

- 09:00
- 09:35
- 10:10
- 10:45
- 11:20
- 11:55
- 12:30
- 13:05
- 13:40
- 14:00

Each run uploads the generated report as a workflow artifact and commits the files into the `reports/` folder.
