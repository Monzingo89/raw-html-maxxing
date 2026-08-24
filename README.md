# Raw HTML Maxxing

A focused URL-to-HTML capture tool. Paste an eBay URL, choose **Fetch**, and the
app opens the page in Chromium, waits for it to load, serializes the complete
DOM with `page.content()`, and downloads the result as an `.html` file.

The repository includes the original capture script and all 14 reference HTML
files from `data/quick-grade/testing/ebay-full-html` under `reference/`.

## Run locally

Requirements: Node.js 22+ and Chrome.

```bash
npm install
npm run start
```

Open <http://127.0.0.1:8787>. The default browser is headed so you can complete
an eBay sign-in or verification prompt if one appears. Captures are serialized
to keep the persistent browser profile safe.

## Publish the frontend with GitHub Pages

GitHub Pages only hosts static files; Chromium must run in a separate backend.
Deploy this repository as a Node/Docker service first, then create this GitHub
repository variable:

- `RAW_HTML_API_URL`: the public backend origin, such as
  `https://raw-html.example.com`

The included `Deploy GitHub Pages` workflow injects that value into the static
frontend. `RAW_HTML_API_URL` is a repository **variable**, not a secret. No API
key is required by this app.

In GitHub, open **Settings → Pages → Build and deployment**, select **GitHub
Actions**, then run the workflow or push to `main`.

## Deploy the backend

The included `Dockerfile` runs Chromium headlessly and serves both the API and
the frontend. Configure the service with:

```text
HEADLESS=true
BROWSER_CHANNEL=chromium
HOST=0.0.0.0
PORT=8787
```

For a split GitHub Pages/backend deployment, also set `CORS_ORIGIN` to the
Pages origin (for example, `https://monzingo89.github.io`). Multiple origins
may be comma-separated.

eBay can require interactive verification. A remote headless service cannot
complete that challenge automatically; run the app in headed mode on a trusted
machine when verification is required. Do not attempt to bypass eBay security.

## Commands

```bash
npm test               # unit tests
npm run check           # syntax checks
npm run capture -- --url "https://www.ebay.com/..." --out-file capture.html
```

Only `ebay.com` and its subdomains are accepted, matching the original capture
tool. Override `ALLOW_HOSTS` only when you intentionally want a different
allowlist.
