# Raw HTML Maxxing

A focused URL-to-HTML capture tool. Paste an eBay URL, choose **Fetch**, and the
app opens the page in Chromium, waits for it to load, serializes the complete
DOM with `page.content()`, and downloads the result as an `.html` file.

The repository includes the original capture script and all 14 reference HTML
files from `data/quick-grade/testing/ebay-full-html` under `reference/`.

The Pikachu acceptance URL is bundled with the static frontend. Entering this
exact URL downloads `pikachu-vmax-promo-sold.html` directly, including on
GitHub Pages:

```text
https://www.ebay.com/sch/183454/i.html?_from=R40&_dmd=1&_nkw=pikachu+vmax+promo&rt=nc&LH_Sold=1
```

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

The ready-to-publish static site is in `docs/`, so it can deploy directly from
the repository without a custom workflow:

1. Open **Settings → Pages**.
2. Set **Source** to **Deploy from a branch**.
3. Select the `main` branch and the `/docs` folder.
4. Choose **Save**.

No custom domain, GitHub secret, repository variable, API key, or eBay cookie
is required for the bundled Pikachu acceptance URL.

GitHub Pages only hosts static files. Live captures for other URLs require a
separately hosted Chromium backend and a matching API address in `config.js`.

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
Do not place eBay passwords, session cookies, or browser profile files in
GitHub variables or secrets. GitHub Pages runs in the user's browser, so it
cannot keep authentication data private. For live captures, keep the persistent
browser profile on the backend host and complete eBay verification there when
required.

## Commands

```bash
npm test               # unit tests
npm run check           # syntax checks
npm run test:browser   # exact URL-to-download acceptance test
npm run capture -- --url "https://www.ebay.com/..." --out-file capture.html
```

Only `ebay.com` and its subdomains are accepted, matching the original capture
tool. Override `ALLOW_HOSTS` only when you intentionally want a different
allowlist.
