# Changelog

All notable changes to `homebridge-intratone`. Versions follow [semver](https://semver.org/).

## [1.0.2] - 2026-11-13

### Fixed

- `config.schema.json`: declare the required fields with a JSON-Schema `required` array at the
  object level instead of a boolean `required` on each property, so the schema validates (flagged
  by Homebridge plugin verification).

### Changed

- Added a secret-free API reference ([docs/PROTOCOL.md](docs/PROTOCOL.md)) covering auth, device
  registration, the mobipass key, accesses, device management, rate limiting and error codes.
- Added continuous integration (lint, type-check, test, build on Node 22/24/26) and narrowed the
  supported `engines` to the current LTS set (dropped end-of-life Node 20).
- Removed unused legacy configuration fields left over from the config-driven door-key claim.

## [1.0.1] - 2026-11-12

First public release. Remote opening of Intratone / Cogelec doors and gates from HomeKit, Matter
and automations. Doorbell, video and two-way audio are out of scope.

### Features

- Every access your account can open over the API (`data`/4G mobipass and `ble`) becomes a HomeKit
  **lock** or **garage door**, and — on a bridge with Matter enabled (Homebridge 2) — a Matter
  **door lock** for Google Home, Alexa, SmartThings or Apple Home. A successful open shows
  unlocked/open for `pulse_seconds`, then relocks; an empty access list never removes doors.
- **Guided setup in the settings page, no restart.** Enter the account phone number, then, under
  **Door key**, pair the device (4-digit SMS) and claim the 4G key (6-digit SMS) — each code is
  entered right on the page and the second one is requested automatically. The **Device ID** has
  its own *This device* section with a *Regenerate* button. Sharing a phone's device id is the
  advanced alternative to claiming.
- **Built-in iOS app credentials** (`app_id`, `app_token`), so a normal install needs only the
  phone number — no traffic capture.
- Keeps the 7-day JWT fresh (checked every 12 h, renewed under a day, shared refresh), backs off on
  HTTP 429, renames doors from the settings page, runs well as a child bridge.
- Bundled `homebridge-intratone` CLI (`status`, `login`, `list`, `open`, `activate`, `verify`) and
  debug logging with tokens, credentials and phone numbers masked. MIT licensed.

[1.0.2]: https://github.com/jtoucas-DIMO/Homebridge-Intratone/releases/tag/v1.0.2
[1.0.1]: https://github.com/jtoucas-DIMO/Homebridge-Intratone/releases/tag/v1.0.1
