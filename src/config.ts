import { randomUUID } from 'node:crypto';

import { DEFAULT_APP_IDS, IntratoneClient, type ClientIdentity, type Session } from './intratoneClient.js';
import { StateStore, accountKey } from './storage.js';
import { isRecord, str } from './util.js';

export type ServiceKind = 'lock' | 'garage';

export interface IntratoneSettings {
  name: string;
  appId: string;
  appToken: string;
  tel: string;
  indicatif: string;
  deviceId?: string;
  service: ServiceKind;
  pulseMs: number;
  accessRefreshMs: number;
  identity: ClientIdentity;
  appVersion: string;
  debug: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Validates the platform block from config.json. Returns errors instead of throwing. */
export function parseSettings(raw: unknown): { settings?: IntratoneSettings; errors: string[] } {
  const config = isRecord(raw) ? raw : {};
  const errors: string[] = [];
  const identity: ClientIdentity = config.user_agent === 'android' ? 'android' : 'ios';
  const appId = str(config.app_id) || DEFAULT_APP_IDS[identity] || '';
  const appToken = str(config.app_token);
  const tel = str(config.tel);
  const indicatif = (str(config.indicatif) || '33').replace(/^\+/, '');
  const deviceId = str(config.device_id) || undefined;

  if (!appId) {
    errors.push(`app_id is required: there is no default for the ${identity} app`);
  }
  if (!appToken) {
    errors.push('app_token is required');
  }
  if (!tel) {
    errors.push('tel is required');
  }
  if (!/^\d{1,4}$/.test(indicatif)) {
    errors.push(`indicatif must be 1-4 digits, got "${indicatif}"`);
  }
  if (deviceId && !UUID_RE.test(deviceId)) {
    errors.push('device_id must be a UUID (or empty to generate one)');
  }
  if (errors.length) {
    return { errors };
  }

  return {
    errors,
    settings: {
      name: str(config.name) || 'Intratone',
      appId,
      appToken,
      tel,
      indicatif,
      deviceId,
      service: config.service === 'garage' ? 'garage' : 'lock',
      pulseMs: clamp(config.pulse_seconds, 2, 1, 30) * 1000,
      accessRefreshMs: clamp(config.access_refresh_minutes, 60, 15, 1440) * 60_000,
      identity,
      appVersion: str(config.app_version) || '4.6.4',
      debug: config.debug === true,
    },
  };
}

export interface Account {
  client: IntratoneClient;
  store: StateStore;
  deviceId: string;
  /** Set when this run minted a new device_id (first start, nothing configured). */
  generatedDeviceId: boolean;
}

/**
 * Resolves the device_id (config wins, else stored, else a new UUID kept forever) and builds a
 * client whose session persists next to it. Shared by the platform and the CLI so both
 * act as the same device.
 */
export function openAccount(
  settings: IntratoneSettings,
  storagePath: string,
  hooks: { debug?: (message: string) => void; onSession?: (session: Session) => void } = {},
): Account {
  const store = new StateStore(storagePath, accountKey(settings.tel, settings.indicatif));
  let deviceId = settings.deviceId ?? store.deviceId;
  const generatedDeviceId = !deviceId;
  deviceId ??= randomUUID().toUpperCase();
  store.setDeviceId(deviceId);

  const client = new IntratoneClient({
    appId: settings.appId,
    appToken: settings.appToken,
    tel: settings.tel,
    indicatif: settings.indicatif,
    deviceId,
    appVersion: settings.appVersion,
    identity: settings.identity,
    store,
    debug: hooks.debug,
    onSession: hooks.onSession,
  });
  return { client, store, deviceId, generatedDeviceId };
}
