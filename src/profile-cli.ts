import { serializeWire, type SystemRuntime, wireFailure, wireSuccess } from 'hubseb'
import { SHELL_HOSTS, type ShellHost } from './config.ts'
import { execCancellable, execInteractive } from './process.ts'
import {
  type AccountStatus,
  activeProfileName,
  addProfile,
  DEFAULT_PROFILE,
  findProfile,
  listProfiles,
  loadProfiles,
  type Profile,
  ProfileError,
  profileEnv,
  parseClaudeAuthStatus,
  removeProfile,
  supportsProfiles,
  syncProfiles,
  useProfile,
} from './profiles.ts'

export const PROFILE_USAGE = `Perfiles de cuenta:
  sebshell profile list [--json]                 Perfiles por host y cuenta asociada
  sebshell profile add claude <nombre>           Crea un perfil aislado (comparte agentes/skills/hooks/MCP)
  sebshell profile login claude <nombre>         Inicia sesión en ese perfil (claude auth login)
  sebshell profile use claude <nombre|default>   Fija el perfil activo
  sebshell profile rm claude <nombre> [--purge]  Quita el perfil (--purge borra también su sesión)
  sebshell profile sync                          Re-enlaza assets y copia MCP nuevos a todos los perfiles
`

export function parseHost(arg: string | undefined): ShellHost | null {
  if (arg === 'agy' || arg === 'gemini') return 'antigravity'
  return SHELL_HOSTS.find((h) => h === arg) ?? null
}

export async function accountStatus(runtime: SystemRuntime, profile: Profile): Promise<AccountStatus | null> {
  if (profile.host !== 'claude') return null
  const exe = runtime.locateBinary('claude')
  if (!exe) return null
  try {
    const res = await execCancellable(exe, ['auth', 'status', '--json'], {
      env: { ...process.env, ...profileEnv(profile) },
    })
    return parseClaudeAuthStatus(res.stdout)
  } catch {
    return null
  }
}

/** Resolves which profile a host turn should use: explicit name, else the active one. */
export async function resolveProfile(runtime: SystemRuntime, host: ShellHost, name?: string | null): Promise<Profile> {
  const store = await loadProfiles(runtime)
  const wanted = name ?? activeProfileName(store, host)
  const profile = findProfile(store, host, wanted)
  if (!profile) throw new ProfileError(`No existe el perfil ${host}/${wanted}. Créalo con: sebshell profile add ${host} ${wanted}`)
  return profile
}

const out = (s: string) => process.stdout.write(s)
const err = (s: string) => process.stderr.write(s)

export async function runProfileCli(runtime: SystemRuntime, args: string[], jsonMode: boolean): Promise<number> {
  const [sub = 'list', hostArg, name] = args
  const fail = (code: string, msg: string, exit = 1) => {
    if (jsonMode) out(serializeWire(wireFailure(`profile.${sub}`, code, msg)))
    else err(`${msg}\n`)
    return exit
  }

  try {
    if (sub === 'list' || sub === 'ls') {
      const store = await loadProfiles(runtime)
      const rows: Array<Profile & { active: boolean; account: AccountStatus | null; supported: boolean }> = []
      for (const host of SHELL_HOSTS) {
        const active = activeProfileName(store, host)
        for (const p of listProfiles(store, host)) {
          rows.push({ ...p, active: p.name === active, account: await accountStatus(runtime, p), supported: supportsProfiles(host) })
        }
      }
      if (jsonMode) {
        out(serializeWire(wireSuccess('profile.list', { profiles: rows })))
        return 0
      }
      for (const host of SHELL_HOSTS) {
        out(`${host}${supportsProfiles(host) ? '' : '  (solo default por ahora)'}\n`)
        for (const r of rows.filter((x) => x.host === host)) {
          const acct = r.account ? (r.account.loggedIn ? `${r.account.email ?? 'sesión activa'} · ${r.account.plan ?? '?'}` : 'sin sesión') : ''
          out(`  ${r.active ? '●' : '○'} ${r.name.padEnd(16)} ${acct}\n`)
        }
      }
      return 0
    }

    if (sub === 'sync') {
      const results = await syncProfiles(runtime)
      if (jsonMode) out(serializeWire(wireSuccess('profile.sync', { results })))
      else if (results.length === 0) out('No hay perfiles adicionales que sincronizar.\n')
      else for (const r of results) out(`${r.profile.host}/${r.profile.name}: enlazados [${r.report.linked.join(', ') || '—'}] · MCP nuevos [${r.report.mcpServersAdded.join(', ') || '—'}]\n`)
      return 0
    }

    const host = parseHost(hostArg)
    if (!host) return fail('bad_args', `Host inválido "${hostArg ?? ''}".\n${PROFILE_USAGE}`, 2)

    if (sub === 'add') {
      if (!name) return fail('bad_args', `Falta el nombre.\n${PROFILE_USAGE}`, 2)
      const { profile, report } = await addProfile(runtime, host, name)
      if (jsonMode) out(serializeWire(wireSuccess('profile.add', { profile, report })))
      else {
        out(`Perfil ${host}/${name} creado en ${profile.configDir}\n`)
        out(`  compartido: ${report.linked.join(', ') || '—'}\n  MCP copiados: ${report.mcpServersAdded.join(', ') || '—'}\n`)
        out(`Siguiente paso: sebshell profile login ${host} ${name}\n`)
      }
      return 0
    }

    if (sub === 'login') {
      if (!process.stdin.isTTY) return fail('not_tty', 'El login requiere una terminal interactiva.', 2)
      const profile = await resolveProfile(runtime, host, name ?? DEFAULT_PROFILE)
      const exe = runtime.locateBinary('claude')
      if (host !== 'claude' || !exe) return fail('unsupported', `Login no disponible para ${host}.`)
      out(`Iniciando sesión en ${host}/${profile.name}. Usa la cuenta que quieras asociar a este perfil.\n`)
      const code = await execInteractive(exe, ['auth', 'login'], profileEnv(profile))
      const status = await accountStatus(runtime, profile)
      out(status?.loggedIn ? `✔ ${profile.name} → ${status.email ?? 'sesión activa'} (${status.plan ?? '?'})\n` : '✖ No quedó una sesión activa.\n')
      return code === 0 && status?.loggedIn ? 0 : 1
    }

    if (sub === 'use') {
      if (!name) return fail('bad_args', `Falta el nombre.\n${PROFILE_USAGE}`, 2)
      const profile = await useProfile(runtime, host, name)
      if (jsonMode) out(serializeWire(wireSuccess('profile.use', { profile })))
      else out(`Perfil activo de ${host}: ${profile.name}\n`)
      return 0
    }

    if (sub === 'rm' || sub === 'remove') {
      if (!name) return fail('bad_args', `Falta el nombre.\n${PROFILE_USAGE}`, 2)
      const purge = args.includes('--purge')
      const profile = await removeProfile(runtime, host, name, purge)
      if (jsonMode) out(serializeWire(wireSuccess('profile.rm', { profile, purged: purge })))
      else out(purge ? `Perfil ${host}/${name} eliminado junto con su sesión.\n` : `Perfil ${host}/${name} quitado; su carpeta sigue en ${profile.configDir}\n`)
      return 0
    }

    return fail('bad_args', `Subcomando desconocido "${sub}".\n${PROFILE_USAGE}`, 2)
  } catch (e) {
    if (e instanceof ProfileError) return fail('profile_error', e.message)
    throw e
  }
}
