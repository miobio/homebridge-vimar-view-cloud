# homebridge-vimar-view-cloud

**Unofficial** [Homebridge](https://homebridge.io) plugin that brings **Vimar View** devices into Apple HomeKit through the Vimar cloud, the same backend used by the official *View* app.

Tested on three stand-alone **Wi-Fi thermostats 02912** ("STW" devices). It is a Node.js port of the protocol reverse-engineered by the Home Assistant integration [ha-vimar-view](https://github.com/ivhazu/ha-vimar-view) (MIT, © Andrea Baronchelli), extended to support several devices per account.

> ⚠️ Not affiliated with Vimar S.p.A. The protocol was reverse-engineered: a change to the Vimar cloud or app can break it without notice. An internet connection is required: no cloud, no HomeKit control.

## Supported devices

| Vimar function (`sstype`) | HomeKit | Notes |
|---|---|---|
| `SS_Clima_Zone` (Wi-Fi thermostat **02912**, climate zones) | Thermostat + "Schedule" switch | current temperature, setpoint, Off/Heat (/Cool), heating status. **Tested.** |
| `SS_Light_Switch` | Lightbulb | on/off |
| `SS_Light_Dimmer` | Dimmable lightbulb | on/off, brightness |
| `SS_Shutter_Position` | Window covering | position, stop |
| `SS_Automation_OnOff` | Switch | on/off |
| `SS_Scene_Executor` | Stateless switch | disabled by default |

Lights, dimmers, shutters and scenes follow the Home Assistant integration's implementation but have **not** been tested with real hardware yet. Reports are welcome.

### Thermostat behaviour

- **Off / Heat** in the Home app: Off turns the thermostat off. Heat turns it back on in *Auto*, i.e. following the weekly schedule (configurable with `onMode`). If the thermostat is already on in manual mode, a repeated "Heat" does not reset it to Auto.
- **Changing the temperature**: like the official app, if the thermostat is in *Auto* it first switches to *Timed manual*, then applies the setpoint.
- **"Schedule" switch**: on = follow the weekly schedule (Auto), off = permanent manual.
- **Current state**: "Heating" when the relay is active (`OutStatus = Heat`), otherwise "Off" (idle).

## Installation

From the Homebridge UI: search for **Vimar View Cloud** in the Plugins tab.

From a terminal on the Homebridge server (official image or apt package), as the `homebridge` user:

```bash
sudo -u homebridge env PATH=/opt/homebridge/bin:$PATH \
  bash -c 'cd /var/lib/homebridge && npm install homebridge-vimar-view-cloud'
sudo hb-service restart
```

> Do **not** use `sudo npm install -g` on the official image or apt package: it installs into the system Node.js, which Homebridge does not use, and the plugin will not show up.

Requires Node.js 18.20+ and Homebridge 1.8 or 2.x.

## Configuration

```json
{
  "platform": "VimarViewCloud",
  "name": "Vimar View",
  "username": "you@example.com",
  "password": "your MyVimar password",
  "duid": "013009FAL00087, 013009FAL00117, 013009FAL00123",
  "onMode": "Auto",
  "scheduleSwitch": true,
  "scheduleSwitchName": "Schedule",
  "enableCooling": false,
  "minTemperature": 5,
  "maxTemperature": 35,
  "deviceTypes": ["thermostat", "light", "dimmer", "shutter", "switch"],
  "exclude": [],
  "debug": false
}
```

| Key | Default | Description |
|---|---|---|
| `username`, `password` | — | **MyVimar** credentials, the same as the View app |
| `duid` | — | one or more device DUIDs, comma-separated (see below) |
| `onMode` | `Auto` | mode used when a thermostat is turned on from HomeKit: `Auto` (schedule) or `Manual` |
| `scheduleSwitch` | `true` | adds the "Schedule" switch to each thermostat |
| `scheduleSwitchName` | `Schedule` | label appended to the thermostat name for that switch |
| `enableCooling` | `false` | show the Cool mode |
| `minTemperature` / `maxTemperature` | 5 / 35 | setpoint range in the Home app |
| `deviceTypes` | all but `scene` | device types to expose |
| `exclude` | `[]` | names or `idsf` values to ignore |
| `debug` | `false` | logs every function found and the WebSocket traffic, with tokens, e-mail and MAC addresses masked |

### Finding the DUID

View app → **Settings** → **System info** → section **"Gateway devices"**. Every device connected to the cloud is listed with its own code, formatted like `013009FAL00087`:

- **stand-alone Wi-Fi thermostats 02912** appear as **STW**, and each one has **its own** DUID;
- **View Wireless** systems use the DUID of the gateway (**BLEG**).

With several devices, list them all, comma-separated. The plugin logs in once and opens one cloud connection per DUID.

⚠️ Do **not** use the *Plant UID* (the one with dashes, like `9BF5F94A-…`). The cloud closes the connection with code **1013** and the log shows `closed before attach`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Log: `closed before attach (1013 …)` | Wrong DUID (often the plant UID), or the device is offline. See *Finding the DUID*. |
| Log: `authentication error` | Wrong MyVimar e-mail or password. After an auth error the plugin retries only every 10 minutes, to avoid locking the account. |
| Plugin installed but not listed in the Homebridge UI | It was installed outside `/var/lib/homebridge` (e.g. with `sudo npm install -g`). Reinstall as shown in *Installation*. On a fresh Raspberry Pi OS, installing from GitHub also needs `git` (`sudo apt install git`). |
| Values are correct in the Homebridge UI, but the Home app shows nothing or "No Response" | A HomeKit problem, not a plugin one. The home hub (HomePod / Apple TV) must be on the **same LAN** as Homebridge, because HomeKit discovery (mDNS/Bonjour) does not cross routed VPNs such as WireGuard site-to-site. Run Homebridge in the house where the thermostats' HomeKit home is. |
| Homebridge UI: *"Failed to control accessory. Make sure the Homebridge pin for 127.0.0.1:xxxxx is set to …"* | The plugin runs in a **child bridge** with a PIN different from the main bridge. The UI controls accessories using the main bridge PIN, so remove `pin` from the child bridge's `_bridge` block (or set it to the main PIN) and restart. Existing HomeKit pairings are not affected. |
| Removed the bridge from the Home app, now re-adding it times out | Homebridge still believes it is paired. Unpair it in the Homebridge UI settings, or give the child bridge a new `_bridge.username`, then restart and pair again. |

## How it works

- **Authentication**: OAuth2 Authorization Code + PKCE against the Keycloak server at `prod.vimar.cloud` (client `mobile-user-view2`). The refresh token (one per account, shared by all DUIDs) is stored in `<Homebridge storage>/.vimar-view-cloud-<user hash>.json` with mode 600, so restarts do not need a full login.
- **Connection**: one persistent WebSocket per DUID (`wss://prod.vimar.cloud/wssmqtt/deviceproxy`). Sequence: `attach` → `sfdiscovery` → `register`/`getstatus`. State changes are pushed with `changestatus` and commands are sent with `doaction`. A keepalive goes out every 25 s, and reconnection uses a 5–60 s backoff.
- **Availability**: during short outages the Home app keeps the last known state. After 3 minutes without the cloud, accessories report "No Response".
- **Accessory cache**: an empty discovery (cloud hiccup) never removes accessories, so your HomeKit automations are preserved.

## Development

```bash
npm install
npm test
```

The tests run against a mock Keycloak and a mock Vimar WebSocket server, with no access to the real cloud. They cover login, attach, discovery, state pushes, thermostat commands, dimmers, shutters, reconnection and multiple DUIDs.

## License

MIT, see `LICENSE`, which keeps the attribution to the original project.
