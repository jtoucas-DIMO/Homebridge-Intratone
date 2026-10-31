# Changelog

All notable changes to `homebridge-intratone`. Versions follow [semver](https://semver.org/).

## [0.2.1] - 2026-10-31

### Changed

- `app_id` is now optional and defaults to the iOS app's value, `app_apisip_ios`. It names the
  official app, not your account, so every iPhone sends the same one. Set it only with
  `user_agent: android`, whose value isn't known yet. `app_token` is still required and has no
  default.
- The settings form shows **App ID** as an optional plain field, with the default as its
  placeholder.

### Documentation

- Step-by-step guide to read `app_token` on the iPhone itself with Proxyman for iOS.
- Install instructions say to search the full name `homebridge-intratone` in the Homebridge UI,
  because a new package ranks too low to show up for "intratone".
- Added this changelog and a developer guide ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).
- The npm page now links to the GitHub repository and issue tracker.

## [0.2.0] - 2026-10-31

### Added

- **Matter.** On a bridge with Matter enabled (Homebridge 2), every openable door is also
  exposed as a Matter door lock, next to the HomeKit accessory, for Google Home, Alexa,
  SmartThings and other Matter controllers.
  - *Unlock* opens the door. It shows unlocked for `pulse_seconds`, then locked again.
  - A failed open is reported to the controller as an error.
  - Repeated unlocks while a door is opening send a single open.
  - *Lock* only ends the unlocked pulse early, since the door relocks by itself.
  - Cached Matter doors are registered again at startup to get their handlers back, and reset
    to locked.
  - Names are trimmed to Matter's 32-byte limit.
  - As on HomeKit, an empty door list never removes doors.
  - Every door is a lock on Matter, whatever `service` says: Matter has no gate opener.
- `supports-hap` and `supports-matter` package keywords, which the Homebridge UI reads to show
  its HomeKit and Matter badges.

### Changed

- Replaced a test fixture `device_id` with a fully synthetic value.

## [0.1.0] - 2026-10-30

First release: remote opening over the REST API of the official app. Doorbell, video and
two-way audio are out of scope.

### Added

- Homebridge dynamic platform `Intratone`, made to run as a child bridge.
- Sign-in with `POST /api/auth/device`. Several spellings of the phone number are tried (national,
  country code + number, bare number), and the one that works is remembered.
- The 7-day JWT is kept fresh: checked every 12 h and renewed when less than a day is left.
  A refused call triggers one refresh, and concurrent callers share a single refresh.
- Door discovery with `GET /api/access` at startup and every hour (configurable). `data` and
  `ble` doors are exposed. `clemobil` (2G) doors are skipped and logged once, because the app
  opens them with a GSM call. Names get the residence as a prefix when there are several
  residences.
- Opening with `POST /api/access/open/clemobil`, shown as a HomeKit lock (default) or garage
  door that stays unlocked/open for `pulse_seconds`.
- `device_id` and the JWT are stored in Homebridge's storage (mode 0600). The `device_id` is
  generated once, or taken from the config to act as an existing phone.
- On HTTP 429 the plugin honours `Retry-After`, or else waits 1 min, doubling up to 15 min.
- When no door comes back, the log says why. The most common reason is the mobipass key being
  active on another device. Cached doors are kept until the list returns.
- CLI `homebridge-intratone` with `status`, `login`, `list`, `open`, and the mobipass transfer
  commands `activate` and `verify`.
- Debug logging of every request and response, with tokens, app credentials and phone numbers
  masked.
- MIT license.

[0.2.1]: https://github.com/jtoucas-DIMO/Homebridge-Intratone/releases/tag/v0.2.1
[0.2.0]: https://github.com/jtoucas-DIMO/Homebridge-Intratone/releases/tag/v0.2.0
[0.1.0]: https://github.com/jtoucas-DIMO/Homebridge-Intratone/releases/tag/v0.1.0
