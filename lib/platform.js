'use strict';

const fs = require('fs');
const path = require('path');

const C = require('./constants');
const { VimarCloudClient } = require('./client');
const { TYPES, SERVICE_FOR, homeKitName } = require('./accessories');

const OFFLINE_GRACE_MS = 3 * 60 * 1000;

class VimarViewCloudPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map(); // UUID → PlatformAccessory
    this.handlers = new Map(); // idsf → accessory handler
    this.disconnectedSince = Date.now();

    if (!this.config.username || !this.config.password || !this.config.duid) {
      this.log.error('Configurazione incompleta: servono username, password e duid. Plugin disattivato.');
      return;
    }
    this.config.duid = String(this.config.duid).trim().toUpperCase();
    this.exclude = new Set((this.config.exclude || []).map((x) => String(x).trim().toLowerCase()));
    this.types = new Set(this.config.deviceTypes && this.config.deviceTypes.length
      ? this.config.deviceTypes
      : ['thermostat', 'light', 'dimmer', 'shutter', 'switch']);

    this.tokenFile = path.join(api.user.storagePath(), `.vimar-view-cloud-${this.config.duid}.json`);

    this.client = new VimarCloudClient({
      username: this.config.username,
      password: this.config.password,
      duid: this.config.duid,
      refreshToken: this.loadRefreshToken(),
      log: this.log,
      endpoints: this.config._endpoints, // tests only
    });
    this.client.debugTraffic = !!this.config.debug;

    this.client.on('refreshToken', (t) => this.saveRefreshToken(t));
    this.client.on('connected', () => { this.disconnectedSince = null; });
    this.client.on('disconnected', (why) => {
      if (!this.disconnectedSince) this.disconnectedSince = Date.now();
      this.log.warn(`Vimar: cloud disconnected (${why})`);
    });
    this.client.on('discovery', (devices) => this.syncAccessories(devices));
    this.client.on('state', (ids) => {
      for (const id of ids) {
        const h = this.handlers.get(id);
        if (h) {
          try { h.update(); } catch (e) { this.log.debug(`update ${id}: ${e.message}`); }
        }
      }
    });

    api.on('didFinishLaunching', () => this.client.start());
    api.on('shutdown', () => this.client.stop());
  }

  isOffline() {
    return !!this.disconnectedSince && Date.now() - this.disconnectedSince > OFFLINE_GRACE_MS;
  }

  loadRefreshToken() {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      if (data.username === this.config.username) return data.refreshToken;
    } catch (e) { /* first run */ }
    return undefined;
  }

  saveRefreshToken(refreshToken) {
    try {
      fs.writeFileSync(this.tokenFile, JSON.stringify({ username: this.config.username, refreshToken }), { mode: 0o600 });
    } catch (e) {
      this.log.warn(`Impossibile salvare il refresh token: ${e.message}`);
    }
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  isExcluded(device) {
    return this.exclude.has(String(device.idsf)) || this.exclude.has(String(device.name).trim().toLowerCase());
  }

  syncAccessories(devices) {
    const PA = this.api.platformAccessory;
    const wanted = new Set();
    const toRegister = [];

    if (this.config.debug) {
      for (const d of devices.values()) {
        this.log.info(`Vimar: [${d.idsf}] "${d.name}" ${d.sstype} → ${d.deviceType} (${d.sfetypes.join(', ')})`);
      }
    }

    for (const device of devices.values()) {
      if (!TYPES[device.deviceType] || !this.types.has(device.deviceType) || this.isExcluded(device)) continue;
      const id = this.api.hap.uuid.generate(`vimar-view-cloud:${this.config.duid}:${device.idsf}`);
      wanted.add(id);
      if (this.handlers.has(device.idsf)) {
        this.handlers.get(device.idsf).update();
        continue;
      }

      let accessory = this.cached.get(id);
      const isNew = !accessory;
      if (isNew) {
        const name = homeKitName(device.name);
        accessory = new PA(name, id);
        accessory.category = this.categoryFor(device.deviceType);
      } else {
        // Drop services left over if the device type changed
        const keep = SERVICE_FOR(this.api.hap.Service)[device.deviceType];
        for (const s of [...accessory.services]) {
          if (s.UUID === this.api.hap.Service.AccessoryInformation.UUID) continue;
          if (s.UUID !== keep.UUID && s.subtype !== 'schedule') accessory.removeService(s);
        }
      }
      accessory.context.device = { idsf: device.idsf, name: device.name, sstype: device.sstype };

      try {
        const handler = new TYPES[device.deviceType](this, accessory, device);
        this.handlers.set(device.idsf, handler);
        handler.update();
      } catch (err) {
        this.log.error(`Vimar: cannot create "${device.name}": ${err.message}`);
        continue;
      }

      if (isNew) {
        this.log.info(`Vimar: aggiunto "${device.name}" (${device.deviceType})`);
        this.cached.set(id, accessory);
        toRegister.push(accessory);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    if (toRegister.length) this.api.registerPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, toRegister);

    // Never wipe accessories (and the user's HomeKit automations) on an empty/partial discovery.
    const stale = devices.size ? [...this.cached.values()].filter((a) => !wanted.has(a.UUID)) : [];
    if (stale.length) {
      for (const a of stale) {
        this.log.info(`Vimar: rimosso "${a.displayName}"`);
        this.cached.delete(a.UUID);
      }
      this.api.unregisterPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, stale);
    }

    if (!wanted.size) {
      this.log.warn('Vimar: nessun dispositivo supportato trovato. Attiva "debug" per vedere cosa espone il cloud.');
    }
  }

  categoryFor(type) {
    const Cat = this.api.hap.Categories;
    return {
      thermostat: Cat.THERMOSTAT,
      light: Cat.LIGHTBULB,
      dimmer: Cat.LIGHTBULB,
      shutter: Cat.WINDOW_COVERING,
      switch: Cat.SWITCH,
      scene: Cat.SWITCH,
    }[type];
  }
}

module.exports = { VimarViewCloudPlatform };
