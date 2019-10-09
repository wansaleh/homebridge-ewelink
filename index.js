/* eslint-disable no-plusplus */
/* eslint-disable no-shadow */
/* eslint-disable no-prototype-builtins */
/* eslint-disable no-console */
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const querystring = require('querystring');
const request = require('request-json');
const nonce = require('nonce')();

const isSocketOpen = false;
const sequence = 0;
const webClient = '';
let apiKey = 'UNCONFIGURED';
const authenticationToken = 'UNCONFIGURED';
let Accessory;
let Service;
let Characteristic;
let UUIDGen;

module.exports = function(homebridge) {
  console.log(`homebridge API version: ${homebridge.version}`);

  // Accessory must be created from PlatformAccessory Constructor
  Accessory = homebridge.platformAccessory;

  // Service and Characteristic are from hap-nodejs
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  // For platform plugin to be considered as dynamic platform plugin,
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform(
    'homebridge-eWeLink',
    'eWeLink',
    eWeLink,
    true
  );
};

// Platform constructor
function eWeLink(log, config, api) {
  log(JSON.stringify(config, null, ' '));

  if (
    !config ||
    (!config.authenticationToken &&
      ((!config.phoneNumber && !config.email) ||
        !config.password ||
        !config.imei))
  ) {
    log('Initialization skipped. Missing configuration data.');
    return;
  }

  if (!config.apiHost) {
    config.apiHost = 'us-api.coolkit.cc:8080';
  }
  if (!config.webSocketApi) {
    config.webSocketApi = 'us-pconnect3.coolkit.cc';
  }

  log('Intialising eWeLink');

  const platform = this;

  this.log = log;
  this.config = config;
  this.accessories = new Map();
  this.authenticationToken = config.authenticationToken;
  this.devicesFromApi = new Map();

  if (api) {
    // Save the API object as plugin needs to register new accessory via this object
    this.api = api;

    // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
    // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
    // Or start discover new accessories.

    this.api.on('didFinishLaunching', () => {
      platform.log(
        'A total of [%s] accessories were loaded from the local cache',
        platform.accessories.size
      );

      this.login(() => {
        // Get a list of all devices from the API, and compare it to the list of cached devices.
        // New devices will be added, and devices that exist in the cache but not in the web list
        // will be removed from Homebridge.

        const url = `https://${this.config.apiHost}`;

        platform.log(
          'Requesting a list of devices from eWeLink HTTPS API at [%s]',
          url
        );

        this.webClient = request.createClient(url);

        this.webClient.headers.Authorization = `Bearer ${this.authenticationToken}`;
        this.webClient.get(
          `/api/user/device?${this.getArguments()}`,
          (err, res, body) => {
            if (err) {
              platform.log(
                'An error was encountered while requesting a list of devices. Error was [%s]',
                err
              );
              return;
            }
            if (!body) {
              platform.log(
                'An error was encountered while requesting a list of devices. No data in response.'
              );
              return;
            }
            if (body.hasOwnProperty('error') && body.error !== 0) {
              const response = JSON.stringify(body);
              platform.log(
                'An error was encountered while requesting a list of devices. Response was [%s]',
                response
              );
              if (body.error === '401') {
                platform.log(
                  'Verify that you have the correct authenticationToken specified in your configuration. The currently-configured token is [%s]',
                  platform.authenticationToken
                );
              }
              return;
            }

            body = body.devicelist;

            const size = Object.keys(body).length;
            platform.log(
              'eWeLink HTTPS API reports that there are a total of [%s] devices registered',
              size
            );

            if (size === 0) {
              platform.log(
                "As there were no devices were found, all devices have been removed from the platorm's cache. Please regiester your devices using the eWeLink app and restart HomeBridge"
              );
              platform.accessories.clear();
              platform.api.unregisterPlatformAccessories(
                'homebridge-eWeLink',
                'eWeLink',
                platform.accessories
              );
              return;
            }

            const newDevicesToAdd = new Map();

            body.forEach(device => {
              platform.apiKey = device.apikey;
              platform.devicesFromApi.set(device.deviceid, device);
            });

            // Now we compare the cached devices against the web list
            platform.log(
              'Evaluating if devices need to be removed...'
            );

            function checkIfDeviceIsStillRegistered(
              value,
              deviceId,
              map
            ) {
              const accessory = platform.accessories.get(deviceId);

              if (accessory.context.switches > 1) {
                deviceId = deviceId.replace(
                  `CH${accessory.context.channel}`,
                  ''
                );
              }

              if (
                platform.devicesFromApi.has(deviceId) &&
                (accessory.context.switches <= 1 ||
                  accessory.context.channel <=
                    accessory.context.switches)
              ) {
                platform.log(
                  'Device [%s] is regeistered with API. Nothing to do.',
                  accessory.displayName
                );
              } else {
                platform.log(
                  'Device [%s], ID : [%s] was not present in the response from the API. It will be removed.',
                  accessory.displayName,
                  accessory.UUID
                );
                platform.removeAccessory(accessory);
              }
            }

            // If we have devices in our cache, check that they exist in the web response
            if (platform.accessories.size > 0) {
              platform.log(
                'Verifying that all cached devices are still registered with the API. Devices that are no longer registered with the API will be removed.'
              );
              platform.accessories.forEach(
                checkIfDeviceIsStillRegistered
              );
            }

            platform.log(
              'Evaluating if new devices need to be added...'
            );

            // Now we compare the cached devices against the web list
            function checkIfDeviceIsAlreadyConfigured(
              value,
              deviceId,
              map
            ) {
              if (platform.accessories.has(deviceId)) {
                platform.log(
                  'Device with ID [%s] is already configured. Ensuring that the configuration is current.',
                  deviceId
                );

                const accessory = platform.accessories.get(deviceId);
                const deviceInformationFromWebApi = platform.devicesFromApi.get(
                  deviceId
                );
                const switchesAmount = platform.getDeviceChannelCount(
                  deviceInformationFromWebApi
                );

                accessory
                  .getService(Service.AccessoryInformation)
                  .setCharacteristic(
                    Characteristic.SerialNumber,
                    deviceInformationFromWebApi.extra.extra.mac
                  );
                accessory
                  .getService(Service.AccessoryInformation)
                  .setCharacteristic(
                    Characteristic.Manufacturer,
                    deviceInformationFromWebApi.productModel
                  );
                accessory
                  .getService(Service.AccessoryInformation)
                  .setCharacteristic(
                    Characteristic.Model,
                    `${deviceInformationFromWebApi.extra.extra.model} (${deviceInformationFromWebApi.uiid})`
                  );
                accessory
                  .getService(Service.AccessoryInformation)
                  .setCharacteristic(
                    Characteristic.FirmwareRevision,
                    deviceInformationFromWebApi.params.fwVersion
                  );

                if (switchesAmount > 1) {
                  platform.log(
                    `${switchesAmount} channels device has been set: ${deviceInformationFromWebApi.extra.extra.model} uiid: ${deviceInformationFromWebApi.uiid}`
                  );
                  for (let i = 0; i !== switchesAmount; i++) {
                    accessory
                      .getService(Service.AccessoryInformation)
                      .setCharacteristic(
                        Characteristic.Name,
                        `${deviceInformationFromWebApi.name} CH ${i +
                          1}`
                      );
                    platform.updatePowerStateCharacteristic(
                      `${deviceId}CH${i + 1}`,
                      deviceInformationFromWebApi.params.switches[i]
                        .switch,
                      platform.devicesFromApi.get(deviceId)
                    );
                  }
                } else {
                  platform.log(
                    `Single channel device has been set: ${deviceInformationFromWebApi.extra.extra.model} uiid: ${deviceInformationFromWebApi.uiid}`
                  );
                  accessory
                    .getService(Service.AccessoryInformation)
                    .setCharacteristic(
                      Characteristic.Name,
                      deviceInformationFromWebApi.name
                    );
                  platform.updatePowerStateCharacteristic(
                    deviceId,
                    deviceInformationFromWebApi.params.switch
                  );
                }

                if (
                  deviceInformationFromWebApi.extra.extra.model ===
                  'PSA-BHA-GL'
                ) {
                  platform.log(
                    `Thermostat device has been set: ${deviceInformationFromWebApi.extra.extra.model}`
                  );
                  platform.updateCurrentTemperatureCharacteristic(
                    deviceId,
                    deviceInformationFromWebApi.params
                  );
                }
              } else {
                const deviceToAdd = platform.devicesFromApi.get(
                  deviceId
                );
                const switchesAmount = platform.getDeviceChannelCount(
                  deviceToAdd
                );

                const services = {};
                services.switch = true;

                if (deviceToAdd.extra.extra.model === 'PSA-BHA-GL') {
                  services.thermostat = true;
                  services.temperature = true;
                  services.humidity = true;
                } else {
                  services.switch = true;
                }
                if (switchesAmount > 1) {
                  for (let i = 0; i !== switchesAmount; i++) {
                    platform.log(
                      'Device [%s], ID : [%s] will be added',
                      deviceToAdd.name,
                      `${deviceId}CH${i + 1}`
                    );
                    platform.addAccessory(
                      deviceToAdd,
                      `${deviceId}CH${i + 1}`,
                      services
                    );
                  }
                } else {
                  platform.log(
                    'Device [%s], ID : [%s] will be added',
                    deviceToAdd.name,
                    deviceToAdd.deviceid
                  );
                  platform.addAccessory(deviceToAdd, null, services);
                }
              }
            }

            // Go through the web response to make sure that all the devices that are in the response do exist in the accessories map
            if (platform.devicesFromApi.size > 0) {
              platform.devicesFromApi.forEach(
                checkIfDeviceIsAlreadyConfigured
              );
            }

            platform.log(
              'API key retrieved from web service is [%s]',
              platform.apiKey
            );

            apiKey = platform.apiKey;

            // We have our devices, now open a connection to the WebSocket API

            const url = `wss://${platform.config.webSocketApi}:8080/api/ws`;

            platform.log(
              'Connecting to the WebSocket API at [%s]',
              url
            );

            platform.wsc = new WebSocketClient();

            platform.wsc.open(url);

            platform.wsc.onmessage = function(message) {
              // Heartbeat response can be safely ignored
              if (message == 'pong') {
                return;
              }

              platform.log('WebSocket messge received: ', message);

              let json;
              try {
                json = JSON.parse(message);
              } catch (e) {
                return;
              }

              if (json.hasOwnProperty('action')) {
                if (json.action === 'update') {
                  // platform.log("Update message received for device [%s]", json.deviceid);

                  if (
                    json.hasOwnProperty('params') &&
                    json.params.hasOwnProperty('switch')
                  ) {
                    platform.updatePowerStateCharacteristic(
                      json.deviceid,
                      json.params.switch
                    );
                  } else if (
                    json.hasOwnProperty('params') &&
                    json.params.hasOwnProperty('switches') &&
                    Array.isArray(json.params.switches)
                  ) {
                    json.params.switches.forEach(entry => {
                      if (
                        entry.hasOwnProperty('outlet') &&
                        entry.hasOwnProperty('switch')
                      ) {
                        platform.updatePowerStateCharacteristic(
                          `${json.deviceid}CH${entry.outlet + 1}`,
                          entry.switch,
                          platform.devicesFromApi.get(json.deviceid)
                        );
                      }
                    });
                  }

                  if (
                    json.hasOwnProperty('params') &&
                    (json.params.hasOwnProperty(
                      'currentTemperature'
                    ) ||
                      json.params.hasOwnProperty('currentHumidity'))
                  ) {
                    platform.updateCurrentTemperatureCharacteristic(
                      json.deviceid,
                      json.params
                    );
                  }
                }
              } else if (
                json.hasOwnProperty('config') &&
                json.config.hb &&
                json.config.hbInterval
              ) {
                if (!platform.hbInterval) {
                  platform.hbInterval = setInterval(() => {
                    platform.wsc.send('ping');
                  }, json.config.hbInterval * 1000);
                }
              }
            };

            platform.wsc.onopen = function(e) {
              platform.isSocketOpen = true;

              // We need to authenticate upon opening the connection

              const timestamp = new Date() / 1000;
              const ts = Math.floor(timestamp);

              // Here's the eWeLink payload as discovered via Charles
              const payload = {};
              payload.action = 'userOnline';
              payload.userAgent = 'app';
              payload.version = 6;
              payload.nonce = `${nonce()}`;
              payload.apkVersion = '1.8';
              payload.os = 'ios';
              payload.at = config.authenticationToken;
              payload.apikey = platform.apiKey;
              payload.ts = `${ts}`;
              payload.model = 'iPhone10,6';
              payload.romVersion = '11.1.2';
              payload.sequence = platform.getSequence();

              const string = JSON.stringify(payload);

              platform.log('Sending login request [%s]', string);

              platform.wsc.send(string);
            };

            platform.wsc.onclose = function(e) {
              platform.log('WebSocket was closed. Reason [%s]', e);
              platform.isSocketOpen = false;
              if (platform.hbInterval) {
                clearInterval(platform.hbInterval);
                platform.hbInterval = null;
              }
            };
          }
        ); // End WebSocket
      }); // End login
    });
  }
}

