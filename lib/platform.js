'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    this.handlers = new Map(); // `${duid}:${idsf}` → accessory handler
    this.links = []; // one per DUID: { duid, client, disconnectedSince, isOffline() }

    const duids = VimarViewCloudPlatform.parseDuids(this.config.duid);
    if (!this.config.username || !this.config.password || !duids.length) {
      this.log.error('Configurazione incompleta: servono username, password e almeno un DUID. Plugin disattivato.');
      return;
    }
    for (const d of duids) {
      if (!/^[0-9A-Z]{14}$/.test(d)) {
        this.log.warn(`DUID "${d}" non ha il formato atteso (es. 013009FAL00087). `
          + 'Usa i codici sotto "Informazioni sui dispositivi gateway" in Info di sistema, non l\'UID impianto.');
      }
    }
    this.exclude = new Set((this.config.exclude || []).map((x) => String(x).trim().toLowerCase()));
    this.types = new Set(this.config.deviceTypes && this.config.deviceTypes.length
      ? this.config.deviceTypes
      : ['thermostat', 'light', 'dimmer', 'shutter', 'switch']);

    const userKey = crypto.createHash('sha1').update(String(this.config.username).toLowerCase()).digest('hex').slice(0, 12);
    this.tokenFile = path.join(api.user.storagePath(), `.vimar-view-cloud-${userKey}.json`);

    let owner = null;
    for (const duid of duids) {
      const client = new VimarCloudClient({
        username: this.config.username,
        password: this.config.password,
        duid,
        refreshToken: owner ? undefined : this.loadRefreshToken(),
        log: this.prefixedLog(duids.length > 1 ? duid : null),
        endpoints: this.config._endpoints, // tests only
      });
      client.debugTraffic = !!this.config.debug;
      if (owner) client.authOwner = owner; // one login shared by all DUIDs
      else {
        owner = client;
        client.on('refreshToken', (t) => this.saveRefreshToken(t));
      }

      const link = {
        duid,
        client,
        disconnectedSince: Date.now(),
        isOffline: () => !!link.disconnectedSince && Date.now() - link.disconnectedSince > OFFLINE_GRACE_MS,
      };
      this.links.push(link);

      client.on('connected', () => { link.disconnectedSince = null; });
      client.on('disconnected', (why) => {
        if (!link.disconnectedSince) link.disconnectedSince = Date.now();
        client.log.warn(`Vimar: cloud disconnected (${why})`);
      });
      client.on('discovery', (devices) => this.syncAccessories(link, devices));
      client.on('state', (ids) => {
        for (const id of ids) {
          const h = this.handlers.get(`${duid}:${id}`);
          if (h) {
            try { h.update(); } catch (e) { this.log.debug(`update ${duid}:${id}: ${e.message}`); }
          }
        }
      });
    }
    this.client = owner; // kept for tests/back-compat

    api.on('didFinishLaunching', async () => {
      // Log in once with the first DUID, then start the others (they reuse the token)
      this.links[0].client.start();
      for (const link of this.links.slice(1)) {
        await new Promise((r) => setTimeout(r, 1500));
        link.client.start();
      }
    });
    api.on('shutdown', () => this.links.forEach((l) => l.client.stop()));
  }

  static parseDuids(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
    return [...new Set(list.map((d) => String(d).trim().toUpperCase()).filter(Boolean))];
  }

  prefixedLog(tag) {
    if (!tag) return this.log;
    const p = (m) => `[${tag}] ${m}`;
    return {
      info: (m) => this.log.info(p(m)),
      warn: (m) => this.log.warn(p(m)),
      error: (m) => this.log.error(p(m)),
      debug: (m) => this.log.debug(p(m)),
    };
  }

  isOffline() {
    return this.links.length ? this.links.every((l) => l.isOffline()) : true;
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

  syncAccessories(link, devices) {
    const { duid, client } = link;
    const PA = this.api.platformAccessory;
    const wanted = new Set();
    const toRegister = [];

    if (this.config.debug) {
      for (const d of devices.values()) {
        client.log.info(`Vimar: [${d.idsf}] "${d.name}" ${d.sstype} → ${d.deviceType} (${d.sfetypes.join(', ')})`);
      }
    }

    for (const device of devices.values()) {
      if (!TYPES[device.deviceType] || !this.types.has(device.deviceType) || this.isExcluded(device)) continue;
      const id = this.api.hap.uuid.generate(`vimar-view-cloud:${duid}:${device.idsf}`);
      const key = `${duid}:${device.idsf}`;
      // The same function reported by two DUIDs (e.g. a whole-plant discovery): expose it once
      const dup = [...this.handlers.entries()].find(([k, h]) => !k.startsWith(`${duid}:`)
        && h.idsf === device.idsf && h.device.name === device.name && h.device.sstype === device.sstype);
      if (dup) {
        client.log.debug(`Vimar: "${device.name}" già esposto da ${dup[0].split(':')[0]}, salto il duplicato`);
        continue;
      }
      wanted.add(id);
      if (this.handlers.has(key)) {
        this.handlers.get(key).update();
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
      accessory.context.duid = duid;
      device.link = link;

      try {
        const handler = new TYPES[device.deviceType](this, accessory, device);
        this.handlers.set(key, handler);
        handler.update();
      } catch (err) {
        client.log.error(`Vimar: cannot create "${device.name}": ${err.message}`);
        continue;
      }

      if (isNew) {
        client.log.info(`Vimar: aggiunto "${device.name}" (${device.deviceType})`);
        this.cached.set(id, accessory);
        toRegister.push(accessory);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    if (toRegister.length) this.api.registerPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, toRegister);

    // Never wipe accessories (and the user's HomeKit automations) on an empty/partial discovery.
    // Only this DUID's accessories are candidates (legacy entries without a DUID are left alone).
    const stale = devices.size
      ? [...this.cached.values()].filter((a) => a.context.duid === duid && !wanted.has(a.UUID))
      : [];
    if (stale.length) {
      for (const a of stale) {
        this.log.info(`Vimar: rimosso "${a.displayName}"`);
        this.cached.delete(a.UUID);
      }
      this.api.unregisterPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, stale);
    }

    if (!wanted.size) {
      client.log.warn('Vimar: nessun dispositivo supportato trovato. Attiva "debug" per vedere cosa espone il cloud.');
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
