import { isRecord, redactJson, str, truthy } from './util.js';

export const BASE_URL = 'https://sip.intratone.info/';

export const USER_AGENTS = {
  ios: 'intratone-x10-19/4 CFNetwork/3896.200.61 Darwin/27.2.0',
  android: 'okhttp/5.0.0-alpha.2',
} as const;

export type ClientIdentity = keyof typeof USER_AGENTS;

/** Modes the REST open endpoint handles. `clemobil` (GSM call) cannot be driven headless. */
export const OPENABLE_MODES: ReadonlySet<string> = new Set(['data', 'ble']);

const PATHS = {
  auth: 'api/auth/device',
  accessList: 'api/access',
  accessOpen: 'api/access/open/clemobil',
  mobipassActivate: 'api/mobipass/activate',
  mobipassVerify: 'api/mobipass/otp/verify',
} as const;

const MIN_RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/** Fallback lifetime if neither the JWT nor `expire_at` can be read (real tokens last 7 days). */
const FALLBACK_SESSION_MS = 24 * 3600_000;

export interface MobipassFlags {
  /** Remote open currently enabled on this device. */
  openingAccess: boolean;
  /** Client should re-fetch its access list. */
  accessRefresh: boolean;
  /** Account is eligible for single-owner mobipass. */
  mobipassCompatible: boolean;
  /** The mobipass key is active on this device. */
  mobipass: boolean;
}

export interface Session {
  jwt: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Numeric smartphone id (`id` claim). */
  smartphoneId?: string;
  /** The phone-number spelling the server accepted. */
  tel: string;
  flags: MobipassFlags;
}

export interface SessionStore {
  loadSession(): Session | undefined;
  saveSession(session: Session): void;
}

export interface Access {
  id: string;
  residence: string;
  name: string;
  phoneNumber: string;
  /** Lower-cased; the first entry is the one the app dispatches on. */
  modes: string[];
  primaryMode: string;
}

export type SkipReason = 'no-id' | 'no-phonenumber' | 'legacy-clemobil' | 'unknown-mode';

export interface SkippedAccess {
  reason: SkipReason;
  id: string;
  name: string;
  residence: string;
  mode: string;
}

export interface AccessList {
  openable: Access[];
  skipped: SkippedAccess[];
}

export interface MobipassResult {
  code?: string;
  body: unknown;
}

export class IntratoneError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Every phone-number variant was refused: app_id/app_token/tel/device_id are wrong. */
export class IntratoneAuthError extends IntratoneError {}

export class IntratoneRateLimitError extends IntratoneError {
  constructor(message: string, readonly retryAfterMs: number, status?: number, body?: unknown) {
    super(message, status, body);
  }
}

export class MobipassError extends IntratoneError {}