// Function invoked when homebridge tries to restore cached accessory.
// We update the existing devices as part of didFinishLaunching(), as to avoid an additional call to the the HTTPS API.
eWeLink.prototype.configureAccessory = function(accessory) {
  this.log(accessory.displayName, 'Configure Accessory');

  const platform = this;

  if (accessory.getService(Service.Switch)) {
    accessory
      .getService(Service.Switch)
      .getCharacteristic(Characteristic.On)
      .on('set', (value, callback) => {
        platform.setPowerState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getPowerState(accessory, callback);
      });
  }
  if (accessory.getService(Service.Thermostat)) {
    const service = accessory.getService(Service.Thermostat);

    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('set', (value, callback) => {
        platform.setTemperatureState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentTemperature(accessory, callback);
      });
    service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('set', (value, callback) => {
        platform.setHumidityState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentHumidity(accessory, callback);
      });
  }
  if (accessory.getService(Service.TemperatureSensor)) {
    accessory
      .getService(Service.TemperatureSensor)
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('set', (value, callback) => {
        platform.setTemperatureState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentTemperature(accessory, callback);
      });
  }
  if (accessory.getService(Service.HumiditySensor)) {
    accessory
      .getService(Service.HumiditySensor)
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('set', (value, callback) => {
        platform.setHumidityState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentHumidity(accessory, callback);
      });
  }

  this.accessories.set(accessory.context.deviceId, accessory);
};

