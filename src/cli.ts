#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openAccount, parseSettings, type Account } from './config.js';
import { decodeJwtPayload, type AccessList, type MobipassFlags } from './intratoneClient.js';
import { PLATFORM_NAME } from './settings.js';
import { describeError, isRecord, str } from './util.js';

const USAGE = `Usage: homebridge-intratone <command> [options]

Commands:
  status               Show the stored device_id, JWT expiry and mobipass flags
  login                Authenticate now (auth/device) and show the mobipass flags
  list                 List accesses and whether each can be opened here
  open <access_id>     Open one access (to test without HomeKit)
  activate             Start a mobipass transfer: texts a code to the account phone
  verify --otp <code>  Finish the transfer. Revokes remote opening on the previous device

Options:
  -U, --user-storage-path <dir>  Homebridge storage directory (default ~/.homebridge)
  -c, --config <file>            config.json to read (default <storage>/config.json)
      --otp <code>               SMS code for verify
      --debug                    Print requests and responses (tokens masked)
  -h, --help                     Show this help

Run it as the user Homebridge runs as (e.g. sudo -u homebridge …), so it shares the
plugin's stored device_id and JWT.`;

function loadPlatformBlock(configPath: string): unknown {
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  const platforms = isRecord(config) && Array.isArray(config.platforms) ? config.platforms : [];
  const block: unknown = platforms.find((platform: unknown) => isRecord(platform) && platform.platform === PLATFORM_NAME);
  if (!block) {
    throw new Error(`No "${PLATFORM_NAME}" platform block in ${configPath}`);
  }
  return block;
}

function formatFlags(flags: MobipassFlags): string {
  const verdict = flags.mobipassCompatible && !flags.mobipass
    ? 'key is held by another device: run `activate` then `verify --otp <code>`'
    : flags.mobipass
      ? 'key is active on this device'
      : 'account is not mobipass-only';
  return [
    `  openingaccess        ${flags.openingAccess}`,
    `  access_refresh       ${flags.accessRefresh}`,
    `  mobipass_compatible  ${flags.mobipassCompatible}`,
    `  mobipass             ${flags.mobipass}`,
    `  → ${verdict}`,
  ].join('\n');
}

function printAccesses(accesses: AccessList): void {
  if (!accesses.openable.length && !accesses.skipped.length) {
    console.log('No accesses returned.');
    return;
  }
  for (const access of accesses.openable) {
    console.log(`  ✔ ${access.id.padEnd(10)} ${access.residence} / ${access.name}  [${access.modes.join(',')}]`);
  }
  for (const skipped of accesses.skipped) {
    console.log(`  ✘ ${(skipped.id || '?').padEnd(10)} ${skipped.residence} / ${skipped.name}  [${skipped.mode || 'none'}: ${skipped.reason}]`);
  }
}

async function run(command: string, args: string[], otp: string | undefined, account: Account): Promise<void> {
  const { client, store } = account;
  switch (command) {
    case 'status': {
      console.log(`device_id   ${account.deviceId}${account.generatedDeviceId ? ' (just generated)' : ''}`);
      console.log(`state file  ${store.file}`);
      const session = client.currentSession;
      if (!session) {
        console.log('session     none (run `login`)');
        return;
      }
      const claims = decodeJwtPayload(session.jwt) ?? {};
      const valid = client.hasValidSession() ? 'valid' : 'EXPIRED';
      console.log(`session     ${valid} until ${new Date(session.expiresAt).toISOString()}`);
      console.log(`smartphone  ${session.smartphoneId ?? str(claims.id)}  (JWT device "${str(claims.device)}")`);
      if (str(claims.device_id) && str(claims.device_id) !== account.deviceId) {
        console.log(`WARNING     JWT device_id ${str(claims.device_id)} differs from ${account.deviceId}`);
      }
      console.log(`mobipass flags (from the last login):\n${formatFlags(session.flags)}`);
      return;
    }
    case 'login': {
      const session = await client.refresh();
      console.log(`Authenticated; JWT valid until ${new Date(session.expiresAt).toISOString()}`);
      console.log(formatFlags(session.flags));
      return;
    }
    case 'list': {
      printAccesses((await client.listAccesses()).accesses);
      return;
    }
    case 'open': {
      const id = args[0];
      if (!id) {
        throw new Error('open needs an access_id (see `list`)');
      }
      const { accesses } = await client.listAccesses();
      const access = accesses.openable.find((candidate) => candidate.id === id);
      if (!access) {
        throw new Error(`Access ${id} is not in the openable list (see \`list\`)`);
      }
      await client.open(access);
      console.log(`Opened ${access.residence} / ${access.name}`);
      return;
    }
    case 'activate': {
      const result = await client.mobipassActivate();
      console.log(`${result.code ?? 'OK'}: an SMS code is on its way to the account phone.`);
      console.log('Finish with: homebridge-intratone verify --otp <code>');
      console.log('Verifying moves the key here and revokes remote opening on the device that holds it now.');
      return;
    }
    case 'verify': {
      if (!otp) {
        throw new Error('verify needs --otp <code>');
      }
      const result = await client.mobipassVerify(otp);
      console.log(`${result.code ?? 'OK'}: mobipass transferred to this device.`);
      const session = await client.refresh();
      console.log(formatFlags(session.flags));
      printAccesses((await client.listAccesses()).accesses);
      console.log('Homebridge picks the doors up at its next access refresh, or restart the child bridge now.');
      return;
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'user-storage-path': { type: 'string', short: 'U' },
      config: { type: 'string', short: 'c' },
      otp: { type: 'string' },
      debug: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const configPath = values.config
    ? resolve(values.config)
    : join(resolve(values['user-storage-path'] ?? join(homedir(), '.homebridge')), 'config.json');
  const storagePath = values['user-storage-path'] ? resolve(values['user-storage-path']) : dirname(configPath);

  const { settings, errors } = parseSettings(loadPlatformBlock(configPath));
  if (!settings) {
    throw new Error(`Invalid ${PLATFORM_NAME} config in ${configPath}: ${errors.join('; ')}`);
  }
  const debug = values.debug || settings.debug;
  const account = openAccount(settings, storagePath, {
    debug: debug ? (message) => console.error(`[debug] ${message}`) : undefined,
  });
  await run(command, args, values.otp, account);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Error: ${describeError(error)}`);
    process.exitCode = 1;
  },
);
