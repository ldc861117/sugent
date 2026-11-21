import type { IdpAdapter } from "./adapters/base.js";

function escapeText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderProviderSelectorPage(params: {
  sealedTx: string;
  adapters: readonly IdpAdapter[];
}): string {
  const items = params.adapters.map((adapter) => {
    const route = `/oauth/login/${encodeURIComponent(adapter.idp)}?tx=${encodeURIComponent(params.sealedTx)}`;
    return `<li><a data-idp="${escapeText(adapter.idp)}" href="${route}">${escapeText(adapter.displayName)}</a></li>`;
  });

  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>Sugent Auth Broker</title>",
    "<section>",
    "<h2>Select Identity Channel</h2>",
    items.length > 0 ? `<ul>${items.join("")}</ul>` : "<p>No identity channel configured.</p>",
    "</section>",
  ].join("\n");
}
