'use strict';

/*
 * End-to-end test against a mock Keycloak + mock Vimar WebSocket server.
 * No real cloud access. Uses the real HAP-NodeJS characteristics.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const hap = require('hap-nodejs');

const { VimarViewCloudPlatform } = require('../lib/platform');
const { startMockCloud } = require('./mock-cloud');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeApi(storage) {
  const api = new EventEmitter();
  api.hap = hap;
  api.user = { storagePath: () => storage };
  api.platformAccessory = hap.Accessory.prototype.constructor && class PlatformAccessory {
    constructor(name, uuid) {
      this.displayName = name;
      this.UUID = uuid;
      this.context = {};
      this._acc = new hap.Accessory(name, uuid);
      this.services = this._acc.services;
    }
    getService(t) { return this._acc.getService(t); }
    getServiceById(t, s) { return this._acc.getServiceById(t, s); }
    addService(...a) { return this._acc.addService(...a); }
    removeService(s) { return this._acc.removeService(s); }
  };
  api.registered = [];
  api.registerPlatformAccessories = (p, n, list) => api.registered.push(...list);
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  return api;
}

const log = Object.assign((...a) => {}, {
  info: () => {}, warn: (m) => console.log('WARN', m), error: (m) => console.log('ERROR', m), debug: () => {},
});

async function waitFor(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error('timeout');
}

test('login, discovery, state and commands', async () => {
  const cloud = await startMockCloud();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vimar-'));
  const api = fakeApi(storage);
  const base = `http://127.0.0.1:${cloud.port}`;
  const platform = new VimarViewCloudPlatform(log, {
    username: 'me@example.com', password: 'secret', duid: '000000aaa00000',
    _endpoints: { authUrl: `${base}/auth`, tokenUrl: `${base}/token`, wsUrl: `ws://127.0.0.1:${cloud.port}/ws` },
  }, api);
  api.emit('didFinishLaunching');

  try {
    await waitFor(() => api.registered.length === 3);
    // refresh token persisted
    const saved = JSON.parse(fs.readFileSync(path.join(storage, '.vimar-view-cloud-000000AAA00000.json'), 'utf8'));
    assert.strictEqual(saved.refreshToken, 'REFRESH-1');

    // register sent only State_ sfetypes
    await waitFor(() => cloud.received.some((m) => m.function === 'getstatus'));
    const reg = cloud.received.find((m) => m.function === 'register');
    assert.ok(reg.args.find((x) => x.idsf === 101).sfetype.every((s) => s.startsWith('SFE_State_')));

    const Ch = hap.Characteristic;
    const thermo = api.registered.find((a) => a.context.device.idsf === 101);
    const ts = thermo.getService(hap.Service.Thermostat);
    assert.ok(Math.abs(ts.getCharacteristic(Ch.CurrentTemperature).value - 18.4) < 0.001);
    assert.strictEqual(ts.getCharacteristic(Ch.TargetTemperature).value, 20);
    assert.strictEqual(ts.getCharacteristic(Ch.CurrentHeatingCoolingState).value, Ch.CurrentHeatingCoolingState.HEAT);
    assert.strictEqual(ts.getCharacteristic(Ch.TargetHeatingCoolingState).value, Ch.TargetHeatingCoolingState.HEAT);
    const sched = thermo.getServiceById(hap.Service.Switch, 'schedule');
    assert.strictEqual(sched.getCharacteristic(Ch.On).value, true);

    // Set temperature while in Auto → Timed manual first, then setpoint
    cloud.received.length = 0;
    await ts.getCharacteristic(Ch.TargetTemperature).handleSetRequest(21.5);
    const actions = cloud.received.filter((m) => m.function === 'doaction').map((m) => m.args[0]);
    assert.deepStrictEqual(actions, [
      { idsf: 101, sfetype: 'SFE_Cmd_HVACMode', value: 'Timed manual' },
      { idsf: 101, sfetype: 'SFE_Cmd_AmbientSetpoint', value: '21.5' },
    ]);
    await waitFor(() => ts.getCharacteristic(Ch.TargetTemperature).value === 21.5);
    assert.strictEqual(sched.getCharacteristic(Ch.On).value, false);

    // Off, then Heat again → Auto (program)
    cloud.received.length = 0;
    await ts.getCharacteristic(Ch.TargetHeatingCoolingState).handleSetRequest(Ch.TargetHeatingCoolingState.OFF);
    await waitFor(() => ts.getCharacteristic(Ch.TargetHeatingCoolingState).value === 0);
    await ts.getCharacteristic(Ch.TargetHeatingCoolingState).handleSetRequest(Ch.TargetHeatingCoolingState.HEAT);
    const modes = cloud.received.filter((m) => m.function === 'doaction').map((m) => m.args[0].value);
    assert.deepStrictEqual(modes, ['Off', 'Auto']);

    // Heat re-sent while in Manual must NOT reset to Auto
    await sched.getCharacteristic(Ch.On).handleSetRequest(false);
    await waitFor(() => platform.client.getState(101, 'SFE_State_HVACMode') === 'Manual');
    cloud.received.length = 0;
    await ts.getCharacteristic(Ch.TargetHeatingCoolingState).handleSetRequest(Ch.TargetHeatingCoolingState.HEAT);
    assert.strictEqual(cloud.received.filter((m) => m.function === 'doaction').length, 0);

    // Dimmer: brightness while off → On then Brightness
    const dim = api.registered.find((a) => a.context.device.idsf === 102).getService(hap.Service.Lightbulb);
    assert.strictEqual(dim.getCharacteristic(Ch.Brightness).value, 40);
    cloud.received.length = 0;
    await dim.getCharacteristic(Ch.Brightness).handleSetRequest(70);
    assert.deepStrictEqual(cloud.received.filter((m) => m.function === 'doaction').map((m) => [m.args[0].sfetype, m.args[0].value]),
      [['SFE_Cmd_OnOff', 'On'], ['SFE_Cmd_Brightness', '70']]);

    // Shutter: Vimar 100 = closed → HomeKit 0; move to 30 % open → Vimar 70
    const shAcc = api.registered.find((a) => a.context.device.idsf === 103);
    assert.strictEqual(shAcc.displayName, 'Tapparella sud');
    const sh = shAcc.getService(hap.Service.WindowCovering);
    assert.strictEqual(sh.getCharacteristic(Ch.CurrentPosition).value, 0);
    cloud.push([{ idsf: 103, elements: [{ sfetype: 'SFE_State_Shutter', value: 'Change to 70' }] }]);
    await waitFor(() => sh.getCharacteristic(Ch.PositionState).value === Ch.PositionState.INCREASING);
    assert.strictEqual(sh.getCharacteristic(Ch.TargetPosition).value, 30);
    cloud.push([{ idsf: 103, elements: [{ sfetype: 'SFE_State_Shutter', value: '70' }] }]);
    await waitFor(() => sh.getCharacteristic(Ch.CurrentPosition).value === 30);
    assert.strictEqual(sh.getCharacteristic(Ch.PositionState).value, Ch.PositionState.STOPPED);

    // Reconnect: dropped socket → new attach, no duplicate accessories
    const attachesBefore = cloud.received.filter((m) => m.function === 'attach').length;
    cloud.dropAll();
    await waitFor(() => platform.client.connected === false);
    await waitFor(() => platform.client.connected === true, 10000);
    assert.strictEqual(api.registered.length, 3);
    // the refresh token was reused (no new login): token endpoint hit only via refresh or cache
    assert.ok(cloud.httpLog.filter((l) => l === 'POST /login').length === 1);
    assert.ok(cloud.received.filter((m) => m.function === 'attach').length > attachesBefore);
  } finally {
    await platform.client.stop();
    await cloud.close();
  }
});

test('wrong password is an auth error, not a crash', async () => {
  const cloud = await startMockCloud();
  const { VimarCloudClient, VimarAuthError } = require('../lib/client');
  const base = `http://127.0.0.1:${cloud.port}`;
  const c = new VimarCloudClient({
    username: 'me', password: 'nope', duid: 'X', log,
    endpoints: { authUrl: `${base}/auth`, tokenUrl: `${base}/token` },
  });
  await assert.rejects(() => c.login(), VimarAuthError);
  await cloud.close();
});
