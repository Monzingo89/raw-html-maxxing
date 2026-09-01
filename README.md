# Raw HTML Maxxing

A focused URL-to-HTML capture tool. Paste an eBay URL, choose **Fetch**, and the
app opens the page in Chromium, waits for it to load, serializes the complete
DOM with `page.content()`, and downloads the result as an `.html` file.

The repository includes the original capture script and all 14 reference HTML
files from `data/quick-grade/testing/ebay-full-html` under `reference/`.

Every accepted eBay URL is sent to the configured Chromium backend. There are
no URL-specific downloads or hardcoded search results in the frontend.

## Direct API

Interactive Swagger documentation is hosted at:

<https://raw-html-maxxing-dd899e.centralus.cloudapp.azure.com/api/docs>

The machine-readable OpenAPI document is available at:

<https://raw-html-maxxing-dd899e.centralus.cloudapp.azure.com/api/openapi.json>

The GitHub Pages URL is only the browser interface. Server-side clients should
send the target eBay URL as JSON to the HTTPS capture API:

```bash
curl --fail-with-body \
  --output ebay-sold.html \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://www.ebay.com/sch/182982/i.html?_from=R40&_dmd=1&_nkw=2026+topps+chrome+disney&LH_Sold=1&_ipg=240"}' \
  'https://raw-html-maxxing-dd899e.centralus.cloudapp.azure.com/api/fetch'
```

A successful request returns the rendered HTML directly with HTTP `200` and a
`Content-Disposition` attachment filename. Clients should honor `Retry-After`
when the server returns `429`. The deployed single-browser backend accepts one
capture at a time; parallel requests receive `429` instead of accumulating in
an unbounded queue.

The production bootstrap accepts at most 10,000 distinct browser captures in
any rolling 24-hour period. Batch captures target one start every 8.64 seconds
and always sleep at least 4.64 seconds after a capture. A 3-second capture
therefore sleeps 5.64 seconds; a 4-second capture sleeps 4.64 seconds. Longer
captures slow the batch rather than shortening the minimum sleep. Successful
HTML is cached by exact URL for 48 hours on the production VM. Rolling daily
counters, batch progress, and cached HTML persist across backend restarts.

## Submit up to 10,000 URLs at once

Use the asynchronous batch endpoint instead of opening 10,000 simultaneous
HTTP connections. Create `urls.json` with one `urls` array containing between 1
and 10,000 distinct allowed URLs:

```json
{
  "urls": [
    "https://www.ebay.com/sch/i.html?_nkw=pikachu&LH_Sold=1",
    "https://www.ebay.com/sch/i.html?_nkw=charizard&LH_Sold=1"
  ]
}
```

Submit the whole file in one request:

```bash
curl --fail-with-body \
  --request POST \
  --header 'Content-Type: application/json' \
  --data-binary @urls.json \
  'https://raw-html-maxxing-dd899e.centralus.cloudapp.azure.com/api/batches'
```

The server responds immediately with HTTP `202`, a batch `id`, and a
`statusUrl`. Poll that URL to see every item as `queued`, `complete`, or
`failed`. Completed items include a `resultUrl` that downloads the HTML. Only
one batch can be active at a time. If eBay requires interactive authentication,
the current capture and the entire queue wait indefinitely without advancing.
Processing resumes automatically when the operator completes verification in
the persistent browser. A batch only enters the explicit `paused` state when an
authentication or service error escapes that live waiting loop; resume such a
batch with `POST /api/batches/{id}/resume` after correcting the issue.

To receive results incrementally, start with `after=-1` and retain the returned
`nextCursor`:

```bash
curl --fail-with-body \
  'https://raw-html-maxxing-dd899e.centralus.cloudapp.azure.com/api/batches/BATCH_ID/results?after=-1&limit=1'
```

Each response contains only newly finished items after that cursor. Completed
items contain the complete rendered HTML in an `html` field; failed items include
an error. Use `nextCursor` as the next request's `after` value. Because rendered
HTML can be large, the endpoint defaults to one item and permits at most 10 per
response. This lets a sender receive HTML continuously as it becomes available
without resubmitting the original 10,000 URLs.

## Send URLs dynamically

For URLs that arrive throughout the day, send each one to `POST /api/fetch`.
The successful HTTP response body is the complete rendered HTML itself:

```bash
curl --fail-with-body \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://www.ebay.com/sch/i.html?_nkw=pikachu&LH_Sold=1"}' \
  'https://raw-html-maxxing-dd899e.centralus.cloudapp.azure.com/api/fetch' \
  --output result.html
```

Send the next dynamic request after the prior response finishes. If a request
returns HTTP `429`, wait for the number of seconds in its `Retry-After` header
and retry that same URL. Accepted uncached captures count toward the shared
10,000-capture rolling 24-hour allowance; busy retries and cache hits do not
consume that allowance. Do not run dynamic uncached requests while a bulk batch
is active—the batch has priority.

If a headed-browser capture fails, the failed Chromium context is closed and
the gateway enters a persistent three-minute restart pause. New dynamic requests
remain accepted in arrival order and receive HTTP `202` with
`Please Wait, Restarting Browser`, a retry ID, and the restart time. The gateway
then launches a fresh headed browser and releases the queued URLs after its first
successful capture. Cache, disk, and other infrastructure failures remain HTTP
`503` retries and do not cause a browser-restart loop.

If eBay requires login or interactive verification, the gateway enters a
persistent three-minute login pause. New dynamic requests remain accepted in
arrival order and receive HTTP `202` with `Please Wait, Logging In`, a retry ID,
and the next probe time. The first successful probe releases the queued URLs
immediately so processing continues from the point where authentication stopped.

Operational alerts are deduplicated for one hour. Configure email delivery on
each VM in `/etc/raw-html-alert.env`:

```dotenv
ALERT_EMAIL_TO=operator@example.com
ALERT_EMAIL_FROM="Raw HTML Alerts <alerts@your-verified-domain.example>"
RESEND_API_KEY=re_...
```

Without those values, alerts are preserved in
`/var/lib/raw-html-maxxing/alert-state.json.outbox.ndjson` but cannot be emailed.

## Keep VM screen sharing available

The VM bootstrap runs `x11vnc` with `-forever -shared` under an always-restarting
systemd service. It is intentionally bound to localhost, so keep an SSH tunnel
open from the Mac and connect Screen Sharing through that tunnel:

```bash
ssh -N -L 5901:127.0.0.1:5900 azureuser@raw-html-maxxing-dd899e.centralus.cloudapp.azure.com
open 'vnc://127.0.0.1:5901'
```

Leave both processes open while a batch is running. The VM-side VNC service
automatically restarts if it exits; the localhost binding keeps the VNC port
off the public internet.

Do not put the eBay URL on the GitHub Pages query string. GitHub Pages is static
and does not process `?url=...` parameters.

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
is exposed to the frontend.

GitHub Pages hosts the frontend. Live captures use the separately hosted
Chromium backend configured in `config.js`.

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