// Sample function to show how developer can add accessory dynamically from outside event
eWeLink.prototype.addAccessory = function(
  device,
  deviceId = null,
  services = { switch: true }
) {
  // Here we need to check if it is currently there
  if (this.accessories.get(deviceId || device.deviceid)) {
    this.log(
      'Not adding [%s] as it already exists in the cache',
      deviceId || device.deviceid
    );
    return;
  }

  const platform = this;
  let channel = 0;

  if (device.type !== 10) {
    this.log(
      'A device with an unknown type was returned. It will be skipped.',
      device.type
    );
    return;
  }

  if (deviceId) {
    const id = deviceId.split('CH');
    channel = id[1];
  }

  try {
    const status =
      channel &&
      device.params.switches &&
      device.params.switches[channel - 1]
        ? device.params.switches[channel - 1].switch
        : device.params.switch || 'off';
    this.log(
      'Found Accessory with Name : [%s], Manufacturer : [%s], Status : [%s], Is Online : [%s], API Key: [%s] ',
      device.name + (channel ? ` CH ${channel}` : ''),
      device.productModel,
      status,
      device.online,
      device.apikey
    );
  } catch (e) {
    this.log(
      'Problem accessory Accessory with Name : [%s], Manufacturer : [%s], Error : [%s], Is Online : [%s], API Key: [%s] ',
      device.name + (channel ? ` CH ${channel}` : ''),
      device.productModel,
      e,
      device.online,
      device.apikey
    );
  }

  const switchesCount = this.getDeviceChannelCount(device);
  if (channel > switchesCount) {
    this.log(
      "Can't add [%s], because device [%s] has only [%s] switches.",
      device.name + (channel ? ` CH ${channel}` : ''),
      device.productModel,
      switchesCount
    );
    return;
  }

  const accessory = new Accessory(
    device.name + (channel ? ` CH ${channel}` : ''),
    UUIDGen.generate((deviceId || device.deviceid).toString())
  );

  accessory.context.deviceId = deviceId || device.deviceid;
  accessory.context.apiKey = device.apikey;
  accessory.context.switches = 1;
  accessory.context.channel = channel;

  accessory.reachable = device.online === 'true';

  if (services.switch) {
    accessory
      .addService(
        Service.Switch,
        device.name + (channel ? ` CH ${channel}` : '')
      )
      .getCharacteristic(Characteristic.On)
      .on('set', (value, callback) => {
        platform.setPowerState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getPowerState(accessory, callback);
      });
  }
  if (services.thermostat) {
    const service = accessory.addService(
      Service.Thermostat,
      device.name + (channel ? ` CH ${channel}` : '')
    );

    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('set', (value, callback) => {
        platform.setTemperatureState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentTemperature(accessory, callback);
      });
    service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('set', (value, callback) => {
        platform.setHumidityState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentHumidity(accessory, callback);
      });
  }
  if (services.temperature) {
    accessory
      .addService(
        Service.TemperatureSensor,
        device.name + (channel ? ` CH ${channel}` : '')
      )
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('set', (value, callback) => {
        platform.setTemperatureState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentTemperature(accessory, callback);
      });
  }

  if (services.humidity) {
    accessory
      .addService(
        Service.HumiditySensor,
        device.name + (channel ? ` CH ${channel}` : '')
      )
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('set', (value, callback) => {
        platform.setHumidityState(accessory, value, callback);
      })
      .on('get', callback => {
        platform.getCurrentHumidity(accessory, callback);
      });
  }

  accessory.on('identify', (paired, callback) => {
    platform.log(accessory.displayName, 'Identify not supported');
    callback();
  });

  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(
      Characteristic.SerialNumber,
      device.extra.extra.mac
    );
  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(
      Characteristic.Manufacturer,
      device.productModel
    );
  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(
      Characteristic.Model,
      device.extra.extra.model
    );
  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Identify, false);
  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(
      Characteristic.FirmwareRevision,
      device.params.fwVersion
    );

  const switchesAmount = platform.getDeviceChannelCount(device);
  if (switchesAmount > 1) {
    accessory.context.switches = switchesAmount;
  }

  this.accessories.set(device.deviceid, accessory);

  this.api.registerPlatformAccessories(
    'homebridge-eWeLink',
    'eWeLink',
    [accessory]
  );
};

