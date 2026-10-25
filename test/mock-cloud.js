'use strict';

/* Mock Keycloak + Vimar WebSocket server used by the tests (no real cloud). */
const http = require('http');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const C = require('../lib/constants');

const jwt = (sub) => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`;

function startMockCloud() {
  const received = [];
  let sockets = [];
  let httpLog = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    httpLog.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/auth' && req.method === 'GET') {
      res.writeHead(302, { Location: '/login?session=1', 'Set-Cookie': 'AUTH_SESSION_ID=abc; Path=/' });
      return res.end();
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      assert.match(req.headers.cookie || '', /AUTH_SESSION_ID=abc/);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<form><input type="hidden" id="hash" name="hash" value="CSRF123"></form>');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('passw') !== 'secret' || p.get('hash') !== 'CSRF123') {
          res.writeHead(200);
          return res.end('bad');
        }
        res.writeHead(302, { Location: '/step2' });
        return res.end();
      });
      return undefined;
    }
    if (url.pathname === '/step2') {
      res.writeHead(302, { Location: `${C.VIMAR_REDIRECT_URI}?code=CODE42&state=x` });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (p.get('grant_type') === 'authorization_code') {
          assert.strictEqual(p.get('code'), 'CODE42');
          assert.ok(p.get('code_verifier'));
        }
        res.end(JSON.stringify({ access_token: jwt('user-uid-1'), refresh_token: 'REFRESH-1', expires_in: 300 }));
      });
      return undefined;
    }
    res.writeHead(404);
    return res.end();
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    assert.strictEqual(q.get('duid'), '000000AAA00000');
    sockets.push(ws);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      received.push(m);
      const reply = (result) => ws.send(JSON.stringify({ type: 'response', function: m.function, msgid: m.msgid, error: 0, result }));
      if (m.function === 'attach') {
        assert.strictEqual(m.args[0].credential.useruid, 'user-uid-1');
        reply([{ token: 'SESSION', plantname: 'Casa Folgaria', serverinfo: { softwareversion: '1.2.3', mac: 'aa' } }]);
      } else if (m.function === 'sfdiscovery') {
        reply([{
          idambient: 1,
          name: 'Soggiorno',
          sf: [
            {
              idsf: 101, name: 'Termostato', sstype: 'SS_Clima_Zone',
              elements: [
                { sfetype: 'SFE_State_AmbientTemperature', value: '18.4' },
                { sfetype: 'SFE_State_AmbientSetpoint', value: '20.0' },
                { sfetype: 'SFE_State_HVACMode', value: 'Auto' },
                { sfetype: 'SFE_State_ChangeOverMode', value: 'Heating' },
                { sfetype: 'SFE_State_OutStatus', value: 'Heat' },
                { sfetype: 'SFE_Cmd_AmbientSetpoint' },
              ],
            },
            { idsf: 102, name: 'Luce tavolo', sstype: 'SS_Light_Dimmer', elements: [{ sfetype: 'SFE_State_OnOff', value: 'Off' }, { sfetype: 'SFE_State_Brightness', value: '40' }] },
            { idsf: 103, name: 'Tapparella / sud', sstype: 'SS_Shutter_Position', elements: [{ sfetype: 'SFE_State_Shutter', value: '100' }] },
            { idsf: 104, name: 'Energia', sstype: 'SS_Energy_Measure1P', elements: [] },
          ],
        }]);
      } else if (m.function === 'getstatus' || m.function === 'register' || m.function === 'keepalive') {
        reply([]);
      } else if (m.function === 'doaction') {
        assert.strictEqual(m.token, 'SESSION');
        reply([]);
        // Echo the state change back like the gateway does
        const map = {
          SFE_Cmd_AmbientSetpoint: 'SFE_State_AmbientSetpoint',
          SFE_Cmd_HVACMode: 'SFE_State_HVACMode',
          SFE_Cmd_OnOff: 'SFE_State_OnOff',
          SFE_Cmd_Brightness: 'SFE_State_Brightness',
          SFE_Cmd_Shutter: 'SFE_State_Shutter',
        };
        const a = m.args[0];
        ws.send(JSON.stringify({
          type: 'request', function: 'changestatus', msgid: '900',
          args: [{ idsf: a.idsf, elements: [{ sfetype: map[a.sfetype], value: a.value }] }],
        }));
      }
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      port, received, httpLog, server, wss,
      dropAll: () => { sockets.forEach((s) => s.terminate()); sockets = []; },
      push: (args) => sockets.forEach((s) => s.send(JSON.stringify({ type: 'request', function: 'changestatus', msgid: '901', args }))),
      close: () => new Promise((r) => { wss.close(); server.close(r); }),
    });
  }));
}

module.exports = { startMockCloud };

if (require.main === module) {
  startMockCloud().then((c) => console.log(`mock cloud on http://127.0.0.1:${c.port}`));
}
