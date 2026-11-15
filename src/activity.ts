import { constants } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Cross-process registry of in-flight delegations. `sebshell mcp` runs as a child of the host
 * CLI, not of the shell, so it records each seb_delegate turn as a file that the shell's status
 * bar polls. Records are scoped to the shell session that started the chain.
 */
export const SESSION_ENV = 'SEBSHELL_SESSION_ID'

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_RECORD_BYTES = 4096
const MAX_LABEL_CHARS = 80
const MAX_ENTRIES = 256
/** Records older than this are dropped even if their pid is alive (it may have been recycled). */
const STALE_MS = 24 * 60 * 60 * 1000

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

/**
 * Resolved from the passwd home, not from env: the shell and the MCP server run with different
 * environments (host CLIs filter env and profiles may change it) and must agree on the path.
 */
export function activityDir(home: string = os.userInfo().homedir): string {
  return path.join(home, '.local', 'state', 'sebshell', 'active')
}

/** Records are rendered in the terminal and any same-user process can write them: keep plain text only. */
export function cleanLabel(raw: string): string {
  return Array.from(raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, ''))
    .slice(0, MAX_LABEL_CHARS)
    .join('')
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

/** The directory must be a real directory owned by us and closed to others (mkdir keeps existing modes). */
async function trustedDir(dir: string): Promise<boolean> {
  try {
    const st = await lstat(dir)
    if (!st.isDirectory()) return false
    if (process.platform === 'win32') return true
    return st.uid === process.getuid?.() && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

function recordPrefix(session: string): string {
  return `${session}-`
}

/** Records a delegation and returns the function that removes it; never throws (the bar is cosmetic). */
export async function beginActivity(dir: string, session: string, label: string, pid: number = process.pid): Promise<() => Promise<void>> {
  const noop = async () => {}
  if (!isSessionId(session)) return noop
  const file = path.join(dir, `${recordPrefix(session)}${pid}-${randomBytes(6).toString('hex')}.json`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (!(await trustedDir(dir))) return noop
    const record: ActivityRecord = { session, label: cleanLabel(label), pid, startedAt: new Date().toISOString() }
    await writeFile(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch {
    return noop
  }
  return () => rm(file, { force: true }).catch(() => {})
}

/** Reads a record without following symlinks or blocking on FIFOs, capped at MAX_RECORD_BYTES. */
async function readRecord(file: string): Promise<{ raw: Partial<ActivityRecord>; mtimeMs: number } | null> {
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null
    const buf = Buffer.alloc(MAX_RECORD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, MAX_RECORD_BYTES, 0)
    return { raw: JSON.parse(buf.subarray(0, bytesRead).toString('utf8')) as Partial<ActivityRecord>, mtimeMs: st.mtimeMs }
  } finally {
    await fh.close()
  }
}

/** Labels of live delegations for `session`; records of dead processes or stale ones are pruned. */
export async function listActivity(dir: string, session: string, now: number = Date.now()): Promise<string[]> {
  if (!isSessionId(session) || !(await trustedDir(dir))) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const prefix = recordPrefix(session)
  const found: ActivityRecord[] = []
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const name = entry.name
    if (!entry.isFile() || !name.startsWith(prefix) || !name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const rec = await readRecord(file)
      if (!rec) continue
      const { raw } = rec
      if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) continue
      if (!isAlive(raw.pid) || now - rec.mtimeMs > STALE_MS) {
        await rm(file, { force: true })
        continue
      }
      if (raw.session !== session || typeof raw.label !== 'string') continue
      found.push({ session, label: cleanLabel(raw.label), pid: raw.pid, startedAt: String(raw.startedAt ?? '') })
    } catch {
      // Half-written, removed between readdir and read, or not a regular file: skip it.
    }
  }
  return found.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((r) => r.label)
}
