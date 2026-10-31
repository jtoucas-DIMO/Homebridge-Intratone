import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';

import { AccessAccessory, accessDisplayName, type AccessContext } from './accessAccessory.js';
import { openAccount, parseSettings, type IntratoneSettings } from './config.js';
import {
  IntratoneRateLimitError,
  type Access,
  type AccessList,
  type IntratoneClient,
  type Session,
} from './intratoneClient.js';
import { MatterDoors } from './matterDoors.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { describeError, redactJson } from './util.js';

/** Check the JWT twice a day and refresh it once less than a day is left (it lasts 7). */
const TOKEN_CHECK_MS = 12 * 3600_000;
const TOKEN_MIN_REMAINING_MS = 24 * 3600_000;
/** Lower bound between syncs triggered by the server or by a failed open. */
const MIN_SYNC_GAP_MS = 5 * 60_000;
const RETRY_BASE_MS = 2 * 60_000;

export class IntratonePlatform implements DynamicPlatformPlugin {
  private readonly settings?: IntratoneSettings;
  private readonly cached = new Map<string, PlatformAccessory<AccessContext>>();
  private readonly handlers = new Map<string, AccessAccessory>();
  private readonly reportedSkips = new Set<string>();
  /** Set only when this bridge has Matter enabled (Homebridge 2 with a `matter` block). */
  private readonly matterDoors?: MatterDoors;
  private client?: IntratoneClient;
  private syncTimer?: NodeJS.Timeout;
  private tokenTimer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
  private lastSyncAt = 0;
  private failures = 0;
  private loggedRawList = false;
  private lastEmptyWarning?: string;
  private stopped = false;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    const { settings, errors } = parseSettings(config);
    if (!settings) {
      // Cached accessories are left untouched so HomeKit rooms and automations survive the fix.
      log.error(`Not starting: ${errors.join('; ')}.`);
      return;
    }
    this.settings = settings;
    if (api.matter) {
      this.matterDoors = new MatterDoors({
        matter: api.matter,
        log,
        pulseMs: settings.pulseMs,
        open: (access) => this.openAccess(access),
      });
    }
    api.on('didFinishLaunching', () => {
      void this.start(settings);
    });
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessContext>);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.matterDoors?.configure(accessory);
  }

  private async start(settings: IntratoneSettings): Promise<void> {
    try {
      const account = openAccount(settings, this.api.user.storagePath(), {
        debug: (message) => this.debug(message),
        onSession: (session) => this.onSession(session),
      });
      this.client = account.client;
      if (account.generatedDeviceId) {
        this.log.info(`Generated device_id ${account.deviceId}, stored in ${account.store.file} and reused from now on.`);
      } else {
        this.debug(`Using device_id ${account.deviceId} (state in ${account.store.file})`);
      }
    } catch (error) {
      this.log.error(`Cannot load plugin state: ${describeError(error)}`);
      return;
    }

    // Cached doors work right away with their last known access data, even if the network is down.
    for (const accessory of this.cached.values()) {
      const access = accessory.context.access;
      if (access) {
        this.attach(accessory, access, accessory.displayName);
      }
    }
    if (this.matterDoors) {
      this.log.info('Matter is enabled on this bridge: doors are also exposed as Matter door locks.');
      await this.matterDoors.restore();
    }

    this.tokenTimer = setInterval(() => void this.keepTokenFresh(), TOKEN_CHECK_MS);
    await this.sync();
  }

  private stop(): void {
    this.stopped = true;
    clearTimeout(this.syncTimer);
    clearInterval(this.tokenTimer);
    for (const handler of this.handlers.values()) {
      handler.dispose();
    }
    this.matterDoors?.dispose();
  }

  private onSession(session: Session): void {
    if (session.flags.accessRefresh) {
      this.debug('Server flagged access_refresh');
      this.requestSync();
    }
  }

  /** Syncs soon unless one is running or ran recently; for server hints and failed opens. */
  private requestSync(): void {
    if (!this.syncing && Date.now() - this.lastSyncAt > MIN_SYNC_GAP_MS) {
      void this.sync();
    }
  }

  private async keepTokenFresh(): Promise<void> {
    if (!this.client || this.client.hasValidSession(TOKEN_MIN_REMAINING_MS)) {
      return;
    }
    try {
      await this.client.refresh();
      this.debug('JWT refreshed');
    } catch (error) {
      this.log.warn(`JWT refresh failed, retrying at the next check: ${describeError(error)}`);
    }
  }

  private sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const client = this.client;
    const settings = this.settings;
    if (!client || !settings || this.stopped) {
      return;
    }
    clearTimeout(this.syncTimer);
    this.lastSyncAt = Date.now();
    let delay = settings.accessRefreshMs;

    try {
      const { accesses, raw } = await client.listAccesses();
      if (!this.loggedRawList) {
        this.loggedRawList = true;
        this.debug(`GET /api/access body: ${redactJson(raw)}`);
      }
      this.reportSkipped(accesses);
      if (accesses.openable.length === 0) {
        await this.explainEmpty(client, accesses);
      } else {
        this.lastEmptyWarning = undefined;
      }
      this.reconcile(accesses.openable);
      await this.matterDoors?.reconcile(accesses.openable);
      this.failures = 0;
    } catch (error) {
      this.failures++;
      delay = error instanceof IntratoneRateLimitError
        ? Math.max(error.retryAfterMs, 60_000)
        : Math.min(delay, RETRY_BASE_MS * 2 ** (this.failures - 1));
      this.log.error(`Could not refresh the access list: ${describeError(error)} Retrying in ${Math.ceil(delay / 60_000)} min.`);
    }

    if (!this.stopped) {
      this.syncTimer = setTimeout(() => void this.sync(), delay);
    }
  }

  private reportSkipped(accesses: AccessList): void {
    for (const skipped of accesses.skipped) {
      const key = `${skipped.id}:${skipped.reason}`;
      if (this.reportedSkips.has(key)) {
        continue;
      }
      this.reportedSkips.add(key);
      const label = `"${skipped.name}"${skipped.residence ? ` (${skipped.residence})` : ''}`;
      if (skipped.reason === 'legacy-clemobil') {
        this.log.info(`Skipping ${label}: clemobil (2G) access, the app opens it with a GSM call.`);
      } else {
        this.debug(`Skipping ${label}: ${skipped.reason}, mode "${skipped.mode || 'none'}"`);
      }
    }
  }

  private async explainEmpty(client: IntratoneClient, accesses: AccessList): Promise<void> {
    // The mobipass flags only come with auth/device, so get fresh ones before concluding.
    let flags = client.currentSession?.flags;
    try {
      flags = (await client.refresh()).flags;
    } catch (error) {
      this.debug(`Could not refresh mobipass flags: ${describeError(error)}`);
    }

    let message: string;
    if (flags?.mobipassCompatible && !flags.mobipass) {
      message = 'The mobipass key for this account is active on another device, so no door can be opened from here. ' +
        'Transfer it with `homebridge-intratone activate` (sends an SMS), then `homebridge-intratone verify --otp <code>`. ' +
        'This revokes remote opening on the other device.';
    } else if (accesses.skipped.length) {
      message = `None of the ${accesses.skipped.length} access(es) can be opened through the API.`;
    } else {
      message = 'The account returned no accesses.';
    }
    if (this.cached.size) {
      message += ` Keeping ${this.cached.size} cached door(s) until the list comes back.`;
    }
    if (message !== this.lastEmptyWarning) {
      this.lastEmptyWarning = message;
      this.log.warn(message);
    } else {
      this.debug(message);
    }
  }

  private reconcile(accesses: Access[]): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    const { Categories, uuid } = this.api.hap;
    const category = settings.service === 'garage' ? Categories.GARAGE_DOOR_OPENER : Categories.DOOR_LOCK;
    const multiResidence = new Set(accesses.map((access) => access.residence)).size > 1;
    const seen = new Set<string>();
    const added: PlatformAccessory[] = [];
    const updated: PlatformAccessory[] = [];

    for (const access of accesses) {
      const id = uuid.generate(`intratone:${access.id}`);
      seen.add(id);
      const displayName = accessDisplayName(access, multiResidence);
      const existing = this.cached.get(id);
      if (existing) {
        const changed = JSON.stringify(existing.context.access) !== JSON.stringify(access);
        this.attach(existing, access, displayName);
        if (changed) {
          updated.push(existing);
        }
        continue;
      }
      const accessory = new this.api.platformAccessory<AccessContext>(displayName, id, category);
      accessory.context.access = access;
      this.attach(accessory, access, displayName);
      this.cached.set(id, accessory);
      added.push(accessory);
      this.log.info(`Adding "${displayName}" (${access.residence || 'no residence'}, access ${access.id}, ${access.primaryMode})`);
    }

    if (added.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, added);
    }
    if (updated.length) {
      this.api.updatePlatformAccessories(updated);
    }

    // An empty list is more likely a server hiccup or a moved mobipass key than every door
    // vanishing, and unregistering would wipe the user's rooms and automations.
    if (accesses.length === 0) {
      return;
    }
    const stale = [...this.cached.values()].filter((accessory) => !seen.has(accessory.UUID));
    for (const accessory of stale) {
      this.log.info(`Removing "${accessory.displayName}": no longer in the access list`);
      this.handlers.get(accessory.UUID)?.dispose();
      this.handlers.delete(accessory.UUID);
      this.cached.delete(accessory.UUID);
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private attach(accessory: PlatformAccessory<AccessContext>, access: Access, displayName: string): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    const existing = this.handlers.get(accessory.UUID);
    if (existing) {
      existing.update(access, displayName);
      return;
    }
    this.handlers.set(accessory.UUID, new AccessAccessory(accessory, access, displayName, {
      api: this.api,
      log: this.log,
      kind: settings.service,
      pulseMs: settings.pulseMs,
      open: (target) => this.openAccess(target),
    }));
  }

  private async openAccess(access: Access): Promise<void> {
    if (!this.client) {
      throw new Error('plugin is not connected yet');
    }
    try {
      await this.client.open(access);
    } catch (error) {
      // The access may have moved (mobipass transfer, residence change): re-check soon.
      this.requestSync();
      throw error;
    }
  }

  private debug(message: string): void {
    if (this.settings?.debug) {
      this.log.info(`[debug] ${message}`);
    } else {
      this.log.debug(message);
    }
  }
}