eWeLink.prototype.getSequence = function() {
  const time_stamp = new Date() / 1000;
  this.sequence = Math.floor(time_stamp * 1000);
  return this.sequence;
};

eWeLink.prototype.updatePowerStateCharacteristic = function(
  deviceId,
  state,
  device = null,
  channel = null
) {
  // Used when we receive an update from an external source

  const platform = this;

  let isOn = false;

  let accessory = platform.accessories.get(deviceId);

  if (typeof accessory === 'undefined' && device) {
    platform.log('Adding accessory for deviceId [%s].', deviceId);
    platform.addAccessory(device, deviceId);
    accessory = platform.accessories.get(deviceId);
  }

  if (!accessory) {
    platform.log(
      'Error updating non-exist accessory with deviceId [%s].',
      deviceId
    );
    return;
  }

  if (state === 'on') {
    isOn = true;
  }

  platform.log(
    'Updating recorded Characteristic.On for [%s] to [%s]. No request will be sent to the device.',
    accessory.displayName,
    isOn
  );

  accessory
    .getService(Service.Switch)
    .setCharacteristic(Characteristic.On, isOn);
};

eWeLink.prototype.updateCurrentTemperatureCharacteristic = function(
  deviceId,
  state,
  device = null,
  channel = null
) {
  // Used when we receive an update from an external source

  const platform = this;

  let accessory = platform.accessories.get(deviceId);
  // platform.log("deviceID:", deviceId);

  if (typeof accessory === 'undefined' && device) {
    platform.addAccessory(device, deviceId);
    accessory = platform.accessories.get(deviceId);
  }

  // platform.log(JSON.stringify(device,null,2));

  const { currentTemperature } = state;
  const { currentHumidity } = state;

  platform.log(
    'Updating recorded Characteristic.CurrentTemperature for [%s] to [%s]. No request will be sent to the device.',
    accessory.displayName,
    currentTemperature
  );
  platform.log(
    'Updating recorded Characteristic.CurrentRelativeHuniditgy for [%s] to [%s]. No request will be sent to the device.',
    accessory.displayName,
    currentHumidity
  );

  if (accessory.getService(Service.Thermostat)) {
    accessory
      .getService(Service.Thermostat)
      .setCharacteristic(
        Characteristic.CurrentTemperature,
        currentTemperature
      );
    accessory
      .getService(Service.Thermostat)
      .setCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        currentHumidity
      );
  }
  if (accessory.getService(Service.TemperatureSensor)) {
    accessory
      .getService(Service.TemperatureSensor)
      .setCharacteristic(
        Characteristic.CurrentTemperature,
        currentTemperature
      );
  }
  if (accessory.getService(Service.HumiditySensor)) {
    accessory
      .getService(Service.HumiditySensor)
      .setCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        currentHumidity
      );
  }
};

