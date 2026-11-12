// Custom settings UI backend for homebridge-config-ui-x.
// Talks to the Intratone API directly from the settings page: resolves the device id, reports
// whether this device holds the 4G door key, claims the key by SMS, and lists the doors.
// Loaded by the UI only (never by Homebridge itself); reuses the plugin's own account code, and
// the same storage path, so it acts as the same device as the running plugin.
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { openAccount, parseSettings } from '../dist/config.js';

class IntratoneUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/device', (payload) => this.device(payload));
    this.onRequest('/status', (payload) => this.status(payload));
    this.onRequest('/accesses', (payload) => this.listAccesses(payload));
    this.onRequest('/pair/start', (payload) => this.pairStart(payload));
    this.onRequest('/pair/finish', (payload) => this.pairFinish(payload));
    this.onRequest('/claim/start', (payload) => this.claimStart(payload));
    this.onRequest('/claim/finish', (payload) => this.claimFinish(payload));
    this.ready();
  }

  /**
   * Parses the config posted by the page (saved or not) and opens the account against the real
   * storage path.
   *
   * @param {{ config?: unknown }} payload
   */
  account(payload) {
    const { settings, errors } = parseSettings(payload?.config ?? {});
    if (!settings) {
      throw new RequestError('Enter the phone number first.', { errors });
    }
    return { ...openAccount(settings, this.homebridgeStoragePath), settings };
  }

  /** Runs an API call and turns its error into a RequestError carrying the Intratone code. */
  async call(fn) {
    try {
      return await fn();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new RequestError(error instanceof Error ? error.message : String(error), { code });
    }
  }

  /** The effective device id (config, else stored, else newly generated) — no network call. */
  device(payload) {
    const account = this.account(payload);
    return { deviceId: account.deviceId, generatedDeviceId: account.generatedDeviceId };
  }

  /**
   * Signs in and reports the door-key state. A device the server has never seen answers
   * DEVICE_INVALID; that is reported as `needsPairing` so the page shows the pairing step.
   */
  async status(payload) {
    const account = this.account(payload);
    try {
      const session = await account.client.refresh();
      return {
        deviceId: account.deviceId,
        needsPairing: false,
        mobipassCompatible: session.flags.mobipassCompatible,
        mobipass: session.flags.mobipass,
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'DEVICE_INVALID') {
        return { deviceId: account.deviceId, needsPairing: true, mobipassCompatible: false, mobipass: false };
      }
      throw new RequestError(error instanceof Error ? error.message : String(error), { code });
    }
  }

  /** Registers this device and asks Intratone to text the 4-digit device code. */
  async pairStart(payload) {
    const account = this.account(payload);
    await this.call(() => account.client.register());
    return { smsSent: true };
  }

  /** Confirms the 4-digit device code, then signs in to report the door-key state. */
  async pairFinish(payload) {
    const code = String(payload?.code ?? '').replace(/\s+/g, '');
    if (!code) {
      throw new RequestError('Enter the code from the SMS.', {});
    }
    const account = this.account(payload);
    await this.call(() => account.client.validate(code));
    const session = await this.call(() => account.client.refresh());
    return { mobipassCompatible: session.flags.mobipassCompatible, mobipass: session.flags.mobipass };
  }

  /** Asks Intratone to text a claim code, unless this device already holds the key. */
  async claimStart(payload) {
    const account = this.account(payload);
    const session = await this.call(() => account.client.refresh());
    if (session.flags.mobipass) {
      return { alreadyHeld: true };
    }
    const result = await this.call(() => account.client.mobipassActivate());
    return { smsSent: true, code: result.code ?? null };
  }

  /** Completes the claim with the SMS code; the key then moves to this device. */
  async claimFinish(payload) {
    const otp = String(payload?.code ?? payload?.otp ?? '').replace(/\s+/g, '');
    if (!otp) {
      throw new RequestError('Enter the code from the SMS.', {});
    }
    const account = this.account(payload);
    await this.call(() => account.client.mobipassVerify(otp));
    const session = await this.call(() => account.client.refresh());
    return { mobipass: session.flags.mobipass };
  }

  async listAccesses(payload) {
    const account = this.account(payload);
    const { accesses } = await this.call(() => account.client.listAccesses());
    const pick = (list) => list.map((access) => ({ id: access.id, residence: access.residence, name: access.name }));
    return { openable: pick(accesses.openable), skipped: pick(accesses.skipped) };
  }
}

(() => new IntratoneUiServer())();
