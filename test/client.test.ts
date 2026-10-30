import { describe, expect, it } from 'vitest';

import {
  IntratoneAuthError,
  IntratoneClient,
  IntratoneError,
  IntratoneRateLimitError,
  MobipassError,
  type ClientOptions,
  type Session,
  type SessionStore,
} from '../src/intratoneClient.js';
import { ACCESS_LIST_BODY, authBody, fakeFetch, makeJwt, type RecordedRequest } from './helpers.js';

const NOW = 1_800_000_000_000;
const FUTURE_S = NOW / 1000 + 7 * 86400;
const ACCESS = { id: '1000001', phoneNumber: '07000000000001' };
const FLAGS = { openingAccess: true, accessRefresh: false, mobipassCompatible: true, mobipass: true };

class MemoryStore implements SessionStore {
  constructor(public session?: Session) {}
  loadSession(): Session | undefined {
    return this.session;
  }
  saveSession(session: Session): void {
    this.session = session;
  }
}

function seeded(jwt: string, expiresAt = FUTURE_S * 1000): MemoryStore {
  return new MemoryStore({ jwt, expiresAt, tel: '0612345678', flags: FLAGS });
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<ClientOptions> = {}) {
  let now = NOW;
  const store = (overrides.store as MemoryStore | undefined) ?? new MemoryStore();
  const client = new IntratoneClient({
    appId: 'APP',
    appToken: 'TOKEN',
    tel: '0612345678',
    indicatif: '33',
    deviceId: 'DEVICE-ID',
    appVersion: '4.6.4',
    identity: 'ios',
    fetch: fetchImpl,
    now: () => now,
    ...overrides,
    store,
  });
  return { client, store, advance: (ms: number) => (now += ms) };
}

const byPath = (requests: RecordedRequest[], path: string) => requests.filter((request) => request.path === path);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('authentication', () => {
  it('tries phone spellings until one yields a JWT, then remembers it', async () => {
    const jwt = makeJwt(FUTURE_S);
    const { fetch, requests } = fakeFetch((request) =>
      request.form.get('tel') === '612345678'
        ? { body: authBody(jwt, { access_refresh: '1', mobipass: 0 }) }
        : { body: { error: 1, state: 'error', code: 'AUTH_FAILED' } },
    );
    const { client, store } = makeClient(fetch);

    const session = await client.refresh();

    expect(requests.map((request) => request.form.get('tel'))).toEqual(['0612345678', '33612345678', '612345678']);
    expect(Object.fromEntries(requests[0]!.form)).toEqual({
      app_id: 'APP',
      app_token: 'TOKEN',
      tel: '0612345678',
      device_id: 'DEVICE-ID',
      appversion: '4.6.4',
    });
    expect(requests[0]!.auth).toBeUndefined();
    expect(session).toEqual({
      jwt,
      expiresAt: FUTURE_S * 1000,
      smartphoneId: '1234567',
      tel: '612345678',
      flags: { openingAccess: true, accessRefresh: true, mobipassCompatible: true, mobipass: false },
    });
    expect(store.session).toEqual(session);

    requests.length = 0;
    await client.refresh();
    expect(requests.map((request) => request.form.get('tel'))).toEqual(['612345678']);
  });

  it('falls back to expire_at when the JWT is opaque', async () => {
    const { fetch } = fakeFetch(() => ({ body: authBody('opaque-token', { expire_at: '2027-01-01 00:00:00' }) }));
    const session = await makeClient(fetch).client.refresh();
    expect(session.expiresAt).toBe(Date.parse('2027-01-01T00:00:00'));
  });

  it('reports refused credentials as IntratoneAuthError', async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: { error: 1, state: 'error', code: 'BAD_APP' } }));
    await expect(makeClient(fetch).client.refresh()).rejects.toBeInstanceOf(IntratoneAuthError);
  });

  it('reports server trouble as a plain IntratoneError', async () => {
    const { fetch } = fakeFetch(() => ({ status: 502, body: '<html>Bad gateway</html>' }));
    const error = await makeClient(fetch).client.refresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntratoneError);
    expect(error).not.toBeInstanceOf(IntratoneAuthError);
  });

  it('logs in before the first call when the stored JWT has expired', async () => {
    const fresh = makeJwt(FUTURE_S, { jti: 'fresh' });
    const { fetch, requests } = fakeFetch((request) =>
      request.path === '/api/auth/device' ? { body: authBody(fresh) } : { body: ACCESS_LIST_BODY },
    );
    const { client } = makeClient(fetch, { store: seeded(makeJwt(NOW / 1000 - 1), NOW - 1000) });

    await client.listAccesses();

    expect(requests.map((request) => request.path)).toEqual(['/api/auth/device', '/api/access']);
    expect(requests[1]!.auth).toBe(`Bearer ${fresh}`);
  });
});

describe('JWT refresh on refusal', () => {
  it('shares one auth/device call between concurrent 401s', async () => {
    const stale = makeJwt(FUTURE_S, { jti: 'stale' });
    const fresh = makeJwt(FUTURE_S, { jti: 'fresh' });
    let staleCalls = 0;
    const { fetch, requests } = fakeFetch(async (request) => {
      if (request.path === '/api/auth/device') {
        await delay(10);
        return { body: authBody(fresh) };
      }
      if (request.auth === `Bearer ${fresh}`) {
        return { body: ACCESS_LIST_BODY };
      }
      // The last stale request comes back after the refresh has finished: it must reuse it.
      if (++staleCalls === 4) {
        await delay(50);
      }
      return { status: 401, body: { error: 1, state: 'error', message: 'Expired token' } };
    });
    const { client } = makeClient(fetch, { store: seeded(stale) });

    const results = await Promise.all([1, 2, 3, 4].map(() => client.listAccesses()));

    expect(byPath(requests, '/api/auth/device')).toHaveLength(1);
    expect(results.every((result) => result.accesses.openable.length === 2)).toBe(true);
  });
});

