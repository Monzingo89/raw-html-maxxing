const form = document.querySelector("#fetch-form");
const input = document.querySelector("#url-input");
const button = document.querySelector("#fetch-button");
const status = document.querySelector("#status");

let loading = false;

function apiUrl(path) {
  const configured = String(window.RAW_HTML_CONFIG?.apiBaseUrl || "").trim();
  return `${configured.replace(/\/$/, "")}${path}`;
}

function updateButton() {
  button.disabled = loading || input.value.trim().length === 0;
}

function filenameFromResponse(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) return decodeURIComponent(encodedMatch[1]);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || `capture-${Date.now()}.html`;
}

function download(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

input.addEventListener("input", () => {
  status.textContent = "";
  status.removeAttribute("data-state");
  updateButton();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url || loading) return;

  loading = true;
  input.value = "";
  button.dataset.loading = "true";
  button.querySelector("span:first-child").textContent = "Fetching";
  status.textContent = "Opening the page and capturing its rendered HTML…";
  status.removeAttribute("data-state");
  updateButton();

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 75_000);
  try {
    const response = await fetch(apiUrl("/api/fetch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error((await response.text()) || `Request failed (${response.status})`);
    }

    const blob = await response.blob();
    download(blob, filenameFromResponse(response));
    status.textContent = `Downloaded ${Math.max(1, Math.round(blob.size / 1024)).toLocaleString()} KB of HTML.`;
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = error?.name === "AbortError"
      ? "The capture timed out. Please try again or contact the site operator."
      : error instanceof TypeError
      ? "The capture service is unavailable. Check the configured backend URL."
      : String(error.message || error);
  } finally {
    window.clearTimeout(timeout);
    loading = false;
    delete button.dataset.loading;
    button.querySelector("span:first-child").textContent = "Fetch";
    updateButton();
    input.focus();
  }
});

updateButton();
