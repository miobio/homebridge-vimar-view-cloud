# homebridge-vimar-view-cloud

Plugin **non ufficiale** per [Homebridge](https://homebridge.io) che porta in HomeKit i dispositivi **Vimar View** passando dal cloud Vimar, lo stesso usato dall'app ufficiale *View*.

È un port in Node.js del protocollo ricostruito dall'integrazione Home Assistant [ha-vimar-view](https://github.com/ivhazu/ha-vimar-view) (MIT, © Andrea Baronchelli).

> ⚠️ Non affiliato a Vimar S.p.A. Il protocollo è stato ottenuto per reverse engineering: un aggiornamento del cloud o dell'app Vimar può romperlo senza preavviso. Serve una connessione internet: senza cloud, niente controllo da HomeKit.

## Dispositivi

| Funzione Vimar (`sstype`) | In HomeKit | Note |
|---|---|---|
| `SS_Clima_Zone` (termostato Wi-Fi **02912**, zone clima) | Termostato + interruttore "Programma" | temperatura, setpoint, Off/Riscalda (/Raffredda), stato caldaia |
| `SS_Light_Switch` | Lampadina | on/off |
| `SS_Light_Dimmer` | Lampadina dimmerabile | on/off, luminosità |
| `SS_Shutter_Position` | Tapparella | posizione, stop |
| `SS_Automation_OnOff` | Interruttore | on/off |
| `SS_Scene_Executor` | Interruttore a impulso | disattivato di default |

### Come si comporta il termostato

- **Off / Riscalda** dall'app Casa: Off spegne il termostato. Riscalda lo riaccende in modalità *Auto*, cioè segue il programma settimanale (configurabile con `onMode`). Se il termostato è già acceso in manuale, ricevere di nuovo "Riscalda" non lo rimette in Auto.
- **Cambio temperatura**: come nell'app ufficiale, se il termostato è in *Auto* passa a *Manuale temporaneo* ("Timed manual") e poi applica il setpoint.
- **Interruttore "Programma"**: acceso = segue il programma (Auto), spento = manuale permanente.
- **Stato attuale**: "Riscalda" quando il relè è attivo (`OutStatus = Heat`), altrimenti "Spento" (inattivo).

## Installazione

```bash
sudo npm install -g homebridge-vimar-view-cloud
```

Oppure da sorgente: copia la cartella sul server Homebridge, poi `npm install` e `npm link`. Richiede Node.js 18.20 o superiore e Homebridge 1.8 o 2.x.

## Configurazione

```json
{
  "platform": "VimarViewCloud",
  "name": "Vimar View",
  "username": "tua@email.it",
  "password": "password MyVimar",
  "duid": "000000AAA00000",
  "onMode": "Auto",
  "scheduleSwitch": true,
  "enableCooling": false,
  "minTemperature": 5,
  "maxTemperature": 35,
  "deviceTypes": ["thermostat", "light", "dimmer", "shutter", "switch"],
  "exclude": [],
  "debug": false
}
```

| Chiave | Default | Descrizione |
|---|---|---|
| `username`, `password` | — | credenziali **MyVimar**, le stesse dell'app View |
| `duid` | — | identificativo del gateway o dispositivo (vedi sotto) |
| `onMode` | `Auto` | modalità usata quando accendi il termostato da HomeKit: `Auto` (programma) o `Manual` |
| `scheduleSwitch` | `true` | aggiunge l'interruttore "Programma" |
| `enableCooling` | `false` | mostra la modalità Raffredda |
| `minTemperature` / `maxTemperature` | 5 / 35 | limiti del setpoint in Casa |
| `deviceTypes` | tutti tranne `scene` | tipi da esporre |
| `exclude` | `[]` | nomi o `idsf` da ignorare |
| `debug` | `false` | elenca nel log tutte le funzioni trovate; con Homebridge in debug (`-D`) mostra anche il traffico WebSocket |

### Dove trovo il DUID

App **View** → **Impostazioni** → **Info di sistema**: il DUID del gateway è la voce **BLEG** (formato `000000AAA00000`).

Per un termostato 02912 **senza gateway** non è documentato quale identificativo usare. Prova con l'ID che l'app mostra per il termostato in *Info di sistema* o nella scheda del dispositivo. Se l'attach viene rifiutato, il log lo segnala esplicitamente: in quel caso l'unico modo certo è leggere il `duid` nell'URL WebSocket dell'app (`wss://prod.vimar.cloud/wssmqtt/deviceproxy?duid=…`) con un proxy come mitmproxy.

## Note tecniche

- **Autenticazione**: OAuth2 Authorization Code + PKCE sul Keycloak `prod.vimar.cloud` (client `mobile-user-view2`). Il refresh token viene salvato in `<storage Homebridge>/.vimar-view-cloud-<DUID>.json` (permessi 600), così ai riavvii non serve rifare il login completo.
- **Connessione**: WebSocket persistente in push (`changestatus`), keepalive ogni 25 s, riconnessione con backoff da 5 a 60 s. In caso di errore di **autenticazione** riprova ogni 10 minuti, per non far bloccare l'account.
- **Disponibilità**: durante brevi disconnessioni Casa mostra l'ultimo stato noto. Dopo 3 minuti di cloud irraggiungibile gli accessori risultano "Nessuna risposta".
- **Cache accessori**: se una discovery torna vuota (cloud in difficoltà) gli accessori **non** vengono rimossi, per non perdere le tue automazioni HomeKit.

## Test

```bash
npm install
npm test
```

I test usano un finto Keycloak e un finto server WebSocket Vimar, senza accesso al cloud reale. Coprono login, attach, discovery, push di stato, comandi del termostato, dimmer, tapparelle e riconnessione.

## Licenza

MIT. Vedi `LICENSE`, che mantiene l'attribuzione al progetto originale.