export interface ClientOptions {
  appId: string;
  appToken: string;
  tel: string;
  indicatif: string;
  deviceId: string;
  appVersion: string;
  identity: ClientIdentity;
  store?: SessionStore;
  /** Called with every fresh session, so callers can react to the mobipass flags. */
  onSession?: (session: Session) => void;
  debug?: (message: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
}

interface HttpResponse {
  status: number;
  body: unknown;
}

type Method = 'GET' | 'POST';

/**
 * Phone spellings to try against `auth/device`, most likely first. Some accounts are keyed
 * on the national form, others on the indicatif-prefixed form.
 */
export function phoneCandidates(tel: string, indicatif: string): string[] {
  const raw = tel.trim();
  const digits = raw.replace(/\D/g, '');
  const out: string[] = [];
  const add = (candidate: string): void => {
    if (candidate && !out.includes(candidate)) {
      out.push(candidate);
    }
  };

  add(digits);

  const international = raw.startsWith('+') ? digits : digits.startsWith('00') ? digits.slice(2) : undefined;
  if (international?.startsWith(indicatif)) {
    const national = international.slice(indicatif.length).replace(/^0+/, '');
    add(international);
    add(`0${national}`);
    add(national);
    return out;
  }

  const stripped = digits.replace(/^0+/, '');
  if (stripped !== digits) {
    add(`${indicatif}${stripped}`);
    add(stripped);
  }
  return out;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const part = jwt.split('.')[1];
  if (!part) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function parseExpireAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      return parseExpireAt(Number(value.trim()));
    }
    const parsed = Date.parse(value.replace(' ', 'T'));
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** `error` 0/"0" (or, when absent, `state: "ok"`), and no explicit `data.success: false`. */
export function isOkBody(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  const error = body.error;
  const errorOk = error === 0 || error === '0' || error === false;
  const stateOk = typeof body.state === 'string' && body.state.toLowerCase() === 'ok';
  if (error !== undefined && error !== null ? !errorOk : !stateOk) {
    return false;
  }
  return !(isRecord(body.data) && body.data.success === false);
}

function responseCode(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return str(body.code) || (isRecord(body.data) ? str(body.data.code) : '') || undefined;
}

function toModes(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(str) : str(value).split(/[\s,;|]+/);
  return parts.map((mode) => mode.toLowerCase()).filter(Boolean);
}

function findAccessItems(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (!isRecord(body)) {
    return [];
  }
  const data = body.data;
  if (isRecord(data)) {
    for (const key of ['list', 'accesses', 'access']) {
      const candidate = data[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }
  if (Array.isArray(data)) {
    return data;
  }
  return Array.isArray(body.list) ? body.list : [];
}

/** Splits a `GET /api/access` body into REST-openable accesses and the ones we must skip. */
export function parseAccessList(body: unknown): AccessList {
  const result: AccessList = { openable: [], skipped: [] };
  for (const item of findAccessItems(body)) {
    if (!isRecord(item)) {
      continue;
    }
    const id = str(item.id) || str(item.access_id);
    const residence = str(item.residence);
    const name = str(item.name) || (id ? `Access ${id}` : 'Access');
    const phoneNumber = str(item.phonenumber) || str(item.phone_number);
    const modes = toModes(item.openmode ?? item.openmodes);
    const primaryMode = modes[0] ?? '';
    const skip = (reason: SkipReason): void => {
      result.skipped.push({ reason, id, name, residence, mode: primaryMode });
    };

    if (!id) {
      skip('no-id');
    } else if (OPENABLE_MODES.has(primaryMode)) {
      if (phoneNumber) {
        result.openable.push({ id, residence, name, phoneNumber, modes, primaryMode });
      } else {
        skip('no-phonenumber');
      }
    } else if (primaryMode === 'clemobil') {
      skip('legacy-clemobil');
    } else {
      skip('unknown-mode');
    }
  }
  return result;
}

function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function summarize(response: HttpResponse): string {
  const text = redactJson(response.body);
  return `HTTP ${response.status}: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`;
}

export class IntratoneClient {
  private session?: Session;
  private inflightRefresh?: Promise<Session>;
  private blockedUntil = 0;
  private rateLimitStrikes = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.session = options.store?.loadSession();
  }

  get currentSession(): Session | undefined {
    return this.session;
  }

  /** True if the cached JWT has at least `minRemainingMs` left. */
  hasValidSession(minRemainingMs = 60_000): boolean {
    return this.session !== undefined && this.session.expiresAt - this.now() > minRemainingMs;
  }

  async getJwt(): Promise<string> {
    if (this.session && this.hasValidSession()) {
      return this.session.jwt;
    }
    return (await this.refresh()).jwt;
  }

  /** Calls `auth/device`. Concurrent callers share one in-flight request. */
  refresh(): Promise<Session> {
    this.inflightRefresh ??= this.authenticate().finally(() => {
      this.inflightRefresh = undefined;
    });
    return this.inflightRefresh;
  }

  async listAccesses(): Promise<{ accesses: AccessList; raw: unknown }> {
    const response = await this.authed('GET', PATHS.accessList, undefined, (r) => !this.ok(r));
    if (!this.ok(response)) {
      throw new IntratoneError(`Access list refused (${summarize(response)})`, response.status, response.body);
    }
    return { accesses: parseAccessList(response.body), raw: response.body };
  }

  async open(access: Pick<Access, 'id' | 'phoneNumber'>): Promise<void> {
    const form = { phonenumber: access.phoneNumber, access_id: access.id };
    const response = await this.authed('POST', PATHS.accessOpen, form, (r) => !this.ok(r));
    if (!this.ok(response)) {
      throw new IntratoneError(`Open refused (${summarize(response)})`, response.status, response.body, responseCode(response.body));
    }
  }

  /** Starts a mobipass transfer: the server texts an OTP to the account phone. */
  mobipassActivate(): Promise<MobipassResult> {
    return this.mobipass(PATHS.mobipassActivate, {});
  }

  /** Completes the transfer. This revokes the key on whichever device held it before. */
  mobipassVerify(otp: string): Promise<MobipassResult> {
    return this.mobipass(PATHS.mobipassVerify, { otp: otp.trim() });
  }

  private async mobipass(path: string, form: Record<string, string>): Promise<MobipassResult> {
    // A MOBIPASS_* code is a real answer (e.g. a wrong OTP); retrying it with a new JWT would
    // only burn another attempt. Anything else is most likely an expired token.
    const response = await this.authed('POST', path, form, (r) => {
      return !this.ok(r) && !responseCode(r.body)?.startsWith('MOBIPASS');
    });
    const code = responseCode(response.body);
    if (code === 'MOBIPASS_SMS_SENT' || this.ok(response)) {
      return { code, body: response.body };
    }
    throw new MobipassError(`Mobipass ${code ?? 'request'} refused (${summarize(response)})`, response.status, response.body, code);
  }

  private ok(response: HttpResponse): boolean {
    return response.status >= 200 && response.status < 300 && isOkBody(response.body);
  }

  /**
   * Sends with the current JWT; if `shouldRetry` says the answer looks like a failure,
   * refreshes the JWT once (unless another caller already did) and resends.
   */
  private async authed(
    method: Method,
    path: string,
    form: Record<string, string> | undefined,
    shouldRetry: (response: HttpResponse) => boolean,
  ): Promise<HttpResponse> {
    const jwt = await this.getJwt();
    const first = await this.send(method, path, form, jwt);
    if (!shouldRetry(first)) {
      return first;
    }
    this.debug(`${method} /${path} failed (HTTP ${first.status}); refreshing JWT and retrying once`);
    const current = this.session;
    const fresh = current && current.jwt !== jwt && this.hasValidSession() ? current.jwt : (await this.refresh()).jwt;
    return this.send(method, path, form, fresh);
  }

  private async authenticate(): Promise<Session> {
    const { appId, appToken, tel, indicatif, deviceId, appVersion } = this.options;
    const candidates = phoneCandidates(tel, indicatif);
    const remembered = this.session?.tel;
    if (remembered && candidates.includes(remembered)) {
      candidates.splice(candidates.indexOf(remembered), 1);
      candidates.unshift(remembered);
    }

    let last: HttpResponse | undefined;
    let serverTrouble = false;
    for (const candidate of candidates) {
      const form = { app_id: appId, app_token: appToken, tel: candidate, device_id: deviceId, appversion: appVersion };
      // Network errors and 429s propagate: trying more spellings would not help.
      const response = await this.send('POST', PATHS.auth, form);
      const data = isRecord(response.body) ? response.body.data : undefined;
      const jwt = isRecord(data) ? str(data.jwt) : '';
      if (jwt && isRecord(data)) {
        const session = this.buildSession(jwt, data, candidate);
        this.session = session;
        this.options.store?.saveSession(session);
        this.options.onSession?.(session);
        this.debug(`Authenticated (tel variant ${candidates.indexOf(candidate) + 1}/${candidates.length}), ` +
          `JWT valid until ${new Date(session.expiresAt).toISOString()}, flags ${JSON.stringify(session.flags)}`);
        return session;
      }
      last = response;
      serverTrouble ||= response.status >= 500 || !isRecord(response.body);
    }

    const detail = last ? summarize(last) : 'no phone number to try';
    if (serverTrouble) {
      throw new IntratoneError(`Authentication failed, server error (${detail})`, last?.status, last?.body);
    }
    throw new IntratoneAuthError(
      `Authentication refused for every phone spelling (${candidates.length} tried; ${detail}). ` +
        'Check app_id, app_token, tel, indicatif and device_id.',
      last?.status,
      last?.body,
      responseCode(last?.body),
    );
  }

  private buildSession(jwt: string, data: Record<string, unknown>, tel: string): Session {
    const claims = decodeJwtPayload(jwt);
    const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined;
    return {
      jwt,
      expiresAt: exp ?? parseExpireAt(data.expire_at) ?? this.now() + FALLBACK_SESSION_MS,
      smartphoneId: str(data.id) || str(claims?.id) || undefined,
      tel,
      flags: {
        openingAccess: truthy(data.openingaccess),
        accessRefresh: truthy(data.access_refresh),
        mobipassCompatible: truthy(data.mobipass_compatible),
        mobipass: truthy(data.mobipass),
      },
    };
  }

  private async send(method: Method, path: string, form?: Record<string, string>, jwt?: string): Promise<HttpResponse> {
    const now = this.now();
    if (now < this.blockedUntil) {
      throw new IntratoneRateLimitError(
        `Rate limited by the server, not retrying for ${Math.ceil((this.blockedUntil - now) / 1000)}s`,
        this.blockedUntil - now,
      );
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENTS[this.options.identity],
      Accept: '*/*',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    };
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }
    let body: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form ?? {}).toString();
    }

    this.debug(`→ ${method} /${path}${form && Object.keys(form).length ? ` ${redactJson(form)}` : ''}`);
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IntratoneError(`${method} /${path} failed: ${(error as Error).message}`, undefined, undefined, undefined, {
        cause: error,
      });
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON (HTML error page, proxy message…): keep the raw text for the error message.
    }
    const response: HttpResponse = { status: res.status, body: parsed };
    this.debug(`← ${method} /${path} ${summarize(response)}`);

    if (res.status === 429) {
      const backoff = parseRetryAfter(res.headers.get('retry-after'), this.now()) ??
        Math.min(MIN_RATE_LIMIT_BACKOFF_MS * 2 ** this.rateLimitStrikes, MAX_RATE_LIMIT_BACKOFF_MS);
      this.rateLimitStrikes++;
      this.blockedUntil = this.now() + backoff;
      throw new IntratoneRateLimitError(
        `Rate limited by the server (HTTP 429), backing off ${Math.ceil(backoff / 1000)}s`,
        backoff,
        res.status,
        parsed,
      );
    }
    this.rateLimitStrikes = 0;
    return response;
  }

  private debug(message: string): void {
    this.options.debug?.(message);
  }
}
