#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: install-mac-tentacle.sh <HUB_URL> <EDGE_TOKEN> [NODE_ID] [PROJECTS_DIR]" >&2
  exit 1
}

HUB_URL="${1:-${SUGENT_HUB_URL:-}}"
EDGE_TOKEN="${2:-${SUGENT_EDGE_TOKEN:-}}"

if [[ -z "${HUB_URL}" ]] || [[ -z "${EDGE_TOKEN}" ]]; then
  usage
fi

detect_default_node_id() {
  local raw=""
  if command -v scutil >/dev/null 2>&1; then
    raw="$(scutil --get LocalHostName 2>/dev/null || true)"
  fi
  if [[ -z "${raw}" ]]; then
    raw="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "local-mac")"
  fi
  local normalized
  normalized="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]' | sed -E 's/\.local$//; s/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "${normalized}" ]]; then
    normalized="local-mac"
  fi
  printf '%s' "${normalized}"
}

NODE_ID="${3:-${SUGENT_NODE_ID:-$(detect_default_node_id)}}"
PROJECTS_DIR="${4:-${SUGENT_PROJECTS_DIRS:-${HOME}/Projects}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUGENT_REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PLIST_TEMPLATE="${SCRIPT_DIR}/ai.sugent.edge-tentacle.plist"

if [[ ! -f "${PLIST_TEMPLATE}" ]]; then
  echo "[ERROR] Missing LaunchAgent template: ${PLIST_TEMPLATE}" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]] || [[ ! -x "${NODE_BIN}" ]]; then
  echo "[ERROR] Executable node binary not found in PATH (or set NODE_BIN)." >&2
  exit 1
fi

CONFIG_DIR="${SUGENT_CONFIG_DIR:-${HOME}/.config/sugent}"
ENV_FILE="${CONFIG_DIR}/edge.env"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"
PLIST_LABEL="ai.sugent.edge-tentacle"
PLIST_DEST="${LAUNCH_AGENTS_DIR}/${PLIST_LABEL}.plist"

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

run_launchctl() {
  if [[ -n "${SUGENT_LAUNCHCTL_SHIM_SCRIPT:-}" ]]; then
    bash "${SUGENT_LAUNCHCTL_SHIM_SCRIPT}" "$@"
  else
    "${LAUNCHCTL_BIN:-launchctl}" "$@"
  fi
}

mkdir -p "${CONFIG_DIR}" "${LAUNCH_AGENTS_DIR}"
chmod 700 "${CONFIG_DIR}"

(
  umask 077
  cat > "${ENV_FILE}" <<EOF
# Managed by deploy/edge-tentacle/install-mac-tentacle.sh
SUGENT_HUB_URL=$(shell_quote "${HUB_URL}")
SUGENT_EDGE_TOKEN=$(shell_quote "${EDGE_TOKEN}")
SUGENT_NODE_ID=$(shell_quote "${NODE_ID}")
SUGENT_PROJECTS_DIRS=$(shell_quote "${PROJECTS_DIR}")
SUGENT_EDGE_INTERVAL_SEC='45'
EOF
)
chmod 600 "${ENV_FILE}"

if [[ "${SUGENT_SKIP_BUILD:-0}" != "1" ]] && [[ ! -f "${SUGENT_REPO_DIR}/dist/src/cli/edge-tentacle.js" ]] && [[ -f "${SUGENT_REPO_DIR}/package.json" ]]; then
  if command -v npm >/dev/null 2>&1 && "${NODE_BIN}" -e 'const pkg = require(process.argv[1]); process.exit(pkg.scripts && pkg.scripts.build ? 0 : 1);' "${SUGENT_REPO_DIR}/package.json" 2>/dev/null; then
    echo "[INFO] Building Sugent TypeScript artifacts before loading LaunchAgent..."
    npm --prefix "${SUGENT_REPO_DIR}" run build
  fi
fi

"${NODE_BIN}" - "${PLIST_TEMPLATE}" "${PLIST_DEST}" "${SUGENT_REPO_DIR}" "${NODE_BIN}" "${HUB_URL}" "${NODE_ID}" "${PROJECTS_DIR}" <<'NODE_EOF'
const fs = require("node:fs");

const [
  ,
  ,
  templatePath,
  destPath,
  repoDir,
  nodeBin,
  hubUrl,
  nodeId,
  projectsDirs,
] = process.argv;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const replacements = {
  __SUGENT_REPO_DIR__: escapeXml(repoDir),
  __NODE_BIN__: escapeXml(nodeBin),
  __SUGENT_HUB_URL__: escapeXml(hubUrl),
  __SUGENT_NODE_ID__: escapeXml(nodeId),
  __SUGENT_PROJECTS_DIRS__: escapeXml(projectsDirs),
};

let content = fs.readFileSync(templatePath, "utf8");
for (const [token, val] of Object.entries(replacements)) {
  content = content.split(token).join(val);
}

fs.writeFileSync(destPath, content, { encoding: "utf8", mode: 0o600 });
fs.chmodSync(destPath, 0o600);
NODE_EOF

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "${PLIST_DEST}" >/dev/null
fi

if [[ "${SUGENT_SKIP_LAUNCHCTL:-0}" != "1" ]]; then
  GUI_DOMAIN="gui/$(id -u)"
  run_launchctl bootout "${GUI_DOMAIN}/${PLIST_LABEL}" >/dev/null 2>&1 || run_launchctl bootout "${GUI_DOMAIN}" "${PLIST_DEST}" >/dev/null 2>&1 || true
  run_launchctl bootstrap "${GUI_DOMAIN}" "${PLIST_DEST}"
  run_launchctl enable "${GUI_DOMAIN}/${PLIST_LABEL}" >/dev/null 2>&1 || true
  run_launchctl kickstart -k "${GUI_DOMAIN}/${PLIST_LABEL}" >/dev/null 2>&1 || true
fi

echo "[OK] Installed Sugent Edge Tentacle (${PLIST_LABEL})"
echo "  Hub URL      : ${HUB_URL}"
echo "  Node ID      : ${NODE_ID}"
echo "  Projects Dir : ${PROJECTS_DIR}"
echo "  Env File     : ${ENV_FILE} (0600)"
echo "  LaunchAgent  : ${PLIST_DEST} (0600)"
