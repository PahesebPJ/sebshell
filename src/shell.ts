import { createInterface } from 'node:readline'
import { newSessionId, SESSION_ENV } from './activity.ts'
import { SHELL_HOSTS, type ShellConfig, type ShellHost } from './config.ts'
import { type CrewClient, hostFor, invocationFor, isCrewRole } from './crew.ts'
import { type DispatchDeps, isValidAgentName, runTurn } from './dispatch.ts'
import { renderBanner } from './tui/banner.ts'
import { StatusBar, type StatusModel } from './tui/statusbar.ts'
import { createPainter, getTheme } from './tui/theme.ts'
import type { ContextSnapshot } from './usage.ts'

export interface ShellIO {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  color: boolean
}

export interface ShellServices {
  dispatch: DispatchDeps
  services(): Promise<{ id: string; healthy: boolean }[]>
  reconfigure(): Promise<ShellConfig | null>
  /** crewseb integration (routing + per-role model/effort); absent when crewseb is not installed. */
  crew?: CrewClient
  editCrew?(): Promise<void>
  /** Labels of seb_delegate turns that MCP servers of this session's host processes are running. */
  activity?(session: string): Promise<string[]>
  profiles: {
    active(host: ShellHost): Promise<string>
    names(host: ShellHost): Promise<string[]>
    env(host: ShellHost, name: string): Promise<NodeJS.ProcessEnv>
  }
}

export type ShellCommand =
  | { kind: 'prompt'; text: string }
  | { kind: 'host'; host: ShellHost | null; raw: string }
  | { kind: 'agent'; agent: string | null }
  | { kind: 'profile'; name: string | null }
  | { kind: 'new' }
  | { kind: 'config' }
  | { kind: 'crew' }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'empty' }
  | { kind: 'unknown'; raw: string }

const HOST_ALIASES: Record<string, ShellHost> = {
  claude: 'claude',
  cc: 'claude',
  agy: 'antigravity',
  antigravity: 'antigravity',
  gemini: 'antigravity',
}

export function parseShellLine(line: string): ShellCommand {
  const t = line.trim()
  if (!t) return { kind: 'empty' }
  if (!t.startsWith(':')) return { kind: 'prompt', text: t }
  const [cmd = '', ...rest] = t.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (cmd.toLowerCase()) {
    case 'host':
    case 'h':
      return { kind: 'host', host: HOST_ALIASES[arg.toLowerCase()] ?? null, raw: arg }
    case 'agent':
    case 'a':
      return { kind: 'agent', agent: arg && arg !== 'none' && arg !== '-' ? arg : null }
    case 'profile':
    case 'p':
      return { kind: 'profile', name: arg || null }
    case 'new':
    case 'reset':
      return { kind: 'new' }
    case 'config':
      return { kind: 'config' }
    case 'crew':
      return { kind: 'crew' }
    case 'help':
    case '?':
      return { kind: 'help' }
    case 'exit':
    case 'quit':
    case 'q':
      return { kind: 'exit' }
    default:
      return { kind: 'unknown', raw: t }
  }
}

const HELP = [
  'Escribe un prompt y se envía al host activo. Comandos:',
  '  :host claude|agy     cambia el orquestador activo',
  '  :agent <rol>|none    usa un subagente de crewseb (developer, researcher, …)',
  '  :profile [nombre]    lista o cambia la cuenta del host activo (sebshell profile add …)',
  '  :new                 inicia una conversación nueva en el host activo',
  '  :config              reabre el asistente de configuración',
  '  :crew                edita host, modelo y esfuerzo de cada subagente',
  '  :help  ·  :exit',
].join('\n')

const ACTIVITY_POLL_MS = 1000