eWeLink.prototype.getPowerState = function(accessory, callback) {
  const platform = this;

  if (!this.webClient) {
    callback(
      'this.webClient not yet ready while obtaining power status for your device'
    );
    accessory.reachable = false;
    return;
  }

  platform.log(
    'Requesting power state for [%s]',
    accessory.displayName
  );

  this.webClient.get(
    `/api/user/device?${this.getArguments()}`,
    (err, res, body) => {
      if (err) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating power status. Error was [%s]',
          err
        );
        return;
      }
      if (!body) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating power status. No data in response.',
          err
        );
        return;
      }
      if (body.hasOwnProperty('error') && body.error !== 0) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]',
          JSON.stringify(body)
        );
        if ([401, 402].indexOf(parseInt(body.error, 10)) !== -1) {
          platform.relogin();
        }
        callback(
          'An error was encountered while requesting a list of devices to interrogate power status for your device'
        );
        return;
      }

      body = body.devicelist;

      const size = Object.keys(body).length;

      if (body.length < 1) {
        callback(
          'An error was encountered while requesting a list of devices to interrogate power status for your device'
        );
        accessory.reachable = false;
        return;
      }

      let { deviceId } = accessory.context;

      if (accessory.context.switches > 1) {
        deviceId = deviceId.replace(
          `CH${accessory.context.channel}`,
          ''
        );
      }

      const filteredResponse = body.filter(
        device => device.deviceid === deviceId
      );

      if (filteredResponse.length === 1) {
        const device = filteredResponse[0];

        if (device.deviceid === deviceId) {
          if (device.online !== true) {
            accessory.reachable = false;
            platform.log(
              'Device [%s] was reported to be offline by the API',
              accessory.displayName
            );
            callback(
              'API reported that [%s] is not online',
              device.name
            );
            return;
          }

          if (accessory.context.switches > 1) {
            if (
              device.params.switches[accessory.context.channel - 1]
                .switch === 'on'
            ) {
              accessory.reachable = true;
              platform.log(
                'API reported that [%s] CH %s is On',
                device.name,
                accessory.context.channel
              );
              callback(null, 1);
              return;
            }
            if (
              device.params.switches[accessory.context.channel - 1]
                .switch === 'off'
            ) {
              accessory.reachable = true;
              platform.log(
                'API reported that [%s] CH %s is Off',
                device.name,
                accessory.context.channel
              );
              callback(null, 0);
            } else {
              accessory.reachable = false;
              platform.log(
                'API reported an unknown status for device [%s]',
                accessory.displayName
              );
              callback(
                `API returned an unknown status for device ${accessory.displayName}`
              );
            }
          } else if (device.params.switch === 'on') {
            accessory.reachable = true;
            platform.log('API reported that [%s] is On', device.name);
            callback(null, 1);
          } else if (device.params.switch === 'off') {
            accessory.reachable = true;
            platform.log(
              'API reported that [%s] is Off',
              device.name
            );
            callback(null, 0);
          } else {
            accessory.reachable = false;
            platform.log(
              'API reported an unknown status for device [%s]',
              accessory.displayName
            );
            callback(
              `API returned an unknown status for device ${accessory.displayName}`
            );
          }
        }
      } else if (filteredResponse.length > 1) {
        // More than one device matches our Device ID. This should not happen.
        platform.log(
          'ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.',
          device.deviceid
        );
        platform.log(filteredResponse);
        callback(
          `The response contained more than one device with Device ID ${device.deviceid}`
        );
      } else if (filteredResponse.length < 1) {
        // The device is no longer registered

        platform.log(
          'Device [%s] did not exist in the response. It will be removed',
          accessory.displayName
        );
        platform.removeAccessory(accessory);
      }
    }
  );
};

eWeLink.prototype.getCurrentTemperature = function(
  accessory,
  callback
) {
  const platform = this;

  platform.log(
    'Requesting current temperature for [%s]',
    accessory.displayName
  );

  this.webClient.get(
    `/api/user/device?${this.getArguments()}`,
    (err, res, body) => {
      if (err) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. Error was [%s]',
          err
        );
        return;
      }
      if (!body) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. No data in response.',
          err
        );
        return;
      }
      if (body.hasOwnProperty('error') && body.error !== 0) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. Response was [%s]',
          JSON.stringify(body)
        );
        callback(
          'An error was encountered while requesting a list of devices to interrogate current temperature for your device'
        );
        return;
      }

      body = body.devicelist;

      const size = Object.keys(body).length;

      if (body.length < 1) {
        callback(
          'An error was encountered while requesting a list of devices to interrogate current temperature for your device'
        );
        accessory.reachable = false;
        return;
      }

      const { deviceId } = accessory.context;

      const filteredResponse = body.filter(
        device => device.deviceid === deviceId
      );

      if (filteredResponse.length === 1) {
        const device = filteredResponse[0];

        if (device.deviceid === deviceId) {
          if (device.online !== true) {
            accessory.reachable = false;
            platform.log(
              'Device [%s] was reported to be offline by the API',
              accessory.displayName
            );
            callback(
              'API reported that [%s] is not online',
              device.name
            );
            return;
          }

          const { currentTemperature } = device.params;
          platform.log('getCurrentTemperature:', currentTemperature);

          if (accessory.getService(Service.Thermostat)) {
            accessory
              .getService(Service.Thermostat)
              .setCharacteristic(
                Characteristic.CurrentTemperature,
                currentTemperature
              );
          }
          if (accessory.getService(Service.TemperatureSensor)) {
            accessory
              .getService(Service.TemperatureSensor)
              .setCharacteristic(
                Characteristic.CurrentTemperature,
                currentTemperature
              );
          }
          accessory.reachable = true;
          callback(null, currentTemperature);
        }
      } else if (filteredResponse.length > 1) {
        // More than one device matches our Device ID. This should not happen.
        platform.log(
          'ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.',
          device.deviceid
        );
        platform.log(filteredResponse);
        callback(
          `The response contained more than one device with Device ID ${device.deviceid}`
        );
      } else if (filteredResponse.length < 1) {
        // The device is no longer registered

        platform.log(
          'Device [%s] did not exist in the response. It will be removed',
          accessory.displayName
        );
        platform.removeAccessory(accessory);
      }
    }
  );
};

