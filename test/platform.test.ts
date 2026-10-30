import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IntratonePlatform } from '../src/platform.js';
import { authBody, fakeFetch, makeJwt } from './helpers.js';

/** The parts of PlatformAccessory the plugin uses, backed by a real HAP accessory. */
class FakePlatformAccessory {
  readonly context: Record<string, unknown> = {};
  readonly getService: hap.Accessory['getService'];
  readonly addService: hap.Accessory['addService'];
  readonly removeService: hap.Accessory['removeService'];

  constructor(readonly displayName: string, readonly UUID: string) {
    const inner = new hap.Accessory(displayName, UUID);
    this.getService = inner.getService.bind(inner);
    this.addService = inner.addService.bind(inner);
    this.removeService = inner.removeService.bind(inner);
  }
}

function access(id: string, name: string, residence = 'LES TILLEULS') {
  return { residence, id, name, phonenumber: `0700000000000${id.slice(-1)}`, openmode: ['DATA'] };
}

function listBody(items: unknown[]) {
  return { error: 0, state: 'ok', data: { list: items } };
}

let dir: string;
let listeners: Record<string, () => void>;
let api: API & { registerPlatformAccessories: ReturnType<typeof vi.fn>; unregisterPlatformAccessories: ReturnType<typeof vi.fn> };
let log: Logging & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let accessItems: unknown[];
let authFlags: Record<string, unknown>;

const CONFIG = { platform: 'Intratone', app_id: 'APP', app_token: 'TOKEN', tel: '0612345678' } as unknown as PlatformConfig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  dir = mkdtempSync(join(tmpdir(), 'intratone-platform-'));
  listeners = {};
  accessItems = [access('1000001', 'PORTAIL'), access('1000002', 'PIETON')];
  authFlags = {};
  const { fetch } = fakeFetch((request) =>
    request.path === '/api/auth/device'
      ? { body: authBody(makeJwt(Date.now() / 1000 + 7 * 86400), authFlags) }
      : { body: listBody(accessItems) },
  );
  vi.stubGlobal('fetch', fetch);
  api = {
    hap,
    user: { storagePath: () => dir },
    platformAccessory: FakePlatformAccessory,
    on: (event: string, listener: () => void) => {
      listeners[event] = listener;
    },
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  } as unknown as typeof api;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as typeof log;
});

afterEach(() => {
  listeners.shutdown?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function launch(platform = new IntratonePlatform(log, CONFIG, api)) {
  listeners.didFinishLaunching?.();
  await vi.advanceTimersByTimeAsync(0);
  return platform;
}

const registered = (): PlatformAccessory[] => api.registerPlatformAccessories.mock.calls.flatMap((call) => call[2] as PlatformAccessory[]);

describe('IntratonePlatform', () => {
  it('registers one accessory per openable access', async () => {
    await launch();

    expect(registered().map((accessory) => accessory.displayName)).toEqual(['PORTAIL', 'PIETON']);
    expect(api.registerPlatformAccessories).toHaveBeenCalledWith('homebridge-intratone', 'Intratone', expect.any(Array));
    expect(registered()[0]!.getService(hap.Service.LockMechanism)).toBeDefined();
  });

  it('prefixes names with the residence when there are several', async () => {
    accessItems = [access('1000001', 'PORTAIL', 'NORD'), access('1000002', 'PORTAIL', 'SUD')];
    await launch();
    expect(registered().map((accessory) => accessory.displayName)).toEqual(['NORD PORTAIL', 'SUD PORTAIL']);
  });

  it('removes accessories that left the list at the next refresh', async () => {
    await launch();
    accessItems = [access('1000001', 'PORTAIL')];

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
    const removed = api.unregisterPlatformAccessories.mock.calls[0]![2] as PlatformAccessory[];
    expect(removed.map((accessory) => accessory.displayName)).toEqual(['PIETON']);
  });

  it('keeps cached doors and explains when the mobipass key is elsewhere', async () => {
    await launch();
    listeners.shutdown?.();
    const cached = registered();

    // Next Homebridge start: the key moved to another phone, so the list is empty.
    accessItems = [];
    authFlags = { mobipass_compatible: 1, mobipass: 0 };
    api.registerPlatformAccessories.mockClear();
    const platform = new IntratonePlatform(log, CONFIG, api);
    for (const accessory of cached) {
      platform.configureAccessory(accessory);
    }
    await launch(platform);

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('active on another device'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Keeping 2 cached door(s)'));
  });

  it('logs clemobil accesses once as unsupported', async () => {
    accessItems = [access('1000001', 'PORTAIL'), { id: '1000009', name: 'VIEUX', residence: 'X', phonenumber: '1', openmode: 'clemobil' }];
    await launch();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    const clemobilLogs = log.info.mock.calls.filter((call) => String(call[0]).includes('clemobil'));
    expect(clemobilLogs).toHaveLength(1);
    expect(registered().map((accessory) => accessory.displayName)).toEqual(['PORTAIL']);
  });

  it('does not start without credentials and leaves cached accessories alone', async () => {
    new IntratonePlatform(log, { platform: 'Intratone' } as unknown as PlatformConfig, api);
    expect(listeners.didFinishLaunching).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('app_id is required'));
  });
});
