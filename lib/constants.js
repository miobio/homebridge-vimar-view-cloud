'use strict';

const HOST = 'prod.vimar.cloud';

module.exports = {
  PLATFORM_NAME: 'VimarViewCloud',
  PLUGIN_NAME: 'homebridge-vimar-view-cloud',

  // Cloud endpoints
  VIMAR_OAUTH_AUTH_URL: `https://${HOST}/auth/realms/vimaruser/protocol/openid-connect/auth`,
  VIMAR_TOKEN_URL: `https://${HOST}/auth/realms/vimaruser/protocol/openid-connect/token`,
  VIMAR_WS_URL: `wss://${HOST}/wssmqtt/deviceproxy`,
  VIMAR_CLIENT_ID: 'mobile-user-view2',
  VIMAR_REDIRECT_URI: 'com.prova.app:/oauth2redirect/example-provide',

  // Timings
  TOKEN_REFRESH_MARGIN: 60, // s
  HTTP_TIMEOUT_MS: 30000,
  KEEPALIVE_MS: 25000,
  ATTACH_TIMEOUT_MS: 30000,
  RECONNECT_MIN_MS: 5000,
  RECONNECT_MAX_MS: 60000,
  AUTH_RETRY_MS: 10 * 60 * 1000,

  // Protocol functions
  FUNC_ATTACH: 'attach',
  FUNC_DETACH: 'detach',
  FUNC_REGISTER: 'register',
  FUNC_GETSTATUS: 'getstatus',
  FUNC_DOACTION: 'doaction',
  FUNC_CHANGESTATUS: 'changestatus',
  FUNC_SFDISCOVERY: 'sfdiscovery',
  FUNC_KEEPALIVE: 'keepalive',
  SF_CATEGORY_PLANT: 'Plant',

  // Lights
  SFE_STATE_ONOFF: 'SFE_State_OnOff',
  SFE_STATE_BRIGHTNESS: 'SFE_State_Brightness',
  SFE_CMD_ONOFF: 'SFE_Cmd_OnOff',
  SFE_CMD_BRIGHTNESS: 'SFE_Cmd_Brightness',

  // Shutters (Vimar: 0 = open, 100 = closed; "Change to N" while moving)
  SFE_STATE_SHUTTER: 'SFE_State_Shutter',
  SFE_CMD_SHUTTER: 'SFE_Cmd_Shutter',
  SHUTTER_STOP: 'Stop',

  // Scenes
  SFE_CMD_EXECUTE: 'SFE_Cmd_Execute',

  // Climate
  SFE_STATE_AMBIENT_TEMPERATURE: 'SFE_State_AmbientTemperature',
  SFE_STATE_AMBIENT_SETPOINT: 'SFE_State_AmbientSetpoint',
  SFE_STATE_HVAC_MODE: 'SFE_State_HVACMode',
  SFE_STATE_CHANGE_OVER_MODE: 'SFE_State_ChangeOverMode',
  SFE_STATE_OUT_STATUS: 'SFE_State_OutStatus',
  SFE_CMD_HVAC_MODE: 'SFE_Cmd_HVACMode',
  SFE_CMD_AMBIENT_SETPOINT: 'SFE_Cmd_AmbientSetpoint',
  SFE_CMD_CHANGE_OVER_MODE: 'SFE_Cmd_ChangeOverMode',

  HVAC_OFF: 'Off',
  HVAC_AUTO: 'Auto', // follows the weekly program
  HVAC_TIMED_MANUAL: 'Timed manual', // temporary override
  HVAC_MANUAL: 'Manual', // permanent manual
  CHANGE_OVER_HEATING: 'Heating',
  CHANGE_OVER_COOLING: 'Cooling',
  OUT_HEAT: 'Heat',
  OUT_COOL: 'Cool',
};
