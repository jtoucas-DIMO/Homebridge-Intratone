import type { API, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';

import type { ServiceKind } from './config.js';
import type { Access } from './intratoneClient.js';
import { describeError } from './util.js';

export interface AccessContext {
  access?: Access;
}

export interface AccessAccessoryDeps {
  api: API;
  log: Logging;
  kind: ServiceKind;
  pulseMs: number;
  open: (access: Access) => Promise<void>;
}

/** HomeKit names must start and end with a letter or digit and avoid most punctuation. */
export function homeKitName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} '’.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return cleaned || 'Intratone door';
}

/** Prefix with the residence only when several residences would otherwise be ambiguous. */
export function accessDisplayName(access: Access, withResidence: boolean): string {
  return homeKitName(withResidence && access.residence ? `${access.residence} ${access.name}` : access.name);
}

type Phase = 'closed' | 'opening' | 'open';

/**
 * One Intratone access as a stateless pulse: the server gives no door state, so we show
 * "unlocked/open" for `pulseMs` after a successful open and "locked/closed" otherwise.
 */
export class AccessAccessory {
  private readonly service: Service;
  private access: Access;
  private phase: Phase = 'closed';
  private pulseTimer?: NodeJS.Timeout;

  constructor(
    private readonly accessory: PlatformAccessory<AccessContext>,
    access: Access,
    displayName: string,
    private readonly deps: AccessAccessoryDeps,
  ) {
    const { Service, Characteristic } = deps.api.hap;
    this.access = access;

    const [wanted, unwanted] = deps.kind === 'garage'
      ? [Service.GarageDoorOpener, Service.LockMechanism]
      : [Service.LockMechanism, Service.GarageDoorOpener];
    const stale = accessory.getService(unwanted);
    if (stale) {
      accessory.removeService(stale);
    }
    this.service = accessory.getService(wanted) ?? accessory.addService(wanted, displayName);

    if (deps.kind === 'garage') {
      this.service.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => this.currentValue());
      this.service.getCharacteristic(Characteristic.TargetDoorState)
        .onGet(() => this.targetValue())
        .onSet((value) => this.onTargetSet(value));
      this.service.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => false);
    } else {
      this.service.getCharacteristic(Characteristic.LockCurrentState).onGet(() => this.currentValue());
      this.service.getCharacteristic(Characteristic.LockTargetState)
        .onGet(() => this.targetValue())
        .onSet((value) => this.onTargetSet(value));
    }

    this.update(access, displayName);
    this.push();
  }

  update(access: Access, displayName: string): void {
    const { Service, Characteristic } = this.deps.api.hap;
    this.access = access;
    this.accessory.context.access = access;
    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Intratone')
      .setCharacteristic(Characteristic.Model, `Access (${access.primaryMode.toUpperCase()})`)
      .setCharacteristic(Characteristic.SerialNumber, access.id);
    this.service.setCharacteristic(Characteristic.Name, displayName);
  }

  dispose(): void {
    clearTimeout(this.pulseTimer);
  }

  private onTargetSet(value: CharacteristicValue): void {
    const { Characteristic } = this.deps.api.hap;
    const wantsOpen = this.deps.kind === 'garage'
      ? value === Characteristic.TargetDoorState.OPEN
      : value === Characteristic.LockTargetState.UNSECURED;

    if (wantsOpen) {
      this.trigger();
    } else if (this.phase === 'open') {
      // "Lock" pressed while the pulse is still showing: nothing to send, just settle.
      clearTimeout(this.pulseTimer);
      this.setPhase('closed');
    }
  }

  /** Returns immediately so HomeKit shows "Unlocking…"; the outcome is pushed as state. */
  private trigger(): void {
    if (this.phase !== 'closed') {
      return; // A double tap while opening or showing open sends nothing more.
    }
    const name = this.accessory.displayName;
    this.setPhase('opening');
    this.deps.log.info(`${name}: opening`);
    this.deps.open(this.access).then(
      () => {
        this.deps.log.info(`${name}: opened`);
        this.setPhase('open');
        this.pulseTimer = setTimeout(() => this.setPhase('closed'), this.deps.pulseMs);
      },
      (error: unknown) => {
        this.deps.log.error(`${name}: open failed: ${describeError(error)}`);
        this.setPhase('closed');
      },
    );
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.push();
  }

  private push(): void {
    const { Characteristic } = this.deps.api.hap;
    if (this.deps.kind === 'garage') {
      this.service.updateCharacteristic(Characteristic.TargetDoorState, this.targetValue());
      this.service.updateCharacteristic(Characteristic.CurrentDoorState, this.currentValue());
      this.service.updateCharacteristic(Characteristic.ObstructionDetected, false);
    } else {
      this.service.updateCharacteristic(Characteristic.LockTargetState, this.targetValue());
      this.service.updateCharacteristic(Characteristic.LockCurrentState, this.currentValue());
    }
  }

  private currentValue(): number {
    const { Characteristic } = this.deps.api.hap;
    if (this.deps.kind === 'garage') {
      const { CLOSED, OPENING, OPEN } = Characteristic.CurrentDoorState;
      return this.phase === 'open' ? OPEN : this.phase === 'opening' ? OPENING : CLOSED;
    }
    const { SECURED, UNSECURED } = Characteristic.LockCurrentState;
    return this.phase === 'open' ? UNSECURED : SECURED;
  }

  private targetValue(): number {
    const { Characteristic } = this.deps.api.hap;
    if (this.deps.kind === 'garage') {
      const { CLOSED, OPEN } = Characteristic.TargetDoorState;
      return this.phase === 'closed' ? CLOSED : OPEN;
    }
    const { SECURED, UNSECURED } = Characteristic.LockTargetState;
    return this.phase === 'closed' ? SECURED : UNSECURED;
  }
}
