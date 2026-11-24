/**
 * L1 Zero-Bundler Live Reload client over SSE (/amb/api/hot-reload/stream).
 */
export function connectHotReload(opts = {}) {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }
  const { onBeforeReload, onStatus, onExtReload } = opts;
  let lastBootId = null;
  let reloading = false;
  const es = new EventSource("/amb/api/hot-reload/stream");

  const reloadStylesheets = (file) => {
    const targetName = typeof file === "string" ? file.split("/").pop() : "";
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    let swapped = false;
    for (const link of links) {
      const rawHref = link.getAttribute("href") || "";
      const base = rawHref.split("?")[0];
      if (!targetName || base.endsWith(targetName) || !base.includes("vendor")) {
        link.setAttribute("href", `${base}?hot=${Date.now()}`);
        swapped = true;
      }
    }
    return swapped;
  };

  es.addEventListener("core_hello", (ev) => {
    try {
      const data = JSON.parse(ev.data || "{}");
      if (lastBootId && data.bootId && lastBootId !== data.bootId && !reloading) {
        reloading = true;
        onBeforeReload?.("core_restarted", data);
        window.location.reload();
        return;
      }
      if (data.bootId) lastBootId = data.bootId;
      onStatus?.("connected", data);
    } catch { /* ignore malformed sse frame */ }
  });

  es.addEventListener("ui_change", (ev) => {
    try {
      const data = JSON.parse(ev.data || "{}");
      const file = String(data.file || "");
      if (file.endsWith(".css") && reloadStylesheets(file)) {
        onStatus?.("css_reloaded", data);
        return;
      }
      if (!reloading) {
        reloading = true;
        onBeforeReload?.("ui_change", data);
        window.location.reload();
      }
    } catch { /* ignore */ }
  });

  es.addEventListener("core_reloading", (ev) => {
    try { onStatus?.("core_reloading", JSON.parse(ev.data || "{}")); } catch { /* ignore */ }
  });

  es.addEventListener("extension_reloaded", (ev) => {
    try { onExtReload?.(JSON.parse(ev.data || "{}")); } catch { /* ignore */ }
  });

  return () => { try { es.close(); } catch { /* ignore */ } };
}
