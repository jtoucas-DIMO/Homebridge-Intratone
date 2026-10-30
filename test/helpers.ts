import { vi } from 'vitest';

export interface RecordedRequest {
  path: string;
  method: string;
  form: URLSearchParams;
  auth?: string;
}

export interface FakeResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A fetch double that routes on path and records every request. */
export function fakeFetch(handler: (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>) {
  const requests: RecordedRequest[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request: RecordedRequest = {
      path: new URL(String(input)).pathname,
      method: init?.method ?? 'GET',
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      auth: headers.Authorization,
    };
    requests.push(request);
    const response = await handler(request);
    const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(text, { status: response.status ?? 200, headers: response.headers });
  });
  return { fetch: impl as unknown as typeof fetch, requests };
}

/** Unsigned JWT with the claim layout the server uses. */
export function makeJwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    indicatif: '33',
    id: '1234567',
    tel: '600000000',
    code: '0000',
    device_id: 'DEVICE-ID',
    device: 'iPhone',
    exp: expSeconds,
    iat: expSeconds - 7 * 86400,
    nbf: expSeconds - 7 * 86400,
    jti: 'test',
    ...extra,
  };
  return `${encode({ alg: 'HS512' })}.${encode(claims)}.signature`;
}

export function authBody(jwt: string, data: Record<string, unknown> = {}) {
  return {
    error: 0,
    state: 'ok',
    data: {
      jwt,
      id: '1234567',
      tel: '600000000',
      device_id: 'DEVICE-ID',
      openingaccess: 1,
      access_refresh: 0,
      mobipass_compatible: 1,
      mobipass: 1,
      ...data,
    },
  };
}

/** Shape captured from the iOS app (ids and numbers replaced). */
export const ACCESS_LIST_BODY = {
  v: '1.7.1',
  error: 0,
  state: 'ok',
  data: {
    list: [
      { residence: 'LES TILLEULS', id: '1000001', name: 'PORTAIL', phonenumber: '07000000000001', relay: '1', openmode: ['DATA'] },
      { residence: 'LES TILLEULS', id: '1000002', name: 'PIETON', phonenumber: '07000000000002', relay: '1', openmode: ['DATA'] },
    ],
  },
};
