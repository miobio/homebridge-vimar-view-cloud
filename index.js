'use strict';

const { PLATFORM_NAME } = require('./lib/constants');
const { VimarViewCloudPlatform } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, VimarViewCloudPlatform);
};
