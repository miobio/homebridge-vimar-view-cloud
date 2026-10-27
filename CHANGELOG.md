# Changelog

## 0.3.0
- All log messages, Homebridge UI labels and documentation are now in English.
- New option `scheduleSwitchName` (default `Schedule`) for the label of the thermostat's schedule switch.
- README: troubleshooting section (DUID, child bridge PIN, VPN/mDNS, installation path).

## 0.2.2
- Debug mode logs the WebSocket traffic at info level, with tokens, e-mail and MAC addresses masked.
- The raw attach response is no longer logged outside debug mode.

## 0.2.0
- Multiple DUIDs: one login, one cloud connection per device (e.g. several stand-alone 02912 "STW" thermostats).
- Clear diagnostics when the cloud closes the socket before attach (code 1013 = unknown/offline DUID).

## 0.1.0
- First release: Node.js port of the Vimar View cloud protocol from ha-vimar-view; thermostats, lights, dimmers, shutters, automations, scenes.
