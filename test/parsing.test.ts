import { describe, expect, it } from 'vitest';

import { accessDisplayName, homeKitName } from '../src/accessAccessory.js';
import { parseSettings } from '../src/config.js';
import { decodeJwtPayload, isOkBody, parseAccessList, phoneCandidates } from '../src/intratoneClient.js';
import { accountKey } from '../src/storage.js';
import { redact, redactJson, truthy } from '../src/util.js';
import { ACCESS_LIST_BODY, makeJwt } from './helpers.js';

describe('parseAccessList', () => {
  it('accepts the captured iOS shape with upper-case DATA modes', () => {
    const { openable, skipped } = parseAccessList(ACCESS_LIST_BODY);
    expect(skipped).toEqual([]);
    expect(openable).toEqual([
      { id: '1000001', residence: 'LES TILLEULS', name: 'PORTAIL', phoneNumber: '07000000000001', modes: ['data'], primaryMode: 'data' },
      { id: '1000002', residence: 'LES TILLEULS', name: 'PIETON', phoneNumber: '07000000000002', modes: ['data'], primaryMode: 'data' },
    ]);
  });

  it('dispatches on the first mode only', () => {
    const { openable, skipped } = parseAccessList({
      data: {
        list: [
          { id: 1, phonenumber: '0700', openmode: 'ble' },
          { id: 2, phonenumber: '0701', openmode: ['clemobil', 'data'] },
          { id: 3, phonenumber: '0702', openmode: 'data,ble' },
        ],
      },
    });
    expect(openable.map((access) => [access.id, access.modes])).toEqual([['1', ['ble']], ['3', ['data', 'ble']]]);
    expect(skipped).toMatchObject([{ id: '2', reason: 'legacy-clemobil' }]);
  });

  it('skips id-less, phone-less and unknown-mode items', () => {
    const { openable, skipped } = parseAccessList({
      data: {
        list: [
          { phonenumber: '0700', openmode: 'data' },
          { id: '5', openmode: 'data' },
          { id: '6', phonenumber: '0700', openmode: 'unknown' },
          { id: '7', phonenumber: '0700' },
          'garbage',
        ],
      },
    });
    expect(openable).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['no-id', 'no-phonenumber', 'unknown-mode', 'unknown-mode']);
  });

  it.each([
    ['data.accesses', { data: { accesses: [{ id: 'a', phonenumber: '1', openmode: 'data' }] } }],
    ['data.access', { data: { access: [{ id: 'a', phonenumber: '1', openmode: 'data' }] } }],
    ['data as list', { data: [{ id: 'a', phonenumber: '1', openmode: 'data' }] }],
    ['top-level list', { list: [{ id: 'a', phonenumber: '1', openmode: 'data' }] }],
    ['alternate item keys', { data: { list: [{ access_id: 'a', phone_number: '1', openmodes: ['DATA'] }] } }],
  ])('finds accesses under %s', (_label, body) => {
    expect(parseAccessList(body).openable.map((access) => access.id)).toEqual(['a']);
  });

  it('returns nothing for empty or malformed bodies', () => {
    for (const body of [undefined, null, 'oops', { data: {} }, { data: { list: null } }]) {
      expect(parseAccessList(body)).toEqual({ openable: [], skipped: [] });
    }
  });
});

describe('phoneCandidates', () => {
  it('tries national, then indicatif-prefixed, then bare', () => {
    expect(phoneCandidates('0612345678', '33')).toEqual(['0612345678', '33612345678', '612345678']);
  });

  it('ignores spacing and punctuation', () => {
    expect(phoneCandidates(' 06 12.34-56 78 ', '33')[0]).toBe('0612345678');
  });

  it('handles international input', () => {
    expect(phoneCandidates('+33 6 12 34 56 78', '33')).toEqual(['33612345678', '0612345678', '612345678']);
    expect(phoneCandidates('0033612345678', '33')).toEqual(['0033612345678', '33612345678', '0612345678', '612345678']);
  });

  it('does not invent variants for a number without leading zeros', () => {
    expect(phoneCandidates('612345678', '33')).toEqual(['612345678']);
  });
});