eWeLink.prototype.getCurrentHumidity = function(accessory, callback) {
  const platform = this;

  platform.log(
    'Requesting current humidity for [%s]',
    accessory.displayName
  );

  this.webClient.get(
    `/api/user/device?${this.getArguments()}`,
    (err, res, body) => {
      if (err) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating current humidity. Verify your configuration options. Error was [%s]',
          err
        );
        return;
      }
      if (!body) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating current humidity. Verify your configuration options. No data in response.',
          err
        );
        return;
      }
      if (body.hasOwnProperty('error') && body.error !== 0) {
        platform.log(
          'An error was encountered while requesting a list of devices while interrogating current humidity. Verify your configuration options. Response was [%s]',
          JSON.stringify(body)
        );
        callback(
          'An error was encountered while requesting a list of devices to interrogate current humidity for your device'
        );
        return;
      }

      body = body.devicelist;

      const size = Object.keys(body).length;

      if (body.length < 1) {
        callback(
          'An error was encountered while requesting a list of devices to interrogate current humidity for your device'
        );
        accessory.reachable = false;
        return;
      }

      const { deviceId } = accessory.context;

      const filteredResponse = body.filter(
        device => device.deviceid === deviceId
      );

      if (filteredResponse.length === 1) {
        const device = filteredResponse[0];

        if (device.deviceid === deviceId) {
          if (device.online !== true) {
            accessory.reachable = false;
            platform.log(
              'Device [%s] was reported to be offline by the API',
              accessory.displayName
            );
            callback(
              'API reported that [%s] is not online',
              device.name
            );
            return;
          }

          const { currentHumidity } = device.params;
          platform.log('getCurrentHumidity:', currentHumidity);

          if (accessory.getService(Service.Thermostat)) {
            accessory
              .getService(Service.Thermostat)
              .setCharacteristic(
                Characteristic.CurrentRelativeHumidity,
                currentHumidity
              );
          }
          if (accessory.getService(Service.HumiditySensor)) {
            accessory
              .getService(Service.Thermostat)
              .setCharacteristic(
                Characteristic.CurrentRelativeHumidity,
                currentHumidity
              );
          }
          accessory.reachable = true;
          callback(null, currentHumidity);
        }
      } else if (filteredResponse.length > 1) {
        // More than one device matches our Device ID. This should not happen.
        platform.log(
          'ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.',
          device.deviceid
        );
        platform.log(filteredResponse);
        callback(
          `The response contained more than one device with Device ID ${device.deviceid}`
        );
      } else if (filteredResponse.length < 1) {
        // The device is no longer registered

        platform.log(
          'Device [%s] did not exist in the response. It will be removed',
          accessory.displayName
        );
        platform.removeAccessory(accessory);
      }
    }
  );
};

eWeLink.prototype.setTemperatureState = function(
  accessory,
  value,
  callback
) {
  const platform = this;
  const { deviceId } = accessory.context;
  const deviceInformationFromWebApi = platform.devicesFromApi.get(
    deviceId
  );
  platform.log('setting temperature: ', value);
  /*
    deviceInformationFromWebApi.params.currentHumidity = value;
    if(accessory.getService(Service.Thermostat)) {
        accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentTemperature, value);
    } else if(accesory.getService(Service.TemperatureSensor)) {
        accessory.getService(Service.TemperatureSensor).setCharacteristic(Characteristic.CurrentTemperature, value);
    }
    */
  callback();
};

eWeLink.prototype.setHumidityState = function(
  accessory,
  value,
  callback
) {
  const platform = this;
  const { deviceId } = accessory.context;
  const deviceInformationFromWebApi = platform.devicesFromApi.get(
    deviceId
  );
  platform.log('setting humidity: ', value);
  /*
    deviceInformationFromWebApi.params.currentHumidity = value;
    if(accessory.getService(Service.Thermostat)) {
        accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
    } else if(accesory.getService(Service.HumiditySensor)) {
        accessory.getService(Service.HumiditySensor).setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
    }
    */
  callback();
};

eWeLink.prototype.setPowerState = function(
  accessory,
  isOn,
  callback
) {
  const platform = this;
  const options = {};
  let { deviceId } = accessory.context;
  options.protocolVersion = 13;

  let targetState = 'off';

  if (isOn) {
    targetState = 'on';
  }

  platform.log(
    'Setting power state to [%s] for device [%s]',
    targetState,
    accessory.displayName
  );

  const payload = {};
  payload.action = 'update';
  payload.userAgent = 'app';
  payload.params = {};
  if (accessory.context.switches > 1) {
    deviceId = deviceId.replace(`CH${accessory.context.channel}`, '');
    const deviceInformationFromWebApi = platform.devicesFromApi.get(
      deviceId
    );
    payload.params.switches =
      deviceInformationFromWebApi.params.switches;
    payload.params.switches[
      accessory.context.channel - 1
    ].switch = targetState;
  } else {
    payload.params.switch = targetState;
  }
  payload.apikey = `${accessory.context.apiKey}`;
  payload.deviceid = `${deviceId}`;

  payload.sequence = platform.getSequence();

  const string = JSON.stringify(payload);
  // platform.log( string );

  if (platform.isSocketOpen) {
    setTimeout(() => {
      platform.wsc.send(string);

      // TODO Here we need to wait for the response to the socket

      callback();
    }, 1);
  } else {
    callback(
      'Socket was closed. It will reconnect automatically; please retry your command'
    );
  }
};

// Sample function to show how developer can remove accessory dynamically from outside event
eWeLink.prototype.removeAccessory = function(accessory) {
  this.log('Removing accessory [%s]', accessory.displayName);

  this.accessories.delete(accessory.context.deviceId);

  this.api.unregisterPlatformAccessories(
    'homebridge-eWeLink',
    'eWeLink',
    [accessory]
  );
};