describe('open', () => {
  it('sends only phonenumber and access_id and accepts error 0', async () => {
    const jwt = makeJwt(FUTURE_S);
    const { fetch, requests } = fakeFetch(() => ({ body: { v: '1.7.1', error: 0, state: 'ok', data: { success: true } } }));
    await makeClient(fetch, { store: seeded(jwt) }).client.open(ACCESS);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/access/open/clemobil', auth: `Bearer ${jwt}` });
    expect(Object.fromEntries(requests[0]!.form)).toEqual({ phonenumber: '07000000000001', access_id: '1000001' });
  });

  it('refreshes once on refusal, then surfaces status and body', async () => {
    const { fetch, requests } = fakeFetch((request) =>
      request.path === '/api/auth/device'
        ? { body: authBody(makeJwt(FUTURE_S, { jti: 'fresh' })) }
        : { body: { error: 1, state: 'error', code: 'GATE_OFFLINE' } },
    );
    const { client } = makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) });

    const error = await client.open(ACCESS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IntratoneError);
    expect(error).toMatchObject({ status: 200, code: 'GATE_OFFLINE', message: expect.stringContaining('GATE_OFFLINE') });
    expect(byPath(requests, '/api/access/open/clemobil')).toHaveLength(2);
    expect(byPath(requests, '/api/auth/device')).toHaveLength(1);
  });

  it('treats data.success false as a refusal', async () => {
    const { fetch } = fakeFetch((request) =>
      request.path === '/api/auth/device'
        ? { body: authBody(makeJwt(FUTURE_S)) }
        : { body: { error: 0, state: 'ok', data: { success: false } } },
    );
    await expect(makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) }).client.open(ACCESS)).rejects.toThrow(/Open refused/);
  });
});

describe('rate limiting', () => {
  it('backs off on 429 without refreshing and sends nothing until the window passes', async () => {
    let limited = true;
    const { fetch, requests } = fakeFetch((request) => {
      if (limited) {
        return { status: 429, body: 'Too Many Requests', headers: { 'Retry-After': '120' } };
      }
      return request.path === '/api/access' ? { body: ACCESS_LIST_BODY } : { body: { error: 0 } };
    });
    const { client, advance } = makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) });

    const error = await client.open(ACCESS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntratoneRateLimitError);
    expect((error as IntratoneRateLimitError).retryAfterMs).toBe(120_000);
    expect(requests).toHaveLength(1);

    limited = false;
    await expect(client.listAccesses()).rejects.toBeInstanceOf(IntratoneRateLimitError);
    expect(requests).toHaveLength(1);

    advance(121_000);
    await expect(client.listAccesses()).resolves.toBeDefined();
    expect(byPath(requests, '/api/auth/device')).toHaveLength(0);
  });

  it('doubles the backoff when no Retry-After is given', async () => {
    const { fetch } = fakeFetch(() => ({ status: 429, body: '' }));
    const { client, advance } = makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) });

    const first = (await client.open(ACCESS).catch((e: unknown) => e)) as IntratoneRateLimitError;
    advance(first.retryAfterMs + 1);
    const second = (await client.open(ACCESS).catch((e: unknown) => e)) as IntratoneRateLimitError;
    expect([first.retryAfterMs, second.retryAfterMs]).toEqual([60_000, 120_000]);
  });
});

describe('mobipass', () => {
  it('treats MOBIPASS_SMS_SENT as success for activate', async () => {
    const { fetch, requests } = fakeFetch(() => ({ body: { error: 1, state: 'error', code: 'MOBIPASS_SMS_SENT' } }));
    const result = await makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) }).client.mobipassActivate();

    expect(result.code).toBe('MOBIPASS_SMS_SENT');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/mobipass/activate' });
    expect([...requests[0]!.form]).toEqual([]);
  });

  it('does not retry a wrong OTP, which would burn another attempt', async () => {
    const { fetch, requests } = fakeFetch(() => ({ body: { error: 1, state: 'error', code: 'MOBIPASS_OTP_INVALID' } }));
    const error = await makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) }).client.mobipassVerify(' 123456 ').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MobipassError);
    expect(error).toMatchObject({ code: 'MOBIPASS_OTP_INVALID' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.form.get('otp')).toBe('123456');
  });

  it('retries once after an auth failure that is not a mobipass answer', async () => {
    let verifyCalls = 0;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.path === '/api/auth/device') {
        return { body: authBody(makeJwt(FUTURE_S, { jti: 'fresh' })) };
      }
      return ++verifyCalls === 1 ? { status: 401, body: { error: 1 } } : { body: { error: 0, state: 'ok' } };
    });
    await makeClient(fetch, { store: seeded(makeJwt(FUTURE_S)) }).client.mobipassVerify('123456');
    expect(byPath(requests, '/api/mobipass/otp/verify')).toHaveLength(2);
  });
});
