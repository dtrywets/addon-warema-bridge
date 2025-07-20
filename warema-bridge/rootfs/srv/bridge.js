const { spawn } = require('child_process');
const fs = require('fs');

// Parameter anpassen
const devicePath = process.env.WMS_SERIAL_PORT || '/dev/ttyUSBwarema';
const socatHost = process.env.SOCAT_HOST || '192.168.20.20';
const socatPort = process.env.SOCAT_PORT || '2004';

// Starte socat
console.log(`Starte socat für ${socatHost}:${socatPort} zu ${devicePath}`);
const socat = spawn('socat', [
  `PTY,link=${devicePath},raw`,
  `TCP:${socatHost}:${socatPort}`
]);

socat.stdout.on('data', (data) => console.log(`socat: ${data.toString().trim()}`));
socat.stderr.on('data', (data) => console.error(`socat [err]: ${data.toString().trim()}`));

socat.on('exit', (code) => {
  console.error(`socat wurde beendet mit Code ${code}`);
  process.exit(1); // Beende auch Node.js-App, falls socat stirbt
});

// Warte auf das Device
function waitForDevice(path, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (fs.existsSync(path)) return resolve();
      if (Date.now() - start > timeout) return reject(`Device ${path} nicht gefunden`);
      setTimeout(check, 250);
    })();
  });
}

