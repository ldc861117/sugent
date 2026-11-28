// Sugent steward fleet loopback bridge plugin for DSH SuperAgent.
// Exposes `steward_fleet` in owner DM conversations via host /dsh/steward-fleet (never in group chats).
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'amb-steward-fleet'
export const inject = ['tools']

function bridge() {
  const url = process.env.AMB_BRIDGE_URL
  const token = process.env.AMB_BRIDGE_TOKEN
  if (!url || !token) return undefined
  return async (path, body, signal) => {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw new Error(`bridge ${path} ${res.status}`)
    return res.json()
  }
}

export function apply(ctx) {
  const call = bridge()
  if (!call) return
  const botId = process.env.AMB_BOT_ID ?? ''

  ctx.tools.register(defineTool({
    name: 'steward_fleet',
    description:
      'Query real-time /ops + edge project status, gitSyncAlerts (uncommitted/unpushed/behind/unmerged PR branches), TASKS.md queue (tasksSummary with #slug & AC), full roadmap stages/items (nodes[].items[]), and recent plans; read sanitized ROADMAP.md / TASKS.md / STATUS.md / docs/plans/*.md; mark human todos complete; or dispatch coding tasks by #slug & AC. Always prefer this over raw JSON inspection.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['overview', 'read_doc', 'dispatch_coding', 'complete_todo'],
        description: 'Operation: overview, read_doc, dispatch_coding, or complete_todo.',
      },
      projectQuery: {
        type: 'string',
        description: 'Project name/slug filter or target (e.g. Andy-web, self-a-web, sugent, airtoken).',
      },
      docPath: {
        type: 'string',
        description: 'Relative markdown path for read_doc (default ROADMAP.md; also TASKS.md, STATUS.md, AGENTS.md, docs/plans/<file>.md).',
      },
      todoQuery: {
        type: 'string',
        description: 'Todo id, roadmap code (e.g. P3.5), or unique substring for complete_todo.',
      },
      title: {
        type: 'string',
        description: 'Short task title for dispatch_coding.',
      },
      prompt: {
        type: 'string',
        description: 'Full coding task instructions for dispatch_coding.',
      },
      targetNodeId: {
        type: 'string',
        description: 'Optional edge node id for dispatch_coding (e.g. local-mac, gce-remote).',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      const sessionId = String(exec.agent?.session?.id ?? '')
      const r = await call('/dsh/steward-fleet', { botId, sessionId, op: args.action, args }, exec.signal)
      return { text: JSON.stringify(r, null, 2) }
    },
  }))
}