describe('isOkBody', () => {
  it.each([
    [{ error: 0, state: 'ok', data: { success: true } }, true],
    [{ error: '0' }, true],
    [{ state: 'OK' }, true],
    [{ error: 1, state: 'ok' }, false],
    [{ error: 0, data: { success: false } }, false],
    [{ state: 'error' }, false],
    [{}, false],
    ['<html>', false],
  ])('%j → %s', (body, expected) => {
    expect(isOkBody(body)).toBe(expected);
  });
});

describe('decodeJwtPayload', () => {
  it('reads claims without verifying', () => {
    expect(decodeJwtPayload(makeJwt(2_000_000_000))).toMatchObject({ exp: 2_000_000_000, device_id: 'DEVICE-ID' });
  });

  it('returns undefined for junk', () => {
    expect(decodeJwtPayload('nope')).toBeUndefined();
    expect(decodeJwtPayload('a.%%%.c')).toBeUndefined();
  });
});

describe('redact', () => {
  it('masks tokens, app credentials, OTPs and the account phone', () => {
    const jwt = makeJwt(2_000_000_000);
    expect(redact({ app_id: 'x', app_token: 'y', tel: '0612345678', otp: '123456', data: { jwt, note: `Bearer ${jwt}`, id: '42' } }))
      .toEqual({ app_id: '***', app_token: '***', tel: '********78', otp: '***', data: { jwt: '***', note: 'Bearer <jwt>', id: '42' } });
  });

  it('keeps the door phone numbers needed to debug parsing', () => {
    expect(redactJson(ACCESS_LIST_BODY)).toContain('07000000000001');
  });

  it('describes an empty body instead of returning undefined', () => {
    expect(redactJson(undefined)).toBe('<empty>');
  });
});

describe('truthy', () => {
  it.each([[1, true], ['1', true], [true, true], ['true', true], [0, false], ['0', false], ['', false], [undefined, false]])(
    '%j → %s',
    (value, expected) => expect(truthy(value)).toBe(expected),
  );
});

describe('accountKey', () => {
  it('is the same for every spelling of one number', () => {
    const key = accountKey('0612345678', '33');
    expect(accountKey('+33 6 12 34 56 78', '33')).toBe(key);
    expect(accountKey('0033612345678', '33')).toBe(key);
    expect(accountKey('0612345679', '33')).not.toBe(key);
  });
});

describe('homeKitName', () => {
  it('strips characters HomeKit rejects', () => {
    expect(homeKitName('  #Portail (Nord)! ')).toBe('Portail Nord');
    expect(homeKitName('***')).toBe('Intratone door');
  });

  it('prefixes the residence only when asked', () => {
    const access = { id: '1', residence: 'LES TILLEULS', name: 'PORTAIL', phoneNumber: '1', modes: ['data'], primaryMode: 'data' };
    expect(accessDisplayName(access, false)).toBe('PORTAIL');
    expect(accessDisplayName(access, true)).toBe('LES TILLEULS PORTAIL');
  });
});

describe('parseSettings', () => {
  it('requires the credentials and fills defaults', () => {
    expect(parseSettings({}).errors).toEqual(['app_id is required', 'app_token is required', 'tel is required']);
    expect(parseSettings({ app_id: 'a', app_token: 't', tel: '0612345678' }).settings).toMatchObject({
      indicatif: '33',
      service: 'lock',
      pulseMs: 2000,
      accessRefreshMs: 3_600_000,
      identity: 'ios',
      appVersion: '4.6.4',
      debug: false,
    });
  });

  it('rejects a malformed device_id and clamps numbers', () => {
    expect(parseSettings({ app_id: 'a', app_token: 't', tel: '1', device_id: 'abc' }).errors).toEqual([
      'device_id must be a UUID (or empty to generate one)',
    ]);
    expect(parseSettings({ app_id: 'a', app_token: 't', tel: '1', pulse_seconds: 999, access_refresh_minutes: 1 }).settings)
      .toMatchObject({ pulseMs: 30_000, accessRefreshMs: 15 * 60_000 });
  });
});
