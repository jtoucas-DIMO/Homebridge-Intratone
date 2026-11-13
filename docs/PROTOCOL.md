# Intratone / Cogelec API — protocol notes

Reverse-engineered from captures of the official iOS app, used to build this plugin. The raw
captures are **not** kept in the repo (they hold a live JWT, phone number and device ids); this
file is the distilled, secret-free record so the plugin can be maintained without them.

## Conventions

- Base URL `https://sip.intratone.info/`. All requests are `application/x-www-form-urlencoded`;
  the plugin sends the official app's `User-Agent` and a 10 s timeout.
- Identity is the official **app**, not the account: `app_id` + `app_token` (constant per
  platform; the iOS values are shipped as defaults). Only the iOS identity is known — see
  *Android gap*.
- Every response is a JSON envelope: `{ "v": <api version>, "error": <int>, "state": <str>,
  "data": <object|string> }`. Success = `error` is `0` (or `state` is `"ok"` with no error);
  `data` carries the payload.
- `openmode` values come back **upper-case** (e.g. `["DATA"]`); compare case-insensitively.

## Authentication & session

| call | body | purpose |
| ---- | ---- | ------- |
| `POST /api/auth/verify` | `tel_indicatif`, `tel` | Pre-check a phone/country (the app calls it first). |
| `POST /api/auth/device` | `device_id`, `tel`, `app_id`, `app_token`, `appversion` | Sign in an **already-registered** device. Returns a ~7-day HS512 JWT and the mobipass flags. An **unknown** `device_id` returns HTTP 200 `{error:1, code:"DEVICE_INVALID"}` and no session — it does **not** register. |

- The JWT is decoded without verification only to read its expiry; renewed when < 1 day remains,
  and once on a rejected call. Concurrent callers share one refresh.
- Mobipass flags in `data`: `openingaccess`, `access_refresh`, `mobipass_compatible`, `mobipass`.

## Device registration (pairing a new device) — two steps

A brand-new `device_id` must be registered before `auth/device` works. This is the "pair this
device" step; it is non-destructive (does not touch other devices).

| call | body | purpose |
| ---- | ---- | ------- |
| `POST /api/auth/register` | device profile + `device_id`, `tel` (national), `tel_indicatif`, `appversion` | Registers the device and texts a **4-digit** code. Returns `data.id` (numeric device id) and `sms_tempo`. Unauthenticated (no `app_token`/JWT). |
| `POST /api/auth/validate` | `tel` (national), `device_id`, `code` | Confirms the 4-digit code; the device is now valid. Unauthenticated; `data` is a string. |

Device-profile fields sent to `register` (constants; the plugin presents an iOS profile):
`os`, `osv`, `manufacturer`, `model`, `description`, `bundleid` (`com.cogelec.IntraVision`),
`device_language`, `device_country`, plus `id_push`, `id_pushkit`, `carrier_name`,
`carrier_networkcode`, `carrier_countrycode`, `carrier_countryiso` — the push/carrier fields may
be **empty**. After validate, `POST /api/auth/device` returns a JWT as normal.

## Device management

| call | body | purpose |
| ---- | ---- | ------- |
| `GET /api/devices` | – | List the account's registered devices. |
| `GET /api/devices/<id>` | – | One device. |
| `POST /api/devices/<id>` | `device_id`, `bundleid`, `osv`, `description`, `appversion`, `id_push`, `id_pushkit`, `id` | Update a device's push/profile data. |
| `DELETE /api/devices/<id>` | `tel` | Unregister a device (the iOS "unpair" action). |

Registering as a new device leaves a device entry on the account; it can be deleted here.

## Mobipass (the 4G door key) — single owner

`data`/4G doors are opened by the one device that holds the "mobipass" key. Moving it to a new
device is a second SMS step and **revokes** the previous holder.

| call | body | purpose |
| ---- | ---- | ------- |
| `POST /api/mobipass/activate` | – | Request the key transfer; texts a **6-digit** code. Refused with `MOBIPASS_ALREADY_ACTIVATE` when the server will not move it from its current device. |
| `POST /api/mobipass/otp/verify` | `otp` | Confirm the 6-digit code; the key moves to this device. |

Sharing a phone's `device_id` (so two "devices" share one key, nothing revoked) is the
non-destructive alternative to claiming.

**A full new-device setup = TWO SMS:** 4-digit (register → validate) then 6-digit (mobipass
transfer).

## Accesses (doors)

| call | body | purpose |
| ---- | ---- | ------- |
| `GET /api/access` | – | List accesses. The first entry of `openmode` decides: `data`/`ble` are openable; `clemobil` (2G) is skipped (the app opens those with a GSM call). Names get the residence as a prefix when there are several. |
| `POST /api/access/open/clemobil` | `access_id`, `phonenumber` | Open one door, whatever its mode. Stateless pulse — no door state to read back. |
| `POST /api/access/bookmark` | `[{id, action}]` | Reorder/bookmark accesses (observed; not used by the plugin). |

## Rate limiting

`POST /api/auth/device` is rate-limited: repeated attempts return HTTP 429 (`TOO_MANY_ATTEMPTS`)
on a rolling window that only a quiet period clears. Honour `Retry-After`, else back off 1 min
doubling to 15 min, and send nothing during the backoff. Restarting the plugin resets nothing
server-side — it only adds attempts.

## Observed error codes

- `DEVICE_INVALID` — `auth/device` for a device the server doesn't know (needs register/validate).
- `MOBIPASS_ALREADY_ACTIVATE` — `mobipass/activate` refused; the key won't move from its device.
- `TOO_MANY_ATTEMPTS` — HTTP 429 rate limit.

## Android gap

Only the **iOS** app identity (`app_id` = `app_apisip_ios`, `app_token`, `appversion`) is known
and shipped as the default. The Android app's `app_id`/`app_token` are **unknown** — no Android
APK was analysed. `user_agent: android` therefore requires the user to supply those values.

## Source & secrecy

These notes were reconstructed from the account owner's own iOS traffic captures, which are not
retained. Raw captures hold a live JWT, the phone number and device ids and are never committed:
`mitmproxy/`, `*.har` and `*.tgz` are git-ignored, and the npm `files` list ships only `dist/`,
the schema, the UI and the docs. No secret values are recorded in this file.
