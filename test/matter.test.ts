import type { Logging, MatterAccessory, MatterAPI } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Access } from '../src/intratoneClient.js';
import { MatterDoors, matterLabel } from '../src/matterDoors.js';
import { doorCommand, fakeMatter } from './helpers.js';

function access(id: string, name: string, residence = 'LES TILLEULS'): Access {
  return { id, name, residence, phoneNumber: `0700000000000${id.slice(-1)}`, modes: ['data'], primaryMode: 'data' };
}

let matter: ReturnType<typeof fakeMatter>;
let log: Logging & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let open: ReturnType<typeof vi.fn<(access: Access) => Promise<void>>>;
let doors: MatterDoors;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  matter = fakeMatter();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as typeof log;
  open = vi.fn(async () => {});
  doors = new MatterDoors({ matter: matter as unknown as MatterAPI, log, pulseMs: 2000, open });
});

afterEach(() => {
  doors.dispose();
  vi.useRealTimers();
});

const registered = (): MatterAccessory[] => matter.registerPlatformAccessories.mock.calls.flatMap((call) => call[2]);
const uuidOf = (id: string) => matter.uuid.generate(`intratone:matter:${id}`);

describe('matterLabel', () => {
  it('keeps names within 32 bytes without splitting a character', () => {
    expect(matterLabel('PORTAIL')).toBe('PORTAIL');
    expect(matterLabel('A'.repeat(40))).toBe('A'.repeat(32));
    expect(matterLabel('é'.repeat(20))).toBe('é'.repeat(16));
    expect(matterLabel('RESIDENCE DES TILLEULS PORTAIL NORD')).toBe('RESIDENCE DES TILLEULS PORTAIL N');
    expect(matterLabel('RESIDENCE DES TILLEULS PORTAIL  NORD')).toBe('RESIDENCE DES TILLEULS PORTAIL');
  });
});

describe('MatterDoors', () => {
  it('registers each access as a locked door lock', async () => {
    await doors.reconcile([access('1000001', 'PORTAIL'), access('1000002', 'PIETON')]);

    expect(matter.registerPlatformAccessories).toHaveBeenCalledWith('homebridge-intratone', 'Intratone', expect.any(Array));
    const [portail] = registered();
    expect(registered().map((accessory) => accessory.displayName)).toEqual(['PORTAIL', 'PIETON']);
    expect(portail).toMatchObject({
      UUID: uuidOf('1000001'),
      deviceType: matter.deviceTypes.DoorLock,
      manufacturer: 'Intratone',
      model: 'Access (DATA)',
      serialNumber: '1000001',
      context: { access: access('1000001', 'PORTAIL') },
      clusters: { doorLock: { lockState: 1, lockType: 2, actuatorEnabled: true, operatingMode: 0 } },
    });
  });

  it('opens on unlock and shows locked again after the pulse', async () => {
    await doors.reconcile([access('1000001', 'PORTAIL')]);
    const [portail] = registered();

    await doorCommand(portail!, 'unlockDoor');
    expect(open).toHaveBeenCalledWith(access('1000001', 'PORTAIL'));
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuidOf('1000001'), 'doorLock', { lockState: 1 });
  });

  it('sends one open for repeated unlocks until the pulse ends', async () => {
    let finish!: () => void;
    open.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    await doors.reconcile([access('1000001', 'PORTAIL')]);
    const [portail] = registered();

    const first = doorCommand(portail!, 'unlockDoor');
    const second = doorCommand(portail!, 'unlockDoor');
    finish();
    await Promise.all([first, second]);
    await doorCommand(portail!, 'unlockDoor');
    expect(open).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await doorCommand(portail!, 'unlockDoor');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reports a failed open to the controller and retries on the next unlock', async () => {
    open.mockRejectedValueOnce(new Error('HTTP 403'));
    await doors.reconcile([access('1000001', 'PORTAIL')]);
    const [portail] = registered();

    await expect(doorCommand(portail!, 'unlockDoor')).rejects.toThrow('HTTP 403');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('PORTAIL: open failed (Matter)'));

    await doorCommand(portail!, 'unlockDoor');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('ends the pulse early on lock', async () => {
    await doors.reconcile([access('1000001', 'PORTAIL')]);
    const [portail] = registered();

    await doorCommand(portail!, 'unlockDoor');
    await doorCommand(portail!, 'lockDoor');
    await vi.advanceTimersByTimeAsync(2000);
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();

    await doorCommand(portail!, 'unlockDoor');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('re-attaches handlers to cached doors and resets them to locked', async () => {
    doors.configure({
      UUID: uuidOf('1000001'),
      displayName: 'PORTAIL',
      context: { access: access('1000001', 'PORTAIL') },
    } as unknown as MatterAccessory);

    await doors.restore();
    const [portail] = registered();
    expect(portail?.handlers?.doorLock?.unlockDoor).toBeTypeOf('function');
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuidOf('1000001'), 'doorLock', { lockState: 1 });

    // The first sync finds the same door: nothing to register twice, nothing to announce.
    await doors.reconcile([access('1000001', 'PORTAIL')]);
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Adding'));
  });

  it('updates renamed doors and removes stale ones, but never on an empty list', async () => {
    await doors.reconcile([access('1000001', 'PORTAIL'), access('1000002', 'PIETON')]);

    await doors.reconcile([]);
    expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();

    await doors.reconcile([access('1000001', 'GRAND PORTAIL')]);
    expect(matter.updatePlatformAccessories.mock.calls[0]![0].map((accessory) => accessory.displayName)).toEqual(['GRAND PORTAIL']);
    const removed = matter.unregisterPlatformAccessories.mock.calls[0]![2];
    expect(removed.map((accessory) => accessory.UUID)).toEqual([uuidOf('1000002')]);
  });

  it('retries a failed registration at the next sync', async () => {
    matter.registerPlatformAccessories.mockRejectedValueOnce(new Error('Matter server not started'));

    await doors.reconcile([access('1000001', 'PORTAIL')]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not register the Matter door'));

    await doors.reconcile([access('1000001', 'PORTAIL')]);
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
  });
});
