import type { Logging, MatterAccessory, MatterAPI } from 'homebridge';

import { accessDisplayName, type AccessContext } from './accessAccessory.js';
import type { Access } from './intratoneClient.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { describeError } from './util.js';

export interface MatterDoorsDeps {
  matter: MatterAPI;
  log: Logging;
  pulseMs: number;
  open: (access: Access) => Promise<void>;
}

/** Matter caps a bridged device's label at 32 bytes, and Homebridge passes it through as is. */
export function matterLabel(name: string): string {
  let label = '';
  for (const char of name) {
    if (Buffer.byteLength(label + char) > 32) {
      break;
    }
    label += char;
  }
  return label.trimEnd() || 'Intratone door';
}

/**
 * One access as a Matter door lock, with the same pulse as the HomeKit side: "unlocked" for
 * `pulseMs` after a successful open, "locked" otherwise.
 */
class MatterDoor {
  private opening?: Promise<void>;
  private pulseTimer?: NodeJS.Timeout;

  constructor(
    readonly uuid: string,
    public access: Access,
    public displayName: string,
    private readonly deps: MatterDoorsDeps,
  ) {}

  toAccessory(): MatterAccessory<AccessContext> {
    const { deviceTypes, types } = this.deps.matter;
    return {
      UUID: this.uuid,
      displayName: this.displayName,
      deviceType: deviceTypes.DoorLock,
      manufacturer: 'Intratone',
      model: `Access (${this.access.primaryMode.toUpperCase()})`,
      serialNumber: this.access.id,
      context: { access: this.access },
      clusters: {
        doorLock: {
          lockState: types.DoorLock.LockState.Locked,
          lockType: types.DoorLock.LockType.Other,
          actuatorEnabled: true,
          operatingMode: types.DoorLock.OperatingMode.Normal,
        },
      },
      handlers: {
        doorLock: {
          lockDoor: () => this.lock(),
          unlockDoor: () => this.unlock(),
        },
      },
    };
  }

  /** Pushes "locked" outside a command handler, where Homebridge does not update state itself. */
  setLocked(): void {
    const { matter, log } = this.deps;
    matter.updateAccessoryState(this.uuid, 'doorLock', { lockState: matter.types.DoorLock.LockState.Locked })
      .catch((error: unknown) => log.warn(`${this.displayName}: could not reset the Matter lock state: ${describeError(error)}`));
  }

  dispose(): void {
    clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
  }

  /** Resolving lets Homebridge show the door unlocked; rejecting reports a failure to the controller. */
  private unlock(): Promise<void> {
    if (this.pulseTimer) {
      return Promise.resolve(); // Still showing unlocked from the last open: nothing more to send.
    }
    // A second unlock while the first is in flight waits for the same open.
    this.opening ??= this.openOnce().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openOnce(): Promise<void> {
    const { log, open, pulseMs } = this.deps;
    const name = this.displayName;
    log.info(`${name}: opening (Matter)`);
    try {
      await open(this.access);
    } catch (error) {
      log.error(`${name}: open failed (Matter): ${describeError(error)}`);
      throw error;
    }
    log.info(`${name}: opened (Matter)`);
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined;
      this.setLocked();
    }, pulseMs);
  }

  /** The door relocks by itself, so "lock" only ends the unlocked pulse early. */
  private lock(): void {
    this.dispose();
  }
}

/** Mirrors the openable accesses as Matter door locks on bridges where Matter is enabled. */
export class MatterDoors {
  private readonly cached = new Map<string, MatterAccessory<AccessContext>>();
  private readonly doors = new Map<string, MatterDoor>();

  constructor(private readonly deps: MatterDoorsDeps) {}

  configure(accessory: MatterAccessory): void {
    this.cached.set(accessory.UUID, accessory as MatterAccessory<AccessContext>);
  }

  /**
   * Homebridge restores cached Matter doors without their handlers. Registering them again
   * attaches the handlers, so cached doors work before the first sync.
   */
  async restore(): Promise<void> {
    for (const accessory of this.cached.values()) {
      const access = accessory.context.access;
      if (access && !this.doors.has(accessory.UUID)) {
        await this.add(accessory.UUID, access, accessory.displayName);
      }
    }
  }

  /** Never throws: a Matter failure must not hold up the HomeKit side. */
  async reconcile(accesses: Access[]): Promise<void> {
    const { matter, log } = this.deps;
    const multiResidence = new Set(accesses.map((access) => access.residence)).size > 1;
    const seen = new Set<string>();
    const updated: MatterAccessory[] = [];

    for (const access of accesses) {
      const uuid = matter.uuid.generate(`intratone:matter:${access.id}`);
      seen.add(uuid);
      const displayName = matterLabel(accessDisplayName(access, multiResidence));
      const door = this.doors.get(uuid);
      if (!door) {
        if (!this.cached.has(uuid)) {
          log.info(`Adding "${displayName}" to Matter (access ${access.id})`);
        }
        await this.add(uuid, access, displayName);
      } else if (door.displayName !== displayName || JSON.stringify(door.access) !== JSON.stringify(access)) {
        door.access = access;
        door.displayName = displayName;
        updated.push(door.toAccessory());
      }
    }

    if (updated.length) {
      try {
        await matter.updatePlatformAccessories(updated);
      } catch (error) {
        log.warn(`Could not update cached Matter doors: ${describeError(error)}`);
      }
    }

    // Same rule as HomeKit: an empty list never removes doors.
    if (accesses.length === 0) {
      return;
    }
    const stale: MatterAccessory[] = [];
    for (const uuid of new Set([...this.cached.keys(), ...this.doors.keys()])) {
      if (seen.has(uuid)) {
        continue;
      }
      const door = this.doors.get(uuid);
      const accessory = door?.toAccessory() ?? this.cached.get(uuid);
      if (accessory) {
        log.info(`Removing "${accessory.displayName}" from Matter: no longer in the access list`);
        stale.push(accessory);
      }
      door?.dispose();
      this.doors.delete(uuid);
      this.cached.delete(uuid);
    }
    if (stale.length) {
      try {
        await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      } catch (error) {
        log.warn(`Could not remove stale Matter doors: ${describeError(error)}`);
      }
    }
  }

  dispose(): void {
    for (const door of this.doors.values()) {
      door.dispose();
    }
  }

  private async add(uuid: string, access: Access, displayName: string): Promise<void> {
    const door = new MatterDoor(uuid, access, displayName, this.deps);
    try {
      await this.deps.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [door.toAccessory()]);
    } catch (error) {
      this.deps.log.warn(`${displayName}: could not register the Matter door, retrying at the next sync: ${describeError(error)}`);
      return;
    }
    this.doors.set(uuid, door);
    if (this.cached.has(uuid)) {
      // The cache can hold "unlocked" if Homebridge stopped during a pulse.
      door.setLocked();
    }
  }
}
