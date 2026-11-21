// Sugent self-evolution file-write policy. The packaged app loads this only while
// self-evolution is enabled; DSH's permission preset remains the outer sandbox.
import fs from 'node:fs'
import path from 'node:path'

export const name = 'amb-self-edit-gate'

const FORBIDDEN = ['.git/config', 'LICENSE', 'dsh-runtime/plugins/amb-bridge.mjs']
const APPROVAL_REQUIRED = [
  'package.json', 'tsconfig.json', 'scripts/verify-sugent.mjs',
  'src/sugent/self-evolution.ts', 'src/core/access.ts', 'electron/main.ts',
]
const SOURCE_AUTONOMOUS_PREFIXES = ['src/sugent', 'test', 'docs', 'ui', 'plugins', 'skills']
const SOURCE_AUTONOMOUS_PATHS = ['README.md', 'ARCHITECTURE.md']

function argsOf(exec) {
  const value = exec?.arguments
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' ? value : {}
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

// Resolve through the nearest existing ancestor so symlinks cannot turn an
// apparently in-workspace path into a write to another tree.
function canonicalCandidate(candidate) {
  let cursor = candidate
  const suffix = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return candidate
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  try { return path.resolve(fs.realpathSync(cursor), ...suffix) } catch { return candidate }
}

function classify(relPath, mode) {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const segments = norm.split('/').filter(Boolean)
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm) || segments.includes('..')) return 'requires_approval'
  if (FORBIDDEN.some((entry) => norm === entry || norm.startsWith(`${entry}/`))) return 'forbidden'
  if (APPROVAL_REQUIRED.some((entry) => norm === entry || norm.startsWith(`${entry}/`))) return 'requires_approval'
  if (mode === 'packaged') return norm.startsWith('skills/') || norm.startsWith('plugins/') ? 'autonomous' : 'requires_approval'
  if (SOURCE_AUTONOMOUS_PATHS.includes(norm) || SOURCE_AUTONOMOUS_PREFIXES.some((entry) => norm.startsWith(`${entry}/`))) return 'autonomous'
  return 'requires_approval'
}

function mutationPath(exec) {
  const args = argsOf(exec)
  switch (String(exec?.name ?? '')) {
    case 'write':
    case 'edit':
      return typeof args.file_path === 'string' ? args.file_path : undefined
    case 'str_replace_editor':
      return ['create', 'str_replace', 'insert'].includes(String(args.command)) && typeof args.path === 'string'
        ? args.path
        : undefined
    default:
      return undefined
  }
}

export function apply(ctx) {
  const rootValue = process.env.AMB_SELF_EVOLUTION_ROOT
  const mode = process.env.AMB_SELF_EVOLUTION_MODE === 'packaged' ? 'packaged' : 'source'
  if (!rootValue) return
  let root
  try { root = fs.realpathSync(path.resolve(rootValue)) } catch { return }

  ctx.on('tools/pre-execute', async (exec, next) => {
    // Shell syntax is open-ended: wrappers, command substitutions, interpreters and
    // redirections can all write files without appearing in a small command regex.
    // Route every packaged self-evolution shell call through the normal approval flow.
    if (mode === 'packaged' && ['bash', 'tool:bash', 'pwsh', 'tool:pwsh', 'powershell'].includes(String(exec?.name ?? ''))) {
      return {
        kind: 'ask',
        reason: 'Shell commands need the user\'s approval in packaged self-evolution mode because their write targets cannot be determined safely before execution.',
        displayReason: {
          en: 'Self-evolution: approve this shell command',
          zh: '自我迭代：此 Shell 命令需要你确认',
        },
      }
    }
    const rawPath = mutationPath(exec)
    if (rawPath === undefined) return next()
    const session = exec?.agent?.session
    let cwd = process.cwd()
    try {
      const workingDirectory = ctx.get?.('workingDirectory')?.get?.(session)
      if (typeof workingDirectory === 'string' && workingDirectory) cwd = workingDirectory
    } catch {}

    const candidate = canonicalCandidate(path.resolve(cwd, rawPath))
    const relPath = isWithin(root, candidate) ? path.relative(root, candidate) : candidate
    const risk = classify(relPath, mode)
    if (risk === 'autonomous') return next()
    if (risk === 'forbidden') {
      return { kind: 'deny', reason: `Self-evolution policy forbids modifying ${relPath}.` }
    }
    return {
      kind: 'ask',
      reason: `Modifying ${relPath} is outside the autonomous self-evolution paths and needs the user's approval.`,
      displayReason: {
        en: `Self-evolution: approve changing ${relPath}`,
        zh: `自我迭代：修改 ${relPath} 需要你确认`,
      },
    }
  }, { prepend: true })
}
