'use strict';

/*
 * Vimar View cloud client.
 *
 * Port to Node.js of the reverse-engineered protocol implemented in the
 * Home Assistant integration "Vimar View Cloud"
 * (https://github.com/ivhazu/ha-vimar-view, MIT, (c) Andrea Baronchelli).
 *
 *  - OAuth2 Authorization Code + PKCE against Keycloak on prod.vimar.cloud
 *  - WebSocket wss://prod.vimar.cloud/wssmqtt/deviceproxy?duid=…&access_token=…
 *  - JSON messages: attach → sfdiscovery(Plant) → register/getstatus,
 *    pushes via "changestatus", commands via "doaction", keepalive every 25 s.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const C = require('./constants');

const USER_AGENT = 'VIEW / 2.16.2 (1260324852) - 8250fb9b66c413b6 - Android';
const WS_USER_AGENT = 'okhttp/5.3.2';

class VimarAuthError extends Error {}
class VimarConnectionError extends Error {}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Hide session tokens, e-mail and MAC addresses when logging protocol traffic. */
const redact = (text) => text
  .replace(/"(token|password|username|mac|useruid)":"[^"]*"/g, '"$1":"***"');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal cookie jar (all requests go to the same Keycloak host). */
class CookieJar {
  constructor() { this.cookies = new Map(); }
  store(headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

class VimarCloudClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.username  MyVimar e-mail
   * @param {string} opts.password  MyVimar password
   * @param {string} opts.duid      gateway / device DUID
   * @param {string} [opts.refreshToken]
   * @param {object} [opts.log]     Homebridge logger
   * @param {object} [opts.endpoints] override URLs (tests)
   */
  constructor(opts) {
    super();
    this.username = opts.username;
    this.password = opts.password;
    this.duid = String(opts.duid || '').trim().toUpperCase();
    this.log = opts.log || console;
    this.endpoints = Object.assign({
      authUrl: C.VIMAR_OAUTH_AUTH_URL,
      tokenUrl: C.VIMAR_TOKEN_URL,
      wsUrl: C.VIMAR_WS_URL,
    }, opts.endpoints || {});

    this.accessToken = null;
    this.refreshToken = opts.refreshToken || null;
    this.tokenExpiresAt = 0;
    this.userUid = '';

    this.sessionToken = null;
    this.sourceId = crypto.randomBytes(8).toString('hex');
    this.clientToken = b64url(crypto.randomBytes(12));
    this.msgid = 9;

    this.ws = null;
    this.running = false;
    this.pending = new Map();
    this.requestTimeout = 15000;

    /** idsf → { idsf, name, sstype, sfetypes, deviceType, ambient } */
    this.devices = new Map();
    /** idsf → { sfetype: value } */
    this.states = new Map();

    this.plantName = '';
    this.gatewayVersion = '';
    this.gatewayMac = '';
  }

  // ─── Token management ─────────────────────────────────────────────────────

  /** Several clients (one per DUID) share one login: secondaries delegate to the auth owner. */
  async getToken() {
    if (this.authOwner) return this.authOwner.getToken();
    if (!this.tokenPromise) {
      this.tokenPromise = this.getTokenUnlocked().finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  async getTokenUnlocked() {
    if (this.accessToken && Date.now() / 1000 < this.tokenExpiresAt - C.TOKEN_REFRESH_MARGIN) {
      return this.accessToken;
    }
    if (this.refreshToken) {
      try {
        return await this.refreshAccessToken();
      } catch (err) {
        this.log.warn(`Vimar: refresh token failed (${err.message}), doing full login`);
        this.refreshToken = null;
      }
    }
    return this.login();
  }

  async http(url, init, jar) {
    const headers = Object.assign({}, init.headers || {});
    if (jar) {
      const cookie = jar.header();
      if (cookie) headers.Cookie = cookie;
    }
    const res = await fetch(url, Object.assign({}, init, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(C.HTTP_TIMEOUT_MS),
    }));
    if (jar) jar.store(res.headers);
    return res;
  }

  async login() {
    this.log.debug('Vimar auth: full login');
    const { verifier, challenge } = pkcePair();
    const jar = new CookieJar();
    const baseHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it',
    };

    // 1) Authorization endpoint → login page (follow redirects, keep cookies)
    const params = new URLSearchParams({
      client_id: C.VIMAR_CLIENT_ID,
      redirect_uri: C.VIMAR_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    let url = `${this.endpoints.authUrl}?${params}`;
    let res;
    for (let i = 0; i < 10; i++) {
      res = await this.http(url, { method: 'GET', headers: baseHeaders }, jar);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).toString();
        continue;
      }
      break;
    }
    if (!res || res.status !== 200) throw new VimarAuthError(`Login page failed (${res && res.status})`);
    const page = await res.text();
    const loginUrl = url;

    const m = page.match(/id="hash"[^>]+value="([^"]+)"/)
      || page.match(/name="hash"[^>]+value="([^"]+)"/)
      || page.match(/value="([^"]+)"\s+id="hash"/);
    if (!m) throw new VimarAuthError('CSRF hash not found in login page');

    // 2) Submit credentials, then follow the redirect chain to the app redirect URI
    let body = new URLSearchParams({ email: this.username, passw: this.password, hash: m[1] });
    let method = 'POST';
    let code = null;
    url = loginUrl;
    for (let i = 0; i < 12; i++) {
      const init = method === 'POST'
        ? { method, body, headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, baseHeaders) }
        : { method, headers: baseHeaders };
      res = await this.http(url, init, jar);
      const location = res.headers.get('location') || '';
      if (![301, 302, 303, 307, 308].includes(res.status)) {
        throw new VimarAuthError(`Unexpected status ${res.status} during login (wrong credentials?)`);
      }
      if (location.startsWith(C.VIMAR_REDIRECT_URI)) {
        const q = new URLSearchParams(location.split('?')[1] || '');
        if (q.get('error')) throw new VimarAuthError(`Authorization failed (${q.get('error')})`);
        code = q.get('code');
        break;
      }
      url = new URL(location, url).toString();
      method = 'GET';
      body = undefined;
    }
    if (!code) throw new VimarAuthError('Authorization code not found in redirect chain');

    // 3) Code → tokens
    res = await this.http(this.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: C.VIMAR_CLIENT_ID,
        redirect_uri: C.VIMAR_REDIRECT_URI,
        code,
        code_verifier: verifier,
      }),
    });
    if (res.status !== 200) throw new VimarAuthError(`Token exchange failed (${res.status})`);
    this.storeTokens(await res.json());
    this.log.info(`Vimar: login OK (refresh token: ${this.refreshToken ? 'yes' : 'no'})`);
    return this.accessToken;
  }

  async refreshAccessToken() {
    const res = await this.http(this.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({
        client_id: C.VIMAR_CLIENT_ID,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (res.status !== 200) throw new VimarAuthError(`Refresh token failed (${res.status})`);
    this.storeTokens(await res.json());
    this.log.debug('Vimar: token refreshed');
    return this.accessToken;
  }

  storeTokens(tokens) {
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
      throw new VimarAuthError('Missing access token');
    }
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token && tokens.refresh_token !== this.refreshToken) {
      this.refreshToken = tokens.refresh_token;
      this.emit('refreshToken', this.refreshToken);
    }
    const expiresIn = Math.max(1, Number(tokens.expires_in) || 300);
    this.tokenExpiresAt = Date.now() / 1000 + expiresIn;
    try {
      const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
      this.userUid = payload.sub || '';
    } catch (e) {
      this.log.warn('Vimar: could not extract useruid from JWT');
    }
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  nextMsgid() { return String(this.msgid++); }

  sendRaw(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new VimarConnectionError('WebSocket not connected');
    if (this.debugTraffic && msg.function !== C.FUNC_KEEPALIVE) this.log.info(`Vimar ⇢ ${redact(JSON.stringify(msg))}`);
    this.ws.send(JSON.stringify(msg));
  }

  request(fn, args, { wait = false, timeout } = {}) {
    const msgid = this.nextMsgid();
    const msg = {
      type: 'request', function: fn, source: this.sourceId, target: this.duid,
      token: this.sessionToken || '', msgid, args, params: [],
    };
    if (!wait) {
      try {
        this.sendRaw(msg);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgid);
        reject(new VimarConnectionError(`Timeout waiting for ${fn}`));
      }, timeout || this.requestTimeout);
      this.pending.set(msgid, { resolve, reject, timer });
      try {
        this.sendRaw(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(msgid);
        reject(err);
      }
    });
  }

  async command(elements, timeout) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionToken) {
      throw new VimarConnectionError('Vimar session not ready');
    }
    await this.request(C.FUNC_DOACTION, elements, { wait: true, timeout });
  }

  failPending(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  attach() {
    this.sendRaw({
      type: 'request', function: C.FUNC_ATTACH, source: this.sourceId, target: this.duid,
      token: this.clientToken, msgid: this.nextMsgid(),
      args: [{
        credential: { username: this.username, useruid: (this.authOwner || this).userUid, password: 'NOPWD' },
        clientinfo: {
          manufacturertag: 'Vimar', clienttag: 'userapp', sfmodelversion: '1.0.0',
          lang: 'it', protocolversion: '2.4',
        },
        communication: { ipaddress: '' },
      }],
      params: [],
    });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (this.debugTraffic && msg.function !== C.FUNC_KEEPALIVE) this.log.info(`Vimar ⇠ ${redact(String(raw)).slice(0, 4000)}`);

    const { type, function: fn, msgid } = msg;
    const error = msg.error || 0;
    const p = msgid !== undefined ? this.pending.get(String(msgid)) : undefined;

    if (error !== 0) {
      this.log.error(`Vimar: error in ${fn}: ${JSON.stringify(msg.result)}`);
      if (type === 'response' && p) {
        clearTimeout(p.timer);
        this.pending.delete(String(msgid));
        p.reject(new VimarConnectionError(`Vimar rejected ${fn} (error ${error})`));
      }
      if (fn === C.FUNC_ATTACH) {
        this.log.error('Vimar: attach refused — check the DUID and that this MyVimar account owns the plant');
      }
      return;
    }

    if (type === 'response') {
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(String(msgid));
        p.resolve(msg);
      }
      const result = Array.isArray(msg.result) ? msg.result : [];
      if (fn === C.FUNC_ATTACH && result.length) {
        const info = result[0] || {};
        this.sessionToken = info.token;
        this.plantName = info.plantname || '';
        const srv = info.serverinfo || {};
        this.gatewayVersion = srv.softwareversion || '';
        this.gatewayMac = srv.mac || '';
        this.log.info(`Vimar: attached to plant "${this.plantName}" (gateway sw ${this.gatewayVersion || '?'})`);
        this.request(C.FUNC_SFDISCOVERY, [{ sfcategory: C.SF_CATEGORY_PLANT }]).catch(() => {});
      } else if (fn === C.FUNC_SFDISCOVERY) {
        if (result.length && result[0] && 'sf' in result[0]) this.processDiscovery(result);
      } else if (fn === C.FUNC_GETSTATUS) {
        this.processStatus(result);
      }
    } else if (type === 'request' && fn === C.FUNC_CHANGESTATUS) {
      this.processStatus(msg.args || []);
    }
  }

  static classify(sstype, sfetypes) {
    switch (sstype) {
      case 'SS_Clima_Zone': return 'thermostat';
      case 'SS_Light_Dimmer': return 'dimmer';
      case 'SS_Light_Switch': return 'light';
      case 'SS_Shutter_Position': return 'shutter';
      case 'SS_Automation_OnOff': return 'switch';
      case 'SS_Scene_Executor': return 'scene';
      case 'SS_Energy_LoadControl1P': return 'energy_manager';
      case 'SS_Energy_Load': return 'load_control';
      default: break;
    }
    if (sfetypes.includes('SFE_State_Shutter')) return 'shutter';
    if (sfetypes.includes('SFE_State_Brightness') && sfetypes.includes('SFE_State_OnOff')) return 'dimmer';
    if (sfetypes.includes('SFE_State_OnOff')) return 'light';
    if (sfetypes.includes(C.SFE_STATE_AMBIENT_TEMPERATURE)) return 'thermostat';
    return 'unknown';
  }

  processDiscovery(result) {
    const sfList = [];
    for (const item of result) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.sf)) {
        for (const sf of item.sf) if (sf && typeof sf === 'object') sfList.push(Object.assign({ _ambient: item.name || item.idambient }, sf));
      } else if ('idsf' in item) {
        sfList.push(item);
      }
    }

    const toRegister = [];
    for (const sf of sfList) {
      if (!Number.isInteger(sf.idsf)) continue;
      const elements = Array.isArray(sf.elements) ? sf.elements : [];
      const sfetypes = elements.filter((e) => e && typeof e.sfetype === 'string').map((e) => e.sfetype);
      const deviceType = VimarCloudClient.classify(sf.sstype || '', sfetypes);
      this.devices.set(sf.idsf, {
        idsf: sf.idsf,
        name: sf.name || `Vimar ${sf.idsf}`,
        sstype: sf.sstype || '',
        sftype: sf.sftype || '',
        sfetypes,
        deviceType,
        ambient: sf._ambient,
      });
      const st = this.states.get(sf.idsf) || {};
      for (const e of elements) if (e && e.sfetype && e.value !== undefined && e.value !== null) st[e.sfetype] = e.value;
      this.states.set(sf.idsf, st);
      const reg = sfetypes.filter((s) => s.startsWith('SFE_State_'));
      if (reg.length) toRegister.push({ idsf: sf.idsf, sfetype: reg });
    }

    if (toRegister.length) {
      const warn = (err) => this.log.warn(`Vimar: register failed: ${err.message}`);
      this.request(C.FUNC_REGISTER, toRegister).catch(warn);
      this.request(C.FUNC_GETSTATUS, toRegister).catch(warn);
    }
    this.log.info(`Vimar: discovery complete, ${this.devices.size} functions found`);
    this.emit('discovery', this.devices);
  }

  processStatus(items) {
    if (!Array.isArray(items)) return;
    const updated = [];
    for (const item of items) {
      if (!item || !Number.isInteger(item.idsf) || !Array.isArray(item.elements)) continue;
      const st = this.states.get(item.idsf) || {};
      for (const e of item.elements) {
        if (e && e.sfetype && e.value !== undefined && e.value !== null) st[e.sfetype] = e.value;
      }
      this.states.set(item.idsf, st);
      updated.push(item.idsf);
    }
    if (updated.length) this.emit('state', updated);
  }

  getState(idsf, sfetype) {
    const st = this.states.get(idsf);
    return st ? st[sfetype] : undefined;
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  set(idsf, sfetype, value) {
    return this.command([{ idsf, sfetype, value: String(value) }]);
  }

  turnOn(idsf) { return this.set(idsf, C.SFE_CMD_ONOFF, 'On'); }
  turnOff(idsf) { return this.set(idsf, C.SFE_CMD_ONOFF, 'Off'); }
  setBrightness(idsf, pct) { return this.set(idsf, C.SFE_CMD_BRIGHTNESS, Math.round(pct)); }
  setShutter(idsf, vimarPos) { return this.set(idsf, C.SFE_CMD_SHUTTER, vimarPos); }
  executeScene(idsf) { return this.set(idsf, C.SFE_CMD_EXECUTE, 'Execute'); }
  setHvacMode(idsf, mode) { return this.set(idsf, C.SFE_CMD_HVAC_MODE, mode); }
  setChangeOver(idsf, mode) { return this.set(idsf, C.SFE_CMD_CHANGE_OVER_MODE, mode); }

  /** Like the official app: a setpoint while in "Auto" switches to "Timed manual". */
  async setTemperature(idsf, temp) {
    if (this.getState(idsf, C.SFE_STATE_HVAC_MODE) === C.HVAC_AUTO) {
      await this.setHvacMode(idsf, C.HVAC_TIMED_MANUAL);
    }
    await this.set(idsf, C.SFE_CMD_AMBIENT_SETPOINT, temp);
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((err) => this.log.error(`Vimar: connection loop stopped: ${err.message}`));
  }

  async loop() {
    let delay = C.RECONNECT_MIN_MS;
    while (this.running) {
      let authFailed = false;
      try {
        const token = await this.getToken();
        await this.runSocket(token);
      } catch (err) {
        if (err instanceof VimarAuthError) {
          authFailed = true;
          this.log.error(`Vimar: authentication error: ${err.message}`);
        } else {
          this.log.error(`Vimar: connection error: ${err.message}`);
        }
      }
      if (this.sessionWasReady) delay = C.RECONNECT_MIN_MS;
      this.sessionWasReady = false;
      if (!this.running) break;
      // Auth errors: do not hammer Keycloak (account lockout); retry rarely.
      const wait = authFailed ? C.AUTH_RETRY_MS : delay;
      this.log.info(`Vimar: reconnecting in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      if (!authFailed) delay = Math.min(delay * 2, C.RECONNECT_MAX_MS);
    }
  }

  runSocket(token) {
    return new Promise((resolve) => {
      const url = `${this.endpoints.wsUrl}?duid=${encodeURIComponent(this.duid)}&access_token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url, { headers: { 'User-Agent': WS_USER_AGENT }, perMessageDeflate: true, handshakeTimeout: 15000 });
      this.ws = ws;
      this.msgid = 9;
      this.clientToken = b64url(crypto.randomBytes(12));
      this.sessionToken = null;
      let keepalive = null;
      let watchdog = null;

      const finish = (why) => {
        clearInterval(keepalive);
        clearTimeout(watchdog);
        if (this.ws === ws) {
          this.ws = null;
          this.sessionToken = null;
          this.failPending(new VimarConnectionError('WebSocket disconnected'));
          this.emit('disconnected', why);
        }
        resolve();
      };

      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.log.debug('Vimar: WebSocket open, attaching');
        watchdog = setTimeout(() => {
          if (!this.sessionToken) {
            this.log.warn('Vimar: attach timeout after 30 s; reconnecting');
            ws.terminate();
          }
        }, C.ATTACH_TIMEOUT_MS);
        keepalive = setInterval(() => {
          if (!this.sessionToken) return;
          this.request(C.FUNC_KEEPALIVE, []).catch(() => {});
        }, C.KEEPALIVE_MS);
        try { this.attach(); } catch (err) { ws.terminate(); }
      });
      ws.on('message', (data) => {
        const before = this.sessionToken;
        this.handleMessage(data.toString());
        if (!before && this.sessionToken) {
          this.sessionWasReady = true;
          this.emit('connected');
        }
      });
      ws.on('unexpected-response', (req, res) => {
        this.log.error(`Vimar: WebSocket rejected (HTTP ${res.statusCode})`);
        if (res.statusCode === 401 || res.statusCode === 403) (this.authOwner || this).accessToken = null;
        ws.terminate();
      });
      ws.on('error', (err) => this.log.warn(`Vimar: WebSocket error: ${err.message}`));
      ws.on('close', (code, reason) => {
        const why = reason && reason.length ? `${code}: ${reason.toString()}` : `${code}`;
        if (!this.sessionToken) {
          this.log.warn(`Vimar: closed before attach (${why}, socket ${opened ? 'opened' : 'never opened'}, duid ${this.duid})`);
          if (code === 1013) {
            this.log.warn('Vimar: 1013 = "try again later": the cloud cannot find an online device with this DUID '
              + '(wrong DUID, e.g. the plant UID, or the device/gateway is not connected to the cloud).');
          }
        }
        finish(`closed (${why})`);
      });
    });
  }

  async stop() {
    this.running = false;
    if (this.ws) {
      this.request(C.FUNC_DETACH, [{ user: 'logout' }]).catch(() => {});
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionToken);
  }
}

module.exports = { VimarCloudClient, VimarAuthError, VimarConnectionError };
