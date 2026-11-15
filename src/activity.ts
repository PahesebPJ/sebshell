import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Cross-process registry of in-flight delegations. `sebshell mcp` runs as a child of the host
 * CLI, not of the shell, so it records each seb_delegate turn as a file that the shell's status
 * bar polls. Records are scoped to the shell session that started the chain.
 */
export const SESSION_ENV = 'SEBSHELL_SESSION_ID'

const SESSION_RE = /^[0-9a-f-]{36}$/
const MAX_RECORD_BYTES = 4096
const MAX_LABEL_CHARS = 80

export interface ActivityRecord {
  session: string
  label: string
  pid: number
  startedAt: string
}

export function newSessionId(): string {
  return randomUUID()
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value)
}

export function activityDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const runtime = env.XDG_RUNTIME_DIR
  if (runtime && path.isAbsolute(runtime)) return path.join(runtime, 'sebshell', 'active')
  return path.join(home, '.local', 'state', 'sebshell', 'active')
}

/** Strips control characters: records are rendered in the terminal and any same-user process can write them. */
function cleanLabel(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_LABEL_CHARS)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Records a delegation and returns the function that removes it; never throws (the bar is cosmetic). */
export async function beginActivity(dir: string, session: string, label: string, pid: number = process.pid): Promise<() => Promise<void>> {
  const noop = async () => {}
  if (!isSessionId(session)) return noop
  const file = path.join(dir, `${pid}-${randomBytes(6).toString('hex')}.json`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const record: ActivityRecord = { session, label: cleanLabel(label), pid, startedAt: new Date().toISOString() }
    await writeFile(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch {
    return noop
  }
  return () => rm(file, { force: true }).catch(() => {})
}

/** Labels of live delegations for `session`; records of dead processes are pruned. */
export async function listActivity(dir: string, session: string): Promise<string[]> {
  if (!isSessionId(session)) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const found: ActivityRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      if ((await stat(file)).size > MAX_RECORD_BYTES) continue
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<ActivityRecord>
      if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) continue
      if (!isAlive(raw.pid)) {
        await rm(file, { force: true })
        continue
      }
      if (raw.session !== session || typeof raw.label !== 'string') continue
      found.push({ session, label: cleanLabel(raw.label), pid: raw.pid, startedAt: String(raw.startedAt ?? '') })
    } catch {
      // Half-written or removed between readdir and read: skip it this round.
    }
  }
  return found.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((r) => r.label)
}