export async function runShell(io: ShellIO, initial: ShellConfig, deps: ShellServices, version: string): Promise<void> {
  let config = initial
  let theme = getTheme(config.theme)
  let p = createPainter(io.color)
  // Keyed by host/profile: a conversation belongs to the account that started it.
  const sessions: Record<string, string> = {}
  // Tags every host process this shell starts so their seb_delegate turns show up in the bar.
  const shellSession = newSessionId()
  const contexts: Record<string, ContextSnapshot> = {}
  let host: ShellHost = config.orchestrator
  let agent: string | null = null
  // `:profile` overrides last for this session only; otherwise the stored active profile is
  // re-read before every turn so a `sebshell profile use` from another terminal is honored.
  const overrides: Partial<Record<ShellHost, string>> = {}
  const profiles: Partial<Record<ShellHost, string>> = {}
  const refreshProfile = async (h: ShellHost): Promise<string> => {
    const name = overrides[h] ?? (await deps.profiles.active(h))
    profiles[h] = name
    return name
  }
  await refreshProfile(host).catch((e: unknown) => {
    out.write(`⚠ ${e instanceof Error ? e.message : String(e)}\n`)
  })
  // A conversation belongs to a host, an account and the agent it was started with.
  const keyFor = (h: ShellHost) => `${h}/${profiles[h] ?? 'default'}/${agent ?? 'main'}`
  const sessionKey = () => keyFor(host)

  const profileLabel = () => {
    const name = profiles[host]
    return name && name !== 'default' ? name : null
  }

  const model = (): StatusModel => ({
    orchestrator: host,
    profile: profileLabel(),
    agent,
    context: contexts[sessionKey()] ?? null,
    activeSubagents: [],
    services: [],
    busy: false,
  })

  const out = io.output
  const columns = () => out.columns ?? 80
  const printBanner = () =>
    out.write(
      renderBanner({
        theme,
        color: io.color,
        columns: columns(),
        subtitle: `v${version} · hosts: ${config.hosts.join(', ')} · :help para ayuda`,
      }),
    )

  const safeServices = async () => {
    try {
      return await deps.services()
    } catch {
      return []
    }
  }

  printBanner()
  let bar = new StatusBar(out, theme, io.color, model())
  let inflight: AbortController | null = null

  const promptText = () =>
    `${p.fg(theme.accent, '❯')} ${p.fg(theme.muted, host === 'antigravity' ? 'agy' : host)}${agent ? p.fg(theme.muted, `:${agent}`) : ''} `

  // Readline is recreated after :config because the wizard needs exclusive raw keypress access.
  let running = true
  try {
    bar.attach()
    bar.update({ services: await safeServices() })
    while (running) {
      const rl = createInterface({ input: io.input, output: out, terminal: Boolean(io.input.isTTY) })
      let closed = false
      rl.on('close', () => {
        closed = true
        inflight?.abort()
      })
      // Ctrl+C cancels the running turn; on an idle prompt it exits the shell.
      rl.on('SIGINT', () => {
        if (inflight) {
          inflight.abort()
          return
        }
        running = false
        rl.close()
      })
      let reconfigure: 'config' | 'crew' | null = null
      rl.setPrompt(promptText())
      rl.prompt()
      for await (const line of rl) {
        const cmd = parseShellLine(line)
        if (cmd.kind === 'exit') {
          running = false
          break
        }
        if (cmd.kind === 'config' || cmd.kind === 'crew') {
          if (cmd.kind === 'crew' && !deps.editCrew) {
            out.write(p.fg(theme.warn, 'crewseb no está instalado; instálalo con sebshell install\n'))
            rl.prompt()
            continue
          }
          reconfigure = cmd.kind
          break
        }
        await handle(cmd)
        if (closed) break
        rl.setPrompt(promptText())
        rl.prompt()
      }
      rl.close()
      if (!reconfigure) running = false
      else {
        bar.detach()
        const next = reconfigure === 'config' ? await deps.reconfigure() : null
        if (reconfigure === 'crew') await deps.editCrew?.()
        if (next) {
          config = next
          theme = getTheme(config.theme)
          p = createPainter(io.color)
          if (!config.hosts.includes(host)) host = config.orchestrator
        }
        out.write('\x1b[2J\x1b[H')
        printBanner()
        await refreshProfile(host).catch(() => undefined)
        bar = new StatusBar(out, theme, io.color, { ...model(), services: await safeServices() })
        bar.attach()
      }
    }
  } finally {
    bar.detach()
  }

  async function handle(cmd: ShellCommand): Promise<void> {
    switch (cmd.kind) {
      case 'empty':
      case 'exit':
      case 'config':
      case 'crew':
        return
      case 'help':
        out.write(`${HELP}\n`)
        return
      case 'unknown':
        out.write(p.fg(theme.warn, `Comando desconocido: ${cmd.raw} (usa :help)\n`))
        return
      case 'host':
        if (!cmd.host) {
          out.write(p.fg(theme.warn, `Host inválido "${cmd.raw}". Opciones: ${SHELL_HOSTS.join(', ')} (alias agy)\n`))
          return
        }
        if (!config.hosts.includes(cmd.host)) {
          out.write(p.fg(theme.warn, `${cmd.host} no está habilitado; actívalo con :config\n`))
          return
        }
        host = cmd.host
        await refreshProfile(host).catch(() => undefined)
        bar.update({ orchestrator: host, profile: profileLabel(), context: contexts[sessionKey()] ?? null })
        return
      case 'agent':
        if (cmd.agent && !isValidAgentName(cmd.agent)) {
          out.write(p.fg(theme.warn, `Nombre de agente inválido "${cmd.agent}"\n`))
          return
        }
        agent = cmd.agent
        bar.update({ agent })
        return
      case 'profile': {
        const names = await deps.profiles.names(host)
        if (!cmd.name) {
          out.write(`Perfiles de ${host}: ${names.map((n) => (n === (profiles[host] ?? 'default') ? `[${n}]` : n)).join(' ')}\n`)
          return
        }
        if (!names.includes(cmd.name)) {
          out.write(p.fg(theme.warn, `No existe el perfil ${host}/${cmd.name}. Créalo con: sebshell profile add ${host} ${cmd.name}\n`))
          return
        }
        overrides[host] = cmd.name
        profiles[host] = cmd.name
        bar.update({ profile: profileLabel(), context: contexts[sessionKey()] ?? null })
        out.write(p.fg(theme.muted, `${host} ahora usa el perfil ${cmd.name} (solo en esta sesión; para fijarlo: sebshell profile use).\n`))
        return
      }
      case 'new':
        delete sessions[sessionKey()]
        delete contexts[sessionKey()]
        bar.update({ context: null })
        out.write(p.fg(theme.muted, `Nueva conversación en ${host}.\n`))
        return
      case 'prompt': {
        // A crewseb role may be routed to another host and carry its own model/effort.
        const info =
          agent && deps.crew && isCrewRole(agent)
            ? await deps.crew.role(agent).catch((e: unknown) => {
                out.write(p.fg(theme.warn, `⚠ No se pudo leer el ruteo de crewseb (${e instanceof Error ? e.message : String(e)}); se usan host y modelo por defecto.\n`))
                return undefined
              })
            : undefined
        let turnHost = hostFor(info, host)
        if (!config.hosts.includes(turnHost)) {
          out.write(p.fg(theme.warn, `${agent} está ruteado a ${turnHost}, que no está habilitado; se ejecuta en ${host}.\n`))
          turnHost = host
        }
        const { model: turnModel, effort: turnEffort } = invocationFor(info, turnHost)

        // Never fall back to another account: if the profile cannot be resolved, the turn is aborted.
        let env: NodeJS.ProcessEnv
        try {
          const name = await refreshProfile(turnHost)
          env = await deps.profiles.env(turnHost, name)
        } catch (e) {
          out.write(p.fg(theme.danger, `✖ Perfil no disponible: ${e instanceof Error ? e.message : String(e)}\n`))
          bar.update({ profile: profileLabel() })
          return
        }
        bar.update({ profile: profileLabel(), context: contexts[sessionKey()] ?? null })
        const label = `${turnHost === 'antigravity' ? 'agy' : turnHost}:${agent ?? 'main'}${turnModel ? `·${turnModel}` : ''}${turnEffort ? `@${turnEffort}` : ''}`
        if (turnHost !== host) out.write(p.fg(theme.muted, `↪ ${agent} se ejecuta en ${turnHost} (ruteo de crewseb)\n`))
        const turnKey = keyFor(turnHost)
        bar.update({ busy: true, activeSubagents: [label] })
        // Delegations run by the host's own `sebshell mcp` live in other processes: poll their registry.
        let polling = false
        let turnActive = true
        let shown = ''
        const poll = deps.activity
          ? setInterval(() => {
              if (polling) return
              polling = true
              deps.activity!(shellSession)
                .then((mcp) => {
                  const subs = [label, ...mcp]
                  const key = subs.join('\n')
                  if (!turnActive || key === shown) return
                  shown = key
                  bar.update({ activeSubagents: subs })
                })
                .catch(() => {})
                .finally(() => {
                  polling = false
                })
            }, ACTIVITY_POLL_MS)
          : null
        inflight = new AbortController()
        const res = await runTurn(
          deps.dispatch,
          {
            host: turnHost,
            prompt: cmd.text,
            agent,
            model: turnModel,
            effort: turnEffort,
            sessionId: sessions[turnKey] ?? null,
            env: { ...env, [SESSION_ENV]: shellSession },
            contextWindow: config.contextWindow[turnHost],
          },
          inflight.signal,
        ).finally(() => {
          inflight = null
          turnActive = false
          if (poll) clearInterval(poll)
        })
        if (res.context) {
          contexts[turnKey] = res.context
          if (res.context.sessionId) sessions[turnKey] = res.context.sessionId
        }
        out.write(res.ok ? `${res.text.trimEnd()}\n` : p.fg(theme.danger, `✖ ${res.error}\n`))
        bar.update({ busy: false, activeSubagents: [], context: contexts[sessionKey()] ?? null })
        return
      }
    }
  }
}