eWeLink.prototype.login = function(callback) {
  if (
    (!this.config.phoneNumber && !this.config.email) ||
    !this.config.password ||
    !this.config.imei
  ) {
    this.log(
      'phoneNumber / email / password / imei not found in config, skipping login'
    );
    callback();
    return;
  }

  const data = {};
  if (this.config.phoneNumber) {
    data.phoneNumber = this.config.phoneNumber;
  } else if (this.config.email) {
    data.email = this.config.email;
  }
  data.password = this.config.password;
  data.version = '6';
  data.ts = `${Math.floor(new Date().getTime() / 1000)}`;
  data.nonce = `${nonce()}`;
  data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
  data.imei = this.config.imei;
  data.os = 'iOS';
  data.model = 'iPhone10,6';
  data.romVersion = '11.1.2';
  data.appVersion = '3.5.3';

  const json = JSON.stringify(data);
  this.log('Sending login request with user credentials: %s', json);

  // let appSecret = "248,208,180,108,132,92,172,184,256,152,256,144,48,172,220,56,100,124,144,160,148,88,28,100,120,152,244,244,120,236,164,204";
  // let f = "ab!@#$ijklmcdefghBCWXYZ01234DEFGHnopqrstuvwxyzAIJKLMNOPQRSTUV56789%^&*()";
  // let decrypt = function(r){var n="";return r.split(',').forEach(function(r){var t=parseInt(r)>>2,e=f.charAt(t);n+=e}),n.trim()};
  const decryptedAppSecret = '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM'; // decrypt(appSecret);
  const sign = require('crypto')
    .createHmac('sha256', decryptedAppSecret)
    .update(json)
    .digest('base64');
  this.log('Login signature: %s', sign);

  const webClient = request.createClient(
    `https://${this.config.apiHost}`
  );
  webClient.headers.Authorization = `Sign ${sign}`;
  webClient.headers['Content-Type'] =
    'application/json;charset=UTF-8';
  webClient.post('/api/user/login', data, (err, res, body) => {
    if (err) {
      this.log(
        'An error was encountered while logging in. Error was [%s]',
        err
      );
      callback();
      return;
    }

    // If we receive 301 error, switch to new region and try again
    if (
      body.hasOwnProperty('error') &&
      body.error == 301 &&
      body.hasOwnProperty('region')
    ) {
      const idx = this.config.apiHost.indexOf('-');
      if (idx == -1) {
        this.log(
          'Received new region [%s]. However we cannot construct the new API host url.',
          body.region
        );
        callback();
        return;
      }
      const newApiHost =
        body.region + this.config.apiHost.substring(idx);
      if (this.config.apiHost !== newApiHost) {
        this.log(
          'Received new region [%s], updating API host to [%s].',
          body.region,
          newApiHost
        );
        this.config.apiHost = newApiHost;
        this.login(callback);
        return;
      }
    }

    if (!body.at) {
      const response = JSON.stringify(body);
      this.log(
        'Server did not response with an authentication token. Response was [%s]',
        response
      );
      callback();
      return;
    }

    this.log('Authentication token received [%s]', body.at);
    this.authenticationToken = body.at;
    this.config.authenticationToken = body.at;
    this.webClient = request.createClient(
      `https://${this.config.apiHost}`
    );
    this.webClient.headers.Authorization = `Bearer ${body.at}`;

    this.getWebSocketHost(() => {
      callback(body.at);
    });
  });
};

eWeLink.prototype.getWebSocketHost = function(callback) {
  const data = {};
  data.accept = 'mqtt,ws';
  data.version = '6';
  data.ts = `${Math.floor(new Date().getTime() / 1000)}`;
  data.nonce = `${nonce()}`;
  data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
  data.imei = this.config.imei;
  data.os = 'iOS';
  data.model = 'iPhone10,6';
  data.romVersion = '11.1.2';
  data.appVersion = '3.5.3';

  const webClient = request.createClient(
    `https://${this.config.apiHost.replace('-api', '-disp')}`
  );
  webClient.headers.Authorization = `Bearer ${this.authenticationToken}`;
  webClient.headers['Content-Type'] =
    'application/json;charset=UTF-8';
  webClient.post('/dispatch/app', data, (err, res, body) => {
    if (err) {
      this.log(
        'An error was encountered while getting websocket host. Error was [%s]',
        err
      );
      callback();
      return;
    }

    if (!body.domain) {
      const response = JSON.stringify(body);
      this.log(
        'Server did not response with a websocket host. Response was [%s]',
        response
      );
      callback();
      return;
    }

    this.log('WebSocket host received [%s]', body.domain);
    this.config.webSocketApi = body.domain;
    if (this.wsc) {
      this.wsc.url = `wss://${body.domain}:8080/api/ws`;
    }
    callback(body.domain);
  });
};

eWeLink.prototype.relogin = function(callback) {
  const platform = this;
  platform.login(() => {
    // Reconnect websocket
    if (platform.isSocketOpen) {
      platform.wsc.instance.terminate();
      platform.wsc.onclose();
      platform.wsc.reconnect();
    }
    callback && callback();
  });
};

