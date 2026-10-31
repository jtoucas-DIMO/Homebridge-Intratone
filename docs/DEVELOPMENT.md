# Developer guide

How the plugin is built, tested and released. For setup and usage, see the
[README](../README.md); for what changed in each version, see the [changelog](../CHANGELOG.md).

## Layout

| file | role |
| ---- | ---- |
| `src/index.ts` | Registers the `Intratone` platform with Homebridge. |
| `src/platform.ts` | `IntratonePlatform`: startup, token upkeep, the access-list sync loop, and HomeKit accessory registration and removal. |
| `src/accessAccessory.ts` | One door as a HomeKit `LockMechanism` or `GarageDoorOpener` with a timed "open" pulse. |
| `src/matterDoors.ts` | The same doors as Matter door locks, when the bridge has Matter enabled. |
| `src/intratoneClient.ts` | REST client: sign-in, JWT lifecycle, access list, open, mobipass, 429 backoff. |
| `src/config.ts` | Validates the config block (`parseSettings`) and opens the account state (`openAccount`). |
| `src/storage.ts` | Per-account state file holding `device_id` and the session. |
| `src/cli.ts` | The `homebridge-intratone` command (`status`, `login`, `list`, `open`, `activate`, `verify`). |
| `src/util.ts` | Small helpers, including the log redaction. |
| `config.schema.json` | Settings form for the Homebridge UI. |

The code is TypeScript, compiled as ES modules (`NodeNext`) to `dist/`. Runtime dependencies:
none. Homebridge provides HAP and Matter at runtime, and HTTP uses Node's built-in `fetch`.

## The Intratone API

All calls go to `https://sip.intratone.info/` with form-encoded bodies, a 10 s timeout and the
official app's `User-Agent`. The iOS app is used by default, and the Android one with
`user_agent: android`.

| call | used for |
| ---- | -------- |
| `POST /api/auth/device` (`app_id`, `app_token`, `tel`, `device_id`, `appversion`) | Sign-in. Returns a 7-day HS512 JWT and the mobipass flags (`openingaccess`, `access_refresh`, `mobipass_compatible`, `mobipass`). |
| `GET /api/access` | The doors. The first entry of `openmode` decides: `data`/`ble` can be opened, `clemobil` can't. The server sends modes in upper case (`["DATA"]`), so they're compared case-insensitively. |
| `POST /api/access/open/clemobil` (`phonenumber`, `access_id`) | Opens one door, whatever its mode. |
| `POST /api/mobipass/activate`, `POST /api/mobipass/otp/verify` | Moves the mobipass key to this device (SMS code). |

A response counts as success when `error` is `0` (or `state` is `ok` without an `error`).

- **Credentials:** `app_id` names the client app (`app_apisip_ios` for iPhone) and is a public
  default. `app_token` is the app's secret: it's never shipped, and users capture it once
  (README, *Getting app_token*).
- **The JWT** is decoded without verification, only to read its expiry. It's renewed when less
  than 24 h is left, and once on a refused call. Concurrent callers share one refresh.
- **On HTTP 429** the client stops sending until `Retry-After`, or else 1 min doubling to 15 min.

