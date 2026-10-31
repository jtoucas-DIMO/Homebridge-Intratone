# homebridge-intratone

Homebridge dynamic-platform plugin that opens **Intratone / Cogelec** doors and gates from
HomeKit and Matter, using the same REST calls as the official app. Every door your account can
open over the API (`data`/4G mobipass and `ble` modes) becomes a HomeKit lock (or garage door)
and, on a bridge with Matter enabled, a Matter door lock for Google Home, Alexa, SmartThings or
Apple Home.

Phase 1 covers remote opening only. Doorbell, video and two-way audio (SIP + FCM) are not
implemented.

> **Unofficial.** This plugin is not affiliated with or endorsed by Intratone or Cogelec. It
> talks to the private API of their app, which can change or stop working at any time.

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

In the Homebridge UI, open **Plugins**, search for **homebridge-intratone** (the full name) and
click **Install**. This works the same in the official `homebridge/homebridge` Docker image
(Synology, Unraid, …). A search for just "intratone" may not list it yet: the UI shows the 99
best-ranked Homebridge plugins for a word, and npm ranks new packages low.

Without the UI:

```bash
npm install -g homebridge-intratone
```

Then fill in the plugin settings (see below) and enable **child bridge** for it (plugin
settings → *Bridge Settings*), so a fault here can't take the main bridge down.

### Configuration

```json
{
  "platform": "Intratone",
  "name": "Intratone",
  "app_token": "<from the official app>",
  "tel": "0612345678",
  "indicatif": "33",
  "service": "lock",
  "_bridge": { "username": "0E:9A:…", "port": 51830 }
}
```

| key                      | default  | notes |
| ------------------------ | -------- | ----- |
| `app_token`              | required | The official app's secret, not shipped with this plugin. See [Getting app_token](#getting-app_token). |
| `app_id`                 | iOS app's | Names the official app, not your account: every iPhone sends `app_apisip_ios`, which is the default. Set it only with `user_agent: android`, whose value isn't known yet. |
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

### Matter

Needs Homebridge 2. In the plugin settings, open *Bridge Settings*, tick **Enable Matter**,
pick a free Matter port, save and restart the child bridge. The Matter QR code and pairing code
then appear in the same *Bridge Settings* dialog; scan them from Google Home, Alexa, SmartThings
or any other Matter controller. Several controllers can share the same pairing.

- Every door becomes a Matter **door lock**, whatever `service` is set to: Matter controllers
  have no gate opener. *Unlock* opens the door; it shows unlocked for `pulse_seconds`, then
  locked again. A failed open is reported to the controller as an error.
- HomeKit keeps working on the same bridge. Pairing the Matter bridge into Apple Home as well
  would show every door twice, so use Matter for the other ecosystems, or turn HomeKit off for
  this bridge if you only want Matter.
- Some controllers restrict unlocking a door lock by voice, or ask for a PIN that this plugin
  doesn't provide. Unlocking from the controller's app is unaffected.
- Homebridge's Matter support is experimental and not CSA certified, so controllers may warn
  about an uncertified accessory while pairing.

### Getting app_token

`app_token` is built into the official app and only travels in the request the app sends when
you sign in (`POST /api/auth/device`). You read it by recording your iPhone's own traffic for a
few minutes with [Proxyman for iOS](https://proxyman.com/ios), an App Store app that does this
on the phone itself. No computer is needed.

**1. Set up Proxyman**

1. Install **Proxyman** from the App Store and open it.
2. Follow its setup screens: allow the VPN configuration it adds, then generate its
   certificate. iOS downloads it as a profile.
3. Install the profile in **Settings → General → VPN & Device Management**.
4. Trust it in **Settings → General → About → Certificate Trust Settings**: turn on full trust
   for the Proxyman certificate.
5. Back in Proxyman, start the VPN. Its status should say it is ready to intercept HTTPS.

**2. Decrypt Intratone's traffic**

1. With Proxyman running, open the Intratone app and look at your doors, then switch back to
   Proxyman.
2. Tap the **sip.intratone.info** domain, then any request in it, and tap
   **Enable SSL Proxying**. Requests to that domain are now readable.

**3. Capture the sign-in**

1. Delete the Intratone app, reinstall it from the App Store and sign in as you did the first
   time. A fresh install always sends the sign-in request. (The app also signs in by itself
   about once a week, if you'd rather wait.)
2. In Proxyman, open **sip.intratone.info** and find **POST /api/auth/device**.
3. Open the request body. Copy `app_token` into the plugin's **App token** setting.
4. Optional: copy `device_id` into the plugin's **Device ID** setting (under *Advanced*).
   Homebridge then acts as your iPhone and shares its door key, so you don't need the mobipass
   transfer described below.

**4. Clean up**

The capture holds a live session token and your phone number, so don't share it.

1. Stop the VPN in Proxyman and delete the captured requests.
2. Remove the Proxyman profile in **Settings → General → VPN & Device Management**, or at
   least turn off its full trust. Leaving a trusted certificate installed weakens your
   iPhone's HTTPS security.

Already run an HTTPS proxy on a computer, such as [mitmproxy](https://mitmproxy.org/)? It works
the same way: route the iPhone through it, trust its certificate, sign in to the Intratone app
and read the same request.

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

In the `homebridge/homebridge` Docker image, run the CLI from the Homebridge UI terminal:

```bash
cd /homebridge && npx homebridge-intratone status -U /homebridge
```

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

How the plugin works inside, how it's tested and how releases are made:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). What changed in each version:
[CHANGELOG.md](CHANGELOG.md).

`npm run lint` and `npm run typecheck` are also available. Link the build into a local
Homebridge with `npm link`.

The API notes come from the open-source Home Assistant integration
[GuiHash/ha-intratone](https://github.com/GuiHash/ha-intratone) and from a capture of the iOS
app. The server returns `openmode` in upper case (`["DATA"]`), and the plugin compares modes
case-insensitively.

## License

[MIT](LICENSE)