// Async IIFE zum Starten der App
(async () => {
  try {
    await waitForDevice(devicePath);
    console.log(`Device ${devicePath} bereit – starte Warema Bridge...`);

    // Hier beginnt dein bisheriger Code zur Bridge-Kommunikation...
    require('./start-warema.js'); // ← falls ausgelagert
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();


const warema = require('warema-wms-venetian-blinds');
var mqtt = require('mqtt')

process.on('SIGINT', function() {
    process.exit(0);
});


const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : []
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : []

const settingsPar = {
    wmsChannel   : process.env.WMS_CHANNEL     || 17,
    wmsKey       : process.env.WMS_KEY         || '00112233445566778899AABBCCDDEEFF',
    wmsPanid     : process.env.WMS_PAN_ID      || 'FFFF',
    wmsSerialPort: process.env.WMS_SERIAL_PORT || '/dev/ttyUSBwarema',
  };

var registered_shades = []
var shade_position = []

function registerDevice(element) {
  console.log('Registering ' + element.snr)
  var topic = 'homeassistant/cover/' + element.snr + '/' + element.snr + '/config'
  var availability_topic = 'warema/' + element.snr + '/availability'

  var base_payload = {
    name: element.snr,
    availability: [
      {topic: 'warema/bridge/state'},
      {topic: availability_topic}
    ],
    unique_id: element.snr
  }

  var base_device = {
    identifiers: element.snr,
    manufacturer: "Warema",
    name: element.snr
  }

  var model
  var payload
  switch (parseInt(element.type)) {
    case 6:
      model = 'Weather station'
      payload = {
        ...base_payload,
        device: {
          ...base_device,
          model: model
        }
      }
      break
    // WMS WebControl Pro - while part of the network, we have no business to do with it.
    case 9:
      return
    case 20:
      model = 'Plug receiver'
      payload = {
        ...base_payload,
        device: {
          ...base_device,
          model: model
        },
        position_open: 0,
        position_closed: 100,
        command_topic: 'warema/' + element.snr + '/set',
        position_topic: 'warema/' + element.snr + '/position',
        tilt_status_topic: 'warema/' + element.snr + '/tilt',
        set_position_topic: 'warema/' + element.snr + '/set_position',
        tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
        tilt_closed_value: -100,
        tilt_opened_value: 100,
        tilt_min: -100,
        tilt_max: 100,
      }
      break
    case 21:
      model = 'Actuator UP'
      payload = {
        ...base_payload,
        device: {
          ...base_device,
          model: model
        },
        position_open: 0,
        position_closed: 100,
        command_topic: 'warema/' + element.snr + '/set',
        position_topic: 'warema/' + element.snr + '/position',
        tilt_status_topic: 'warema/' + element.snr + '/tilt',
        set_position_topic: 'warema/' + element.snr + '/set_position',
        tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
        tilt_closed_value: -100,
        tilt_opened_value: 100,
        tilt_min: -100,
        tilt_max: 100,
      }
      break
    case 25:
      model = 'Vertical awning'
      payload = {
        ...base_payload,
        device: {
          ...base_device,
          model: model
        },
        position_open: 0,
        position_closed: 100,
        command_topic: 'warema/' + element.snr + '/set',
        position_topic: 'warema/' + element.snr + '/position',
        set_position_topic: 'warema/' + element.snr + '/set_position',
      }
      break
    default:
      console.log('Unrecognized device type: ' + element.type)
      model = 'Unknown model ' + element.type
      return
  }

  if (ignoredDevices.includes(element.snr.toString())) {
    console.log('Ignoring and removing device ' + element.snr + ' (type ' + element.type + ')')
  } else {
    console.log('Adding device ' + element.snr + ' (type ' + element.type + ')')

    stickUsb.vnBlindAdd(parseInt(element.snr), element.snr.toString());
    registered_shades += element.snr
    client.publish(availability_topic, 'online', {retain: true})
  }
  client.publish(topic, JSON.stringify(payload))
}

function registerDevices() {
  if (forceDevices && forceDevices.length) {
    forceDevices.forEach(element => {
      registerDevice({snr: element, type: 25})
    })
  } else {
    console.log('Scanning...')
    stickUsb.scanDevices({autoAssignBlinds: false});
  }
}

function callback(err, msg) {
  if(err) {
    console.log('ERROR: ' + err);
  }
  if(msg) {
    switch (msg.topic) {
      case 'wms-vb-init-completion':
        console.log('Warema init completed')
        registerDevices()
        stickUsb.setPosUpdInterval(30000);
        break
      case 'wms-vb-rcv-weather-broadcast':
        if (registered_shades.includes(msg.payload.weather.snr)) {
          client.publish('warema/' + msg.payload.weather.snr + '/illuminance/state', msg.payload.weather.lumen.toString())
          client.publish('warema/' + msg.payload.weather.snr + '/temperature/state', msg.payload.weather.temp.toString())
        } else {
          var availability_topic = 'warema/' + msg.payload.weather.snr + '/availability'
          var payload = {
            name: msg.payload.weather.snr,
            availability: [
              {topic: 'warema/bridge/state'},
              {topic: availability_topic}
            ],
            device: {
              identifiers: msg.payload.weather.snr,
              manufacturer: 'Warema',
              model: 'Weather Station',
              name: msg.payload.weather.snr
            },
            force_update: true
          }

          var illuminance_payload = {
            ...payload,
            state_topic: 'warema/' + msg.payload.weather.snr + '/illuminance/state',
            device_class: 'illuminance',
            unique_id: msg.payload.weather.snr + '_illuminance',
            unit_of_measurement: 'lm',
          }
          client.publish('homeassistant/sensor/' + msg.payload.weather.snr + '/illuminance/config', JSON.stringify(illuminance_payload))

          var temperature_payload = {
            ...payload,
            state_topic: 'warema/' + msg.payload.weather.snr + '/temperature/state',
            device_class: 'temperature',
            unique_id: msg.payload.weather.snr + '_temperature',
            unit_of_measurement: 'C',
          }
          client.publish('homeassistant/sensor/' + msg.payload.weather.snr + '/temperature/config', JSON.stringify(temperature_payload))

          client.publish(availability_topic, 'online', {retain: true})
          registered_shades += msg.payload.weather.snr
        }
        break
      case 'wms-vb-blind-position-update':
        client.publish('warema/' + msg.payload.snr + '/position', msg.payload.position.toString())
        client.publish('warema/' + msg.payload.snr + '/tilt', msg.payload.angle.toString())
        shade_position[msg.payload.snr] = {
          position: msg.payload.position,
          angle: msg.payload.angle
        }
        break
      case 'wms-vb-scanned-devices':
        console.log('Scanned devices.')
        msg.payload.devices.forEach(element => registerDevice(element))
        console.log(stickUsb.vnBlindsList())
        break
      default:
        console.log('UNKNOWN MESSAGE: ' + JSON.stringify(msg));
    }
  }
}

var client = mqtt.connect(
  process.env.MQTT_SERVER,
  {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    will: {
      topic: 'warema/bridge/state',
      payload: 'offline',
      retain: true
    }
  }
)

var stickUsb

client.on('connect', function (connack) {
  console.log('Connected to MQTT')
  client.subscribe('warema/#')
  client.subscribe('homeassistant/status')
  stickUsb = new warema(settingsPar.wmsSerialPort,
    settingsPar.wmsChannel,
    settingsPar.wmsPanid,
    settingsPar.wmsKey,
    {},
    callback
  );
})

client.on('error', function (error) {
  console.log('MQTT Error: ' + error.toString())
})

client.on('message', function (topic, message) {
  // console.log(topic + ':' + message.toString())
  var scope = topic.split('/')[0]
  if (scope == 'warema') {
    var device = parseInt(topic.split('/')[1])
    var command = topic.split('/')[2]
    switch (command) {
      case 'set':
        switch (message.toString()) {
          case 'CLOSE':
            stickUsb.vnBlindSetPosition(device, 100)
            break;
          case 'OPEN':
            stickUsb.vnBlindSetPosition(device, 0)
            break;
          case 'STOP':
            stickUsb.vnBlindStop(device)
            break;
        }
        break
      case 'set_position':
        stickUsb.vnBlindSetPosition(device, parseInt(message), parseInt(shade_position[device]['angle']))
        break
      case 'set_tilt':
        stickUsb.vnBlindSetPosition(device, parseInt(shade_position[device]['position']), parseInt(message))
        break
      //default:
      //  console.log('Unrecognised command from HA')
    }
  } else if (scope == 'homeassistant') {
    if (topic.split('/')[1] == 'status' && message.toString() == 'online') {
      registerDevices()
    }
  }
})
