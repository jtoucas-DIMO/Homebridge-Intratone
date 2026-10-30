# homebridge-intratone

Homebridge dynamic-platform plugin that opens **Intratone / Cogelec** doors and gates from
HomeKit, using the same REST calls as the official app. Every door your account can open over
the API (`data`/4G mobipass and `ble` modes) becomes a HomeKit lock (or garage door).

Phase 1 covers remote opening only. Doorbell, video and two-way audio (SIP + FCM) are not
implemented.

## How it works

- Registers as a device with `POST /api/auth/device` and keeps the 7-day JWT fresh. It checks
  every 12 h, refreshes when less than a day is left, and refreshes once on a refused call.
  Concurrent callers share a single refresh.
- Lists doors with `GET /api/access` at startup and then every hour (configurable). Doors are
  added and removed as residences change. An empty list never removes existing doors, so a
  server hiccup can't wipe your HomeKit rooms and automations.
- Opens with `POST /api/access/open/clemobil` (`phonenumber`, `access_id`). This endpoint also
  handles `data` and `ble` doors.
- `clemobil` (2G) doors are skipped. The app opens those by placing a GSM call, which a server
  can't do.
- The open is a stateless pulse with no real door state to read. A lock shows **Unlocked** for
  `pulse_seconds`, then returns to **Locked**. A failed open goes straight back to Locked and
  logs the HTTP status and body.
- On HTTP 429 the plugin backs off, honouring `Retry-After` or else waiting 1 min, doubling up
  to 15 min, and sends nothing during the backoff.

## Install

```bash
npm install -g homebridge-intratone
```

Then add the platform in the Homebridge UI. Enable **child bridge** for it (plugin settings →
*Bridge Settings*), so a fault here can't take the main bridge down.

### Configuration

```json
{
  "platform": "Intratone",
  "name": "Intratone",
  "app_id": "<from the official app>",
  "app_token": "<from the official app>",
  "tel": "0612345678",
  "indicatif": "33",
  "service": "lock",
  "_bridge": { "username": "0E:9A:…", "port": 51830 }
}
```

| key                      | default  | notes |
| ------------------------ | -------- | ----- |
| `app_id`, `app_token`    | required | Hardcoded in the official app. Not shipped with this plugin. |
| `tel`                    | required | Phone number of the Intratone account. National (`06…`) or international (`+33 6…`). Several spellings are tried, and the one that works is remembered. |
| `indicatif`              | `33`     | Country code. |
| `device_id`              | generated | Leave empty to generate a UUID that is stored and reused forever. Set it to reuse an existing phone's registration (`device_id` claim of that phone's JWT). |
| `service`                | `lock`   | `lock` (LockMechanism) or `garage` (GarageDoorOpener). |
| `pulse_seconds`          | `2`      | How long a door shows as unlocked/open after a successful open. |
| `access_refresh_minutes` | `60`     | How often the door list is re-fetched. |
| `user_agent`             | `ios`    | `ios` or `android` client identity. |
| `app_version`            | `4.6.4`  | `appversion` sent at login. |
| `debug`                  | `false`  | Logs every request and response at info level, plus the raw door list once at startup. Tokens, app credentials and your phone number are masked. |

The plugin keeps `device_id` and the current JWT in
`<homebridge storage>/intratone/<hash>.json` (mode 0600). Delete that file only if you want to
register as a new device.

## Mobipass: taking the door key

Mobipass is single-owner: the key that opens `data` doors lives on one device at a time. If
another phone holds it, `GET /api/access` returns nothing. The log then says
*"The mobipass key for this account is active on another device"* and no door is exposed.

Transfer it with the bundled CLI. Run it as the user Homebridge runs as, so it uses the same
device_id and JWT:

```bash
sudo -u homebridge homebridge-intratone activate -U /var/lib/homebridge
```

```bash
sudo -u homebridge homebridge-intratone verify --otp 123456 -U /var/lib/homebridge
```

`activate` texts a code to the account phone. `verify` moves the key to Homebridge and
**revokes remote opening on the phone that held it**. The doors appear at the next access
refresh, or straight away if you restart the child bridge.

Other CLI commands:

| command | what it does |
| ------- | ------------ |
| `status` | Stored device_id, JWT expiry, last known mobipass flags |
| `login` | Authenticate now and print the mobipass flags |
| `list` | Every access, with ✔ openable / ✘ skipped and the reason |
| `open <access_id>` | Open one door from the shell, for testing |

Add `--debug` to any command to see the requests (tokens masked). Without `-U`, the CLI reads
`~/.homebridge/config.json`.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

`npm run lint` and `npm run typecheck` are also available. Link the build into a local
Homebridge with `npm link`.

The API notes come from the open-source Home Assistant integration
[GuiHash/ha-intratone](https://github.com/GuiHash/ha-intratone) and from a capture of the iOS
app. The server returns `openmode` in upper case (`["DATA"]`), and the plugin compares modes
case-insensitively.
