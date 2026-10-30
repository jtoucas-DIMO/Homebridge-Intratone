import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session, SessionStore } from './intratoneClient.js';
import { isRecord } from './util.js';

interface PersistedState {
  version: 1;
  deviceId?: string;
  session?: Session;
}

/**
 * Stable per-account file key. Hashing keeps the phone number out of file names, and
 * normalizing means "06…", "+33 6…" and "0033 6…" share one device_id.
 */
export function accountKey(tel: string, indicatif: string): string {
  const raw = tel.trim();
  const digits = raw.replace(/\D/g, '');
  let national = digits;
  if (raw.startsWith('+') && digits.startsWith(indicatif)) {
    national = digits.slice(indicatif.length);
  } else if (digits.startsWith(`00${indicatif}`)) {
    national = digits.slice(2 + indicatif.length);
  }
  national = national.replace(/^0+/, '');
  return createHash('sha256').update(`${indicatif}:${national}`).digest('hex').slice(0, 16);
}

function isSession(value: unknown): value is Session {
  return isRecord(value) && typeof value.jwt === 'string' && typeof value.expiresAt === 'number' &&
    typeof value.tel === 'string' && isRecord(value.flags);
}

/** Persists device_id and the current session in `<storagePath>/intratone/<account>.json`. */
export class StateStore implements SessionStore {
  readonly file: string;
  private state: PersistedState;

  constructor(storagePath: string, key: string) {
    this.file = join(storagePath, 'intratone', `${key}.json`);
    this.state = this.read();
  }

  get deviceId(): string | undefined {
    return this.state.deviceId;
  }

  /** Changing the device_id drops the session: its JWT is bound to the old one. */
  setDeviceId(deviceId: string): void {
    if (this.state.deviceId === deviceId) {
      return;
    }
    this.state = { version: 1, deviceId };
    this.write();
  }

  loadSession(): Session | undefined {
    return this.state.session;
  }

  saveSession(session: Session): void {
    this.state = { ...this.state, session };
    this.write();
  }

  private read(): PersistedState {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1 };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Refuse to silently mint a new device_id: that would look like a brand-new phone.
      throw new Error(`${this.file} is not valid JSON. Fix or delete it (deleting registers a new device_id).`);
    }
    if (!isRecord(parsed)) {
      return { version: 1 };
    }
    return {
      version: 1,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined,
      session: isSession(parsed.session) ? parsed.session : undefined,
    };
  }

  private write(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