eWeLink.prototype.getDeviceTypeByUiid = function(uiid) {
  const MAPPING = {
    1: 'SOCKET',
    2: 'SOCKET_2',
    3: 'SOCKET_3',
    4: 'SOCKET_4',
    5: 'SOCKET_POWER',
    6: 'SWITCH',
    7: 'SWITCH_2',
    8: 'SWITCH_3',
    9: 'SWITCH_4',
    10: 'OSPF',
    11: 'CURTAIN',
    12: 'EW-RE',
    13: 'FIREPLACE',
    14: 'SWITCH_CHANGE',
    15: 'THERMOSTAT',
    16: 'COLD_WARM_LED',
    17: 'THREE_GEAR_FAN',
    18: 'SENSORS_CENTER',
    19: 'HUMIDIFIER',
    22: 'RGB_BALL_LIGHT',
    23: 'NEST_THERMOSTAT',
    24: 'GSM_SOCKET',
    25: 'AROMATHERAPY',
    26: 'BJ_THERMOSTAT',
    27: 'GSM_UNLIMIT_SOCKET',
    28: 'RF_BRIDGE',
    29: 'GSM_SOCKET_2',
    30: 'GSM_SOCKET_3',
    31: 'GSM_SOCKET_4',
    32: 'POWER_DETECTION_SOCKET',
    33: 'LIGHT_BELT',
    34: 'FAN_LIGHT',
    35: 'EZVIZ_CAMERA',
    36: 'SINGLE_CHANNEL_DIMMER_SWITCH',
    38: 'HOME_KIT_BRIDGE',
    40: 'FUJIN_OPS',
    41: 'CUN_YOU_DOOR',
    42: 'SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT',
    43: '',
    44: '',
    45: 'DOWN_CEILING_LIGHT',
    46: 'AIR_CLEANER',
    49: 'MACHINE_BED',
    51: 'COLD_WARM_DESK_LIGHT',
    52: 'DOUBLE_COLOR_DEMO_LIGHT',
    53: 'ELECTRIC_FAN_WITH_LAMP',
    55: 'SWEEPING_ROBOT',
    56: 'RGB_BALL_LIGHT_4',
    57: 'MONOCHROMATIC_BALL_LIGHT',
    59: 'MEARICAMERA',
    1001: 'BLADELESS_FAN',
    1002: 'NEW_HUMIDIFIER',
    1003: 'WARM_AIR_BLOWER'
  };
  return MAPPING[uiid] || '';
};

eWeLink.prototype.getDeviceChannelCountByType = function(deviceType) {
  const DEVICE_CHANNEL_LENGTH = {
    SOCKET: 1,
    SWITCH_CHANGE: 1,
    GSM_UNLIMIT_SOCKET: 1,
    SWITCH: 1,
    THERMOSTAT: 1,
    SOCKET_POWER: 1,
    GSM_SOCKET: 1,
    POWER_DETECTION_SOCKET: 1,
    SOCKET_2: 2,
    GSM_SOCKET_2: 2,
    SWITCH_2: 2,
    SOCKET_3: 3,
    GSM_SOCKET_3: 3,
    SWITCH_3: 3,
    SOCKET_4: 4,
    GSM_SOCKET_4: 4,
    SWITCH_4: 4,
    CUN_YOU_DOOR: 4
  };
  return DEVICE_CHANNEL_LENGTH[deviceType] || 0;
};

eWeLink.prototype.getDeviceChannelCount = function(device) {
  const deviceType = this.getDeviceTypeByUiid(device.uiid);
  // this.log('Device type for %s is %s', device.uiid, deviceType);
  const channels = this.getDeviceChannelCountByType(deviceType);
  return channels;
};

// create arguments for later get request
eWeLink.prototype.getArguments = function() {
  const args = {};
  args.lang = 'en';
  args.apiKey = apiKey;
  args.getTag = '1';
  args.version = '6';
  args.ts = `${Math.floor(new Date().getTime() / 1000)}`;
  args.nounce = `${nonce()}`;
  args.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
  args.imei = this.config.imei;
  args.os = 'iOS';
  args.model = 'iPhone10,6';
  args.romVersion = '11.1.2';
  args.appVersion = '3.5.3';
  return querystring.stringify(args);
};

/* WEB SOCKET STUFF */

function WebSocketClient() {
  this.number = 0; // Message number
  this.autoReconnectInterval = 5 * 1000; // ms
  this.pendingReconnect = false;
}
WebSocketClient.prototype.open = function(url) {
  this.url = url;
  this.instance = new WebSocket(this.url);
  this.instance.on('open', () => {
    this.onopen();
  });

  this.instance.on('message', (data, flags) => {
    this.number++;
    this.onmessage(data, flags, this.number);
  });

  this.instance.on('close', e => {
    switch (e) {
      case 1000: // CLOSE_NORMAL
        // console.log("WebSocket: closed");
        break;
      default:
        // Abnormal closure
        this.reconnect(e);
        break;
    }
    this.onclose(e);
  });
  this.instance.on('error', e => {
    switch (e.code) {
      case 'ECONNREFUSED':
        this.reconnect(e);
        break;
      default:
        this.onerror(e);
        break;
    }
  });
};
WebSocketClient.prototype.send = function(data, option) {
  try {
    this.instance.send(data, option);
  } catch (e) {
    this.instance.emit('error', e);
  }
};
WebSocketClient.prototype.reconnect = function(e) {
  // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);

  if (this.pendingReconnect) return;
  this.pendingReconnect = true;

  this.instance.removeAllListeners();

  const platform = this;
  setTimeout(() => {
    platform.pendingReconnect = false;
    console.log('WebSocketClient: reconnecting...');
    platform.open(platform.url);
  }, this.autoReconnectInterval);
};
WebSocketClient.prototype.onopen = function(e) {
  // console.log("WebSocketClient: open", arguments);
};
WebSocketClient.prototype.onmessage = function(data, flags, number) {
  // console.log("WebSocketClient: message", arguments);
};
WebSocketClient.prototype.onerror = function(e) {
  console.log('WebSocketClient: error', arguments);
};
WebSocketClient.prototype.onclose = function(e) {
  // console.log("WebSocketClient: closed", arguments);
};
