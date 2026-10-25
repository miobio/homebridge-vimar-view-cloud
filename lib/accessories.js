'use strict';

const C = require('./constants');

const MODEL = {
  thermostat: 'Termostato (SS_Clima_Zone)',
  light: 'Luce (SS_Light_Switch)',
  dimmer: 'Dimmer (SS_Light_Dimmer)',
  shutter: 'Tapparella (SS_Shutter_Position)',
  switch: 'Automazione (SS_Automation_OnOff)',
  scene: 'Scenario (SS_Scene_Executor)',
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

/** HomeKit names: letters, digits, spaces and a few symbols; must start/end alphanumeric. */
function homeKitName(name) {
  const clean = String(name || 'Vimar')
    .replace(/[^\p{L}\p{N} '’.,\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return clean || 'Vimar';
}

class BaseAccessory {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.idsf = device.idsf;
    this.client = platform.client;
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.name = homeKitName(device.name);

    const { Service, Characteristic } = this.hap;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Vimar')
      .setCharacteristic(Characteristic.Model, MODEL[device.deviceType] || device.sstype || 'Vimar View')
      .setCharacteristic(Characteristic.SerialNumber, `${platform.config.duid}-${device.idsf}`)
      .setCharacteristic(Characteristic.FirmwareRevision, require('../package.json').version);
  }

  state(sfetype) {
    return this.client.getState(this.idsf, sfetype);
  }

  /** Reads are served from the push cache; report "No response" only after a real outage. */
  guardRead() {
    if (this.platform.isOffline()) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async run(label, fn) {
    try {
      await fn();
    } catch (err) {
      this.log.error(`${this.name}: ${label} failed: ${err.message}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  service(type, name, subtype) {
    const existing = subtype
      ? this.accessory.getServiceById(type, subtype)
      : this.accessory.getService(type);
    const svc = existing || this.accessory.addService(type, name, subtype);
    svc.setCharacteristic(this.hap.Characteristic.Name, name);
    return svc;
  }

  update() {}
}

// ─── Thermostat (02912 / zone clima) ──────────────────────────────────────────

class ThermostatAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const { Service, Characteristic: Ch } = this.hap;
    const cfg = platform.config;
    this.cooling = !!cfg.enableCooling;
    this.onMode = cfg.onMode === 'Manual' ? C.HVAC_MANUAL : C.HVAC_AUTO;

    const s = this.svc = this.service(Service.Thermostat, this.name);

    s.getCharacteristic(Ch.CurrentTemperature)
      .setProps({ minValue: -20, maxValue: 60, minStep: 0.1 })
      .onGet(() => { this.guardRead(); return this.currentTemp(); });

    s.getCharacteristic(Ch.TargetTemperature)
      .setProps({ minValue: cfg.minTemperature || 5, maxValue: cfg.maxTemperature || 35, minStep: 0.5 })
      .onGet(() => { this.guardRead(); return this.targetTemp(); })
      .onSet((v) => this.run('set temperature', () => this.client.setTemperature(this.idsf, Number(v).toFixed(1))));

    s.getCharacteristic(Ch.CurrentHeatingCoolingState)
      .onGet(() => { this.guardRead(); return this.currentHC(); });

    const valid = [Ch.TargetHeatingCoolingState.OFF, Ch.TargetHeatingCoolingState.HEAT];
    if (this.cooling) valid.push(Ch.TargetHeatingCoolingState.COOL);
    s.getCharacteristic(Ch.TargetHeatingCoolingState)
      .setProps({ validValues: valid })
      .onGet(() => { this.guardRead(); return this.targetHC(); })
      .onSet((v) => this.run('set mode', () => this.setTargetHC(v)));

    s.getCharacteristic(Ch.TemperatureDisplayUnits)
      .onGet(() => Ch.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {});

    // Optional switch: ON = follow weekly program (Auto), OFF = permanent manual
    const schedName = `${this.name} Programma`;
    const existing = accessory.getServiceById(Service.Switch, 'schedule');
    if (cfg.scheduleSwitch === false) {
      if (existing) accessory.removeService(existing);
    } else {
      this.schedule = this.service(Service.Switch, schedName, 'schedule');
      this.schedule.getCharacteristic(Ch.On)
        .onGet(() => { this.guardRead(); return this.state(C.SFE_STATE_HVAC_MODE) === C.HVAC_AUTO; })
        .onSet((on) => this.run('set program', () => this.client.setHvacMode(this.idsf, on ? C.HVAC_AUTO : C.HVAC_MANUAL)));
    }
  }

  currentTemp() {
    return num(this.state(C.SFE_STATE_AMBIENT_TEMPERATURE)) ?? 0;
  }

  targetTemp() {
    const cfg = this.platform.config;
    const v = num(this.state(C.SFE_STATE_AMBIENT_SETPOINT));
    if (v === undefined) return cfg.minTemperature || 5;
    return Math.min(cfg.maxTemperature || 35, Math.max(cfg.minTemperature || 5, v));
  }

  isCoolingSeason() {
    return this.state(C.SFE_STATE_CHANGE_OVER_MODE) === C.CHANGE_OVER_COOLING;
  }

  currentHC() {
    const Ch = this.hap.Characteristic.CurrentHeatingCoolingState;
    if (this.state(C.SFE_STATE_HVAC_MODE) === C.HVAC_OFF) return Ch.OFF;
    const out = this.state(C.SFE_STATE_OUT_STATUS);
    if (out === C.OUT_HEAT) return Ch.HEAT;
    if (out === C.OUT_COOL) return Ch.COOL;
    return Ch.OFF; // idle
  }

  targetHC() {
    const Ch = this.hap.Characteristic.TargetHeatingCoolingState;
    if (this.state(C.SFE_STATE_HVAC_MODE) === C.HVAC_OFF) return Ch.OFF;
    return this.cooling && this.isCoolingSeason() ? Ch.COOL : Ch.HEAT;
  }

  async setTargetHC(value) {
    const Ch = this.hap.Characteristic.TargetHeatingCoolingState;
    const mode = this.state(C.SFE_STATE_HVAC_MODE);
    if (value === Ch.OFF) {
      if (mode !== C.HVAC_OFF) await this.client.setHvacMode(this.idsf, C.HVAC_OFF);
      return;
    }
    const wantCooling = value === Ch.COOL;
    const seasonChange = wantCooling !== this.isCoolingSeason();
    if (seasonChange) {
      await this.client.setChangeOver(this.idsf, wantCooling ? C.CHANGE_OVER_COOLING : C.CHANGE_OVER_HEATING);
    }
    // Do not override a manual mode just because Siri/HomeKit re-sends "Heat".
    if (mode === C.HVAC_OFF || mode === undefined || seasonChange) {
      await this.client.setHvacMode(this.idsf, this.onMode);
    }
  }

  update() {
    const Ch = this.hap.Characteristic;
    this.svc.updateCharacteristic(Ch.CurrentTemperature, this.currentTemp());
    this.svc.updateCharacteristic(Ch.TargetTemperature, this.targetTemp());
    this.svc.updateCharacteristic(Ch.CurrentHeatingCoolingState, this.currentHC());
    this.svc.updateCharacteristic(Ch.TargetHeatingCoolingState, this.targetHC());
    if (this.schedule) {
      this.schedule.updateCharacteristic(Ch.On, this.state(C.SFE_STATE_HVAC_MODE) === C.HVAC_AUTO);
    }
  }
}

// ─── Lights / dimmers ─────────────────────────────────────────────────────────

class LightAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const { Service, Characteristic: Ch } = this.hap;
    this.dimmable = device.deviceType === 'dimmer';
    const s = this.svc = this.service(Service.Lightbulb, this.name);

    s.getCharacteristic(Ch.On)
      .onGet(() => { this.guardRead(); return this.isOn(); })
      .onSet((on) => {
        if (on && this.isOn()) return undefined; // HomeKit sends On=true with brightness changes
        return this.run(on ? 'turn on' : 'turn off', () => (on ? this.client.turnOn(this.idsf) : this.client.turnOff(this.idsf)));
      });

    if (this.dimmable) {
      s.getCharacteristic(Ch.Brightness)
        .onGet(() => { this.guardRead(); return this.brightness(); })
        .onSet((v) => this.run('set brightness', async () => {
          if (v <= 0) return this.client.turnOff(this.idsf);
          if (!this.isOn()) await this.client.turnOn(this.idsf);
          return this.client.setBrightness(this.idsf, v);
        }));
    }
  }

  isOn() { return this.state(C.SFE_STATE_ONOFF) === 'On'; }

  brightness() {
    const v = num(this.state(C.SFE_STATE_BRIGHTNESS));
    return v === undefined ? 100 : Math.max(0, Math.min(100, Math.round(v)));
  }

  update() {
    const Ch = this.hap.Characteristic;
    this.svc.updateCharacteristic(Ch.On, this.isOn());
    if (this.dimmable) this.svc.updateCharacteristic(Ch.Brightness, this.brightness());
  }
}

// ─── Shutters ─────────────────────────────────────────────────────────────────

class ShutterAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const { Service, Characteristic: Ch } = this.hap;
    this.lastPos = 0;
    this.target = undefined;
    const s = this.svc = this.service(Service.WindowCovering, this.name);

    s.getCharacteristic(Ch.CurrentPosition).onGet(() => { this.guardRead(); return this.position(); });
    s.getCharacteristic(Ch.PositionState).onGet(() => this.positionState());
    s.getCharacteristic(Ch.TargetPosition)
      .onGet(() => { this.guardRead(); return this.targetPosition(); })
      .onSet((v) => this.run('move', () => {
        this.target = v;
        return this.client.setShutter(this.idsf, 100 - v); // HomeKit 100 = open, Vimar 0 = open
      }));
    s.getCharacteristic(Ch.HoldPosition).onSet((hold) => {
      if (!hold) return undefined;
      return this.run('stop', () => { this.target = undefined; return this.client.setShutter(this.idsf, C.SHUTTER_STOP); });
    });
  }

  raw() { return this.state(C.SFE_STATE_SHUTTER); }

  moving() {
    const r = this.raw();
    if (typeof r !== 'string' || !r.startsWith('Change to')) return undefined;
    const n = parseInt(r.replace(/\D+/g, ''), 10);
    return Number.isFinite(n) ? 100 - n : null; // destination in HomeKit scale (null = unknown)
  }

  position() {
    const r = this.raw();
    if (this.moving() === undefined) {
      const n = parseInt(r, 10);
      if (Number.isFinite(n)) this.lastPos = Math.max(0, Math.min(100, 100 - n));
    }
    return this.lastPos;
  }

  targetPosition() {
    const dest = this.moving();
    if (typeof dest === 'number') return dest;
    if (dest === null && this.target !== undefined) return this.target;
    return this.position();
  }

  positionState() {
    const PS = this.hap.Characteristic.PositionState;
    if (this.moving() === undefined) return PS.STOPPED;
    const pos = this.position();
    const tgt = this.targetPosition();
    if (tgt > pos) return PS.INCREASING;
    if (tgt < pos) return PS.DECREASING;
    return PS.STOPPED;
  }

  update() {
    const Ch = this.hap.Characteristic;
    if (this.moving() === undefined) this.target = undefined;
    this.svc.updateCharacteristic(Ch.CurrentPosition, this.position());
    this.svc.updateCharacteristic(Ch.TargetPosition, this.targetPosition());
    this.svc.updateCharacteristic(Ch.PositionState, this.positionState());
  }
}

// ─── Generic on/off automation ────────────────────────────────────────────────

class SwitchAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const { Service, Characteristic: Ch } = this.hap;
    const s = this.svc = this.service(Service.Switch, this.name);
    s.getCharacteristic(Ch.On)
      .onGet(() => { this.guardRead(); return this.state(C.SFE_STATE_ONOFF) === 'On'; })
      .onSet((on) => this.run('switch', () => (on ? this.client.turnOn(this.idsf) : this.client.turnOff(this.idsf))));
  }

  update() {
    this.svc.updateCharacteristic(this.hap.Characteristic.On, this.state(C.SFE_STATE_ONOFF) === 'On');
  }
}

// ─── Scenes (stateless switch) ────────────────────────────────────────────────

class SceneAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const { Service, Characteristic: Ch } = this.hap;
    const s = this.svc = this.service(Service.Switch, this.name);
    s.getCharacteristic(Ch.On)
      .onGet(() => false)
      .onSet((on) => {
        if (!on) return undefined;
        setTimeout(() => s.updateCharacteristic(Ch.On, false), 1000);
        return this.run('scene', () => this.client.executeScene(this.idsf));
      });
  }
}

const TYPES = {
  thermostat: ThermostatAccessory,
  light: LightAccessory,
  dimmer: LightAccessory,
  shutter: ShutterAccessory,
  switch: SwitchAccessory,
  scene: SceneAccessory,
};

const SERVICE_FOR = (Service) => ({
  thermostat: Service.Thermostat,
  light: Service.Lightbulb,
  dimmer: Service.Lightbulb,
  shutter: Service.WindowCovering,
  switch: Service.Switch,
  scene: Service.Switch,
});

module.exports = { TYPES, SERVICE_FOR, homeKitName };