The API notes come from the open-source Home Assistant integration
[GuiHash/ha-intratone](https://github.com/GuiHash/ha-intratone) and from a capture of the iOS
app. **Never commit a capture:** it holds a live JWT, the phone number and device ids.
`mitmproxy/`, `*.har` and `*.tgz` are git-ignored, and the npm `files` list only ships
`dist/`, the schema and the docs.

## HomeKit

Each door is an accessory with UUID `uuid.generate('intratone:<access id>')`. The access is
kept in `accessory.context`, so cached doors work at startup even before the network answers.

A successful open shows *Unlocked* (or *Open*) for `pulse_seconds`, then *Locked* again. The
server reports no real door state. An empty access list never removes accessories, so a
server hiccup or a moved mobipass key can't wipe the user's rooms and automations.

## Matter

Matter support is optional and appears only when Homebridge sets `api.matter`. That happens on
Homebridge 2, on a bridge with a `matter` block (*Enable Matter* in the child bridge
settings). Values come from `api.matter` (`deviceTypes`, `types`), never from a value import of
`homebridge`, which fails on installs where Homebridge lives in a separate `node_modules`.

- **Shape:** each door is a `DoorLock` with `lockState` `Locked`, `lockType` `Other`,
  `actuatorEnabled` and `operatingMode` `Normal`. Its UUID is
  `uuid.generate('intratone:matter:<access id>')`, separate from the HomeKit one.
- **Commands:**
  - `unlockDoor` awaits the open. Homebridge sets `lockState` to *Unlocked* when the handler
    resolves, and reports a failure when it throws.
  - The plugin sets *Locked* again after the pulse with `updateAccessoryState`, outside the
    handler.
  - `lockDoor` only cancels the pulse.
- **Cache:**
  - Homebridge restores cached Matter accessories with *empty* handlers and calls
    `configureMatterAccessory`.
  - The plugin then registers each cached door again at startup. Homebridge attaches the
    handlers to the restored endpoint ("Attached plugin registration to restored accessory")
    and forces `Locked`.
  - Registering the same UUID twice in one session throws, so the plugin tracks what it
    registered.
  - `updatePlatformAccessories` only updates the cache (a rename shows after a restart).
- **Names:** the bridged node label is limited to 32 bytes and Homebridge doesn't trim it,
  so `matterLabel` does.
- **UI badges:** the Homebridge UI shows its HomeKit and Matter badges from the `supports-hap`
  and `supports-matter` keywords in `package.json`.

## Tests

```bash
npm test
```

Vitest, no network. `test/helpers.ts` has a `fetch` double that routes on path, a JWT builder,
a fake `api.matter` with matter.js's real DoorLock enum values, and a helper that runs a
DoorLock command the way Homebridge does. HomeKit tests use the real `@homebridge/hap-nodejs`,
pinned to the version Homebridge itself requires, so the types match.

```bash
npm run lint
```

```bash
npm run typecheck
```

### Smoke test against a real Homebridge with Matter

The 0.2.0 Matter support was also checked end to end in a throwaway Homebridge 2.4 (matter.js
0.17), with no real account involved:

- **Setup:** a temporary storage folder whose `config.json` has a `bridge.matter` block and the
  Intratone platform with dummy credentials.
- **Fake API:** Homebridge started with `NODE_OPTIONS=--import=<preload>`. The preload replaces
  `fetch` for `sip.intratone.info` with canned answers, and keeps a reference to Homebridge's
  Matter manager (`HomebridgeAPI.prototype._setMatterManager`).
- **The run:** `homebridge -U <tmp> -P <repo> --strict-plugin-resolution -D`.
- **The unlock:** the preload calls `matterServer.triggerCommand(uuid, 'doorLock',
  'unlockDoor', {})`, which goes through Homebridge's real `HomebridgeDoorLockServer`. It then
  reads `lockState` before, right after, and after the pulse (1 → 2 → 1). Finally it sends
  `SIGTERM` for a clean shutdown.
- **The restart:** a second run on the same storage checks the cache restore.

## Releasing

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. `npm publish`. `prepublishOnly` runs lint, typecheck and tests, and `prepack` builds `dist/`.
   The npm account uses 2FA: npm prints an approval link and waits. Approve it within a few
   minutes, or the request expires and the publish fails with a 404 on `/-/v1/done`.
3. After `+ homebridge-intratone@x.y.z`, the registry takes about a minute to move `latest`.
4. Tag the commit `vX.Y.Z`, push the tag, and create the GitHub release from the changelog
   entry.

A new package scores 0 in npm search for a while. The Homebridge UI shows only the 99
best-ranked plugins for a word, so a new package appears there only when searched by its full
name, `homebridge-intratone`, which the UI fetches directly.
