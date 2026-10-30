export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The API encodes booleans as 1/0, "1"/"0", true/false or "true"/"false". */
export function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

/** Non-empty string form of a scalar, or '' for anything else. */
export function str(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;

const SECRET_KEYS = new Set([
  'jwt',
  'token',
  'app_id',
  'app_token',
  'authorization',
  'otp',
  'codepass',
  'id_push',
  'id_pushkit',
  'id_fcm',
]);

const PHONE_KEYS = new Set(['tel']);

function maskPhone(value: string): string {
  return value.length <= 2 ? '**' : `${'*'.repeat(value.length - 2)}${value.slice(-2)}`;
}

/** Deep copy with tokens, app credentials and the account phone masked, for logging. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(JWT_RE, '<jwt>');
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const lower = key.toLowerCase();
      const empty = inner === '' || inner === null || inner === undefined;
      if (SECRET_KEYS.has(lower) && !empty) {
        out[key] = '***';
      } else if (PHONE_KEYS.has(lower) && !empty) {
        out[key] = maskPhone(str(inner));
      } else {
        out[key] = redact(inner);
      }
    }
    return out;
  }
  return value;
}

export function redactJson(value: unknown): string {
  if (value === undefined) {
    return '<empty>';
  }
  return typeof value === 'string' ? (redact(value) as string) : JSON.stringify(redact(value));
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
