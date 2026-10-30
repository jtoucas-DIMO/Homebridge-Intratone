import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessAccessory, type AccessContext } from '../src/accessAccessory.js';
import type { Access } from '../src/intratoneClient.js';

const { Characteristic, Service } = hap;
const ACCESS: Access = { id: '1000001', residence: 'LES TILLEULS', name: 'PORTAIL', phoneNumber: '0700', modes: ['data'], primaryMode: 'data' };
const api = { hap } as unknown as API;

/** The parts of PlatformAccessory the handler uses, backed by a real HAP accessory. */
function makeAccessory() {
  const uuid = hap.uuid.generate('intratone:test');
  const inner = new hap.Accessory('PORTAIL', uuid);
  const accessory = {
    UUID: uuid,
    displayName: 'PORTAIL',
    context: {},
    getService: inner.getService.bind(inner),
    addService: inner.addService.bind(inner),
    removeService: inner.removeService.bind(inner),
  } as unknown as PlatformAccessory<AccessContext>;
  return { accessory, inner };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let log: Logging;

beforeEach(() => {
  vi.useFakeTimers();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LockMechanism', () => {
  function setup() {
    const { accessory, inner } = makeAccessory();
    const call = deferred();
    const open = vi.fn(() => call.promise);
    new AccessAccessory(accessory, ACCESS, 'PORTAIL', { api, log, kind: 'lock', pulseMs: 2000, open });
    const service = inner.getService(Service.LockMechanism)!;
    return {
      accessory,
      inner,
      call,
      open,
      target: service.getCharacteristic(Characteristic.LockTargetState),
      current: service.getCharacteristic(Characteristic.LockCurrentState),
    };
  }

  it('pulses unlocked after a successful open, then relocks', async () => {
    const { call, open, target, current, accessory, inner } = setup();
    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED);
    expect(accessory.context.access).toEqual(ACCESS);
    expect(inner.getService(Service.AccessoryInformation)!.getCharacteristic(Characteristic.SerialNumber).value).toBe('1000001');

    await target.setValue(Characteristic.LockTargetState.UNSECURED);
    expect(open).toHaveBeenCalledWith(ACCESS);
    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED); // "Unlocking…" until the server answers

    call.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(current.value).toBe(Characteristic.LockCurrentState.UNSECURED);

    await vi.advanceTimersByTimeAsync(2000);
    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED);
    expect(target.value).toBe(Characteristic.LockTargetState.SECURED);
  });

  it('ignores taps while an open is in flight or showing', async () => {
    const { call, open, target } = setup();
    await target.setValue(Characteristic.LockTargetState.UNSECURED);
    await target.setValue(Characteristic.LockTargetState.UNSECURED);
    call.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await target.setValue(Characteristic.LockTargetState.UNSECURED);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('relocks and logs when the open fails', async () => {
    const { call, target, current } = setup();
    await target.setValue(Characteristic.LockTargetState.UNSECURED);
    call.reject(new Error('Open refused (HTTP 200: {"error":1})'));
    await vi.advanceTimersByTimeAsync(0);

    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED);
    expect(target.value).toBe(Characteristic.LockTargetState.SECURED);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Open refused'));
  });

  it('settles at once when locked during the pulse', async () => {
    const { call, target, current } = setup();
    await target.setValue(Characteristic.LockTargetState.UNSECURED);
    call.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await target.setValue(Characteristic.LockTargetState.SECURED);
    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED);
  });
});

describe('GarageDoorOpener', () => {
  it('cycles OPENING → OPEN → CLOSED', async () => {
    const { accessory, inner } = makeAccessory();
    const call = deferred();
    new AccessAccessory(accessory, ACCESS, 'PORTAIL', { api, log, kind: 'garage', pulseMs: 3000, open: () => call.promise });
    const service = inner.getService(Service.GarageDoorOpener)!;
    const current = service.getCharacteristic(Characteristic.CurrentDoorState);

    expect(current.value).toBe(Characteristic.CurrentDoorState.CLOSED);
    expect(service.getCharacteristic(Characteristic.ObstructionDetected).value).toBe(false);

    await service.getCharacteristic(Characteristic.TargetDoorState).setValue(Characteristic.TargetDoorState.OPEN);
    expect(current.value).toBe(Characteristic.CurrentDoorState.OPENING);

    call.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(current.value).toBe(Characteristic.CurrentDoorState.OPEN);

    await vi.advanceTimersByTimeAsync(3000);
    expect(current.value).toBe(Characteristic.CurrentDoorState.CLOSED);
  });

  it('replaces a cached lock service when the service type changes', () => {
    const { accessory, inner } = makeAccessory();
    new AccessAccessory(accessory, ACCESS, 'PORTAIL', { api, log, kind: 'lock', pulseMs: 2000, open: vi.fn() });
    new AccessAccessory(accessory, ACCESS, 'PORTAIL', { api, log, kind: 'garage', pulseMs: 2000, open: vi.fn() });

    expect(inner.getService(Service.LockMechanism)).toBeUndefined();
    expect(inner.getService(Service.GarageDoorOpener)).toBeDefined();
  });
});
