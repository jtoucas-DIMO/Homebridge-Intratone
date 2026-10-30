import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openAccount, parseSettings, type IntratoneSettings } from '../src/config.js';
import type { Session } from '../src/intratoneClient.js';
import { StateStore } from '../src/storage.js';

const SESSION: Session = {
  jwt: 'a.b.c',
  expiresAt: 1_800_000_000_000,
  tel: '0612345678',
  flags: { openingAccess: true, accessRefresh: false, mobipassCompatible: true, mobipass: true },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intratone-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('persists device_id and session across instances', () => {
    const store = new StateStore(dir, 'key');
    store.setDeviceId('DEVICE-1');
    store.saveSession(SESSION);

    const reloaded = new StateStore(dir, 'key');
    expect(reloaded.deviceId).toBe('DEVICE-1');
    expect(reloaded.loadSession()).toEqual(SESSION);
    expect(JSON.parse(readFileSync(join(dir, 'intratone', 'key.json'), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('drops the session when the device_id changes', () => {
    const store = new StateStore(dir, 'key');
    store.setDeviceId('DEVICE-1');
    store.saveSession(SESSION);
    store.setDeviceId('DEVICE-2');

    expect(new StateStore(dir, 'key').loadSession()).toBeUndefined();
  });

  it('refuses a corrupt file rather than minting a new device', () => {
    new StateStore(dir, 'key').setDeviceId('DEVICE-1');
    writeFileSync(join(dir, 'intratone', 'key.json'), '{not json');
    expect(() => new StateStore(dir, 'key')).toThrow(/not valid JSON/);
  });
});

describe('openAccount', () => {
  const settings = parseSettings({ app_id: 'a', app_token: 't', tel: '0612345678' }).settings as IntratoneSettings;

  it('generates a device_id once and reuses it', () => {
    const first = openAccount(settings, dir);
    expect(first.generatedDeviceId).toBe(true);
    expect(first.deviceId).toMatch(/^[0-9A-F-]{36}$/);

    const second = openAccount(settings, dir);
    expect(second.generatedDeviceId).toBe(false);
    expect(second.deviceId).toBe(first.deviceId);
  });

  it('shares state across spellings of the same number', () => {
    const first = openAccount(settings, dir);
    expect(openAccount({ ...settings, tel: '+33 6 12 34 56 78' }, dir).deviceId).toBe(first.deviceId);
  });

  it('lets a configured device_id win and drops the old session', () => {
    const first = openAccount(settings, dir);
    first.store.saveSession(SESSION);

    const configured = openAccount({ ...settings, deviceId: 'E41A0F76-0000-4000-8000-000000000000' }, dir);
    expect(configured.deviceId).toBe('E41A0F76-0000-4000-8000-000000000000');
    expect(configured.client.currentSession).toBeUndefined();
  });
});
