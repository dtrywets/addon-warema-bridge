// bridge.js — robust, defensive version
'use strict';

const fs = require('fs');
const warema = require('warema-wms-api');
const mqtt = require('mqtt');

/** ============= ENV & Defaults ============= */
const env = (name, def) => (process.env[name] ?? def);

const listEnv = (name) => {
  const v = env(name, '').trim();
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

function parseKnownDevices(raw) {
  const text = (raw || '').trim();
  if (!text) return [];

  // Home Assistant can pass object-list options as JSON array or linewise JSON objects.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (_e) {
    // Fallback handled below.
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);
}

// WMS
const WMS_SERIAL_PORT = env('WMS_SERIAL_PORT', '/dev/ttyUSB0');
const WMS_CHANNEL = parseInt(env('WMS_CHANNEL', '17'), 10);
const WMS_PAN_ID = env('WMS_PAN_ID', 'FFFF');
const WMS_KEY = env('WMS_KEY', '00112233445566778899AABBCCDDEEFF');

// MQTT
const MQTT_SERVER = env('MQTT_SERVER', 'mqtt://localhost:1883');
const MQTT_USER = env('MQTT_USER', '');
const MQTT_PASSWORD = env('MQTT_PASSWORD', '');

// Behavior
const POLLING_INTERVAL = Math.max(0, parseInt(env('POLLING_INTERVAL', '30000'), 10) || 30000);
const MOVING_INTERVAL = Math.max(0, parseInt(env('MOVING_INTERVAL', '1000'), 10) || 1000);

// Device handling
const IGNORED_DEVICES = new Set(
  listEnv('IGNORED_DEVICES')
    .map((entry) => parseSnr(entry))
    .filter((snr) => Number.isFinite(snr))
    .map((snr) => String(snr)),
); // SNR normalized to decimal string
const FORCE_DEVICES_RAW = listEnv('FORCE_DEVICES'); // Entries: "SNR" or "SNR:TYPE"
const KNOWN_DEVICES = parseKnownDevices(env('KNOWN_DEVICES', ''));

// Misc
const HA_PREFIX = 'homeassistant';
const BRIDGE_AVAIL_TOPIC = 'warema/bridge/state';
const DISCOVERY_RETAIN = true;

/** ============= State ============= */
let stickUsb = null;

// Device registry: SNR (Number) -> { snr:Number, name:String, type:Number }
const devices = new Map();

// Positions: SNR -> { position:Number, angle:Number }
const positions = new Map();

// Weather sensor SNRs already announced via HA discovery
const weatherAnnounced = new Set();

/** ============= Helpers ============= */

function parseSnr(val) {
  const n = parseInt(String(val).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseForcedDevices(list) {
  // "00969444:25,12345" => [{snr:969444,type:25},{snr:12345,type:25}]
  const out = [];
  for (const item of list) {
    const [idPart, typePart] = item.split(':').map((s) => s.trim());
    const snr = parseSnr(idPart);
    if (!snr) continue;
    const type = parseInt(typePart || '25', 10);
    out.push({ snr, type: Number.isFinite(type) ? type : 25 });
  }
  return out;
}

function listByIdCandidates() {
  const dir = '/dev/serial/by-id';
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir);
    const out = [];
    for (const entry of entries) {
      const p = `${dir}/${entry}`;
      out.push(p);
      try {
        out.push(fs.realpathSync(p));
      } catch (_e) {
        // Keep symlink path even if resolving fails.
      }
    }
    return out;
  } catch (_e) {
    return [];
  }
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length > 0))];
}

function addBlindToStick(snr, name) {
  if (!stickUsb) return;
  const addFn = stickUsb.vnBlindAdd || stickUsb.addVnBlind;
  if (typeof addFn === 'function') {
    try {
      addFn.call(stickUsb, snr, name || String(snr));
    } catch (e) {
      console.log(`WMS addBlind failed for ${snr}: ${e.message || e}`);
    }
  }
}

function closeStick() {
  if (!stickUsb || typeof stickUsb.close !== 'function') return;
  try {
    stickUsb.close();
  } catch (e) {
    console.log(`WMS close failed: ${e.message || e}`);
  }
}

function callStickMethod(method, ...args) {
  if (!stickUsb || typeof stickUsb[method] !== 'function') {
    console.log(`WMS command skipped: method ${method} not available yet.`);
    return false;
  }
  try {
    stickUsb[method](...args);
    return true;
  } catch (e) {
    console.log(`WMS command ${method} failed: ${e.message || e}`);
    return false;
  }
}

function buildSerialCandidates() {
  return uniqueNonEmpty([
    WMS_SERIAL_PORT,
    ...listByIdCandidates(),
    '/dev/ttyUSB0',
    '/dev/ttyACM0',
    '/dev/ttyS1',
  ]);
}

function startStickOnPort(port) {
  console.log(`Starting WMS stick on serial port: ${port}`);
  stickUsb = new warema(
    port,
    WMS_CHANNEL,
    WMS_PAN_ID,
    WMS_KEY,
    {},
    stickCallback,
  );
}

function initStickWithBestPort() {
  const candidates = buildSerialCandidates();
  const fallback = candidates[0] || WMS_SERIAL_PORT;

  if (typeof warema.listWmsStickSerialPorts !== 'function') {
    startStickOnPort(fallback);
    return;
  }

  let resolved = false;
  const timeout = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    console.log(`WMS stick auto-detect timeout. Falling back to ${fallback}`);
    startStickOnPort(fallback);
  }, 2500);

  try {
    warema.listWmsStickSerialPorts((err, msg) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      const detected = uniqueNonEmpty(
        ((msg && msg.payload && msg.payload.portsList) || []).map((p) => p.path),
      );

      if (detected.length === 0) {
        if (err) {
          console.log(`WMS stick auto-detect failed: ${err}`);
        }
        console.log(`No WMS serial port detected. Falling back to ${fallback}`);
        startStickOnPort(fallback);
        return;
      }

      // Prefer configured port if it was actually detected as a WMS stick.
      if (detected.includes(WMS_SERIAL_PORT)) {
        startStickOnPort(WMS_SERIAL_PORT);
        return;
      }

      // Prefer any by-id path if available, otherwise first detected WMS stick.
      const byId = detected.find((p) => p.startsWith('/dev/serial/by-id/'));
      const selected = byId || detected[0];
      console.log(`Configured port ${WMS_SERIAL_PORT} not detected as WMS stick. Auto-selected ${selected}`);
      startStickOnPort(selected);
    });
  } catch (e) {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeout);
      console.log(`WMS stick auto-detect exception: ${e.message || e}. Falling back to ${fallback}`);
      startStickOnPort(fallback);
    }
  }
}

function ensureDeviceRegistered(element) {
  const snr = parseSnr(element.snr);
  if (!snr) return;

  if (IGNORED_DEVICES.has(String(snr))) {
    if (devices.has(snr)) devices.delete(snr);
    return;
  }

  const name = element.name && String(element.name).trim() ? String(element.name).trim() : String(snr);
  const type = parseInt(element.type, 10);
  if (!Number.isFinite(type)) return;

  devices.set(snr, { snr, name, type });
  addBlindToStick(snr, name);
  publishDiscoveryForDevice({ snr, name, type });
  mqttClient.publish(`warema/${snr}/availability`, 'online', { retain: true });
}

function publishDiscoveryForDevice({ snr, name, type }) {
  const availability = [
    { topic: BRIDGE_AVAIL_TOPIC },
    { topic: `warema/${snr}/availability` },
  ];
  const baseDevice = {
    identifiers: String(snr),
    manufacturer: 'Warema',
    name: name || String(snr),
  };

  let payload = null;
  let model = null;
  const topic = `${HA_PREFIX}/cover/${snr}/${snr}/config`;

  switch (Number(type)) {
    case 6:
      return;
    case 20:
      model = 'Plug receiver';
      payload = {
        availability,
        unique_id: String(snr),
        has_entity_name: true,
        device: { ...baseDevice, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${snr}/set`,
        position_topic: `warema/${snr}/position`,
        tilt_status_topic: `warema/${snr}/tilt`,
        set_position_topic: `warema/${snr}/set_position`,
        tilt_command_topic: `warema/${snr}/set_tilt`,
        tilt_closed_value: 100,
        tilt_opened_value: -100,
        tilt_min: -100,
        tilt_max: 100,
      };
      break;
    case 21:
      model = 'Actuator UP';
      payload = {
        availability,
        unique_id: String(snr),
        has_entity_name: true,
        device: { ...baseDevice, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${snr}/set`,
        position_topic: `warema/${snr}/position`,
        tilt_status_topic: `warema/${snr}/tilt`,
        set_position_topic: `warema/${snr}/set_position`,
        tilt_command_topic: `warema/${snr}/set_tilt`,
        tilt_closed_value: -100,
        tilt_opened_value: 100,
        tilt_min: -100,
        tilt_max: 100,
      };
      break;
    case 25:
      model = 'Radio motor (cover)';
      payload = {
        availability,
        unique_id: String(snr),
        has_entity_name: true,
        device: { ...baseDevice, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${snr}/set`,
        position_topic: `warema/${snr}/position`,
        set_position_topic: `warema/${snr}/set_position`,
      };
      break;
    case 9:
      return;
    default:
      console.log(`Unrecognized or unsupported device type ${type} for ${snr}, skipping discovery.`);
      return;
  }

  mqttClient.publish(topic, JSON.stringify(payload), { retain: DISCOVERY_RETAIN });
}

function announceWeatherSensors(snr, force = false) {
  if (weatherAnnounced.has(snr) && !force) return;
  weatherAnnounced.add(snr);

  const availability = [
    { topic: BRIDGE_AVAIL_TOPIC },
    { topic: `warema/${snr}/availability` },
  ];
  const base = {
    name: String(snr),
    availability,
    device: {
      identifiers: String(snr),
      manufacturer: 'Warema',
      model: 'Weather Station',
      name: String(snr),
    },
    force_update: true,
  };

  const mk = (kind, extra) => ({
    ...base,
    ...extra,
    unique_id: `${snr}_${kind}`,
  });

  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/illuminance/config`,
    JSON.stringify(mk('illuminance', { state_topic: `warema/${snr}/illuminance/state`, device_class: 'illuminance', unit_of_measurement: 'lx' })),
    { retain: DISCOVERY_RETAIN },
  );
  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/temperature/config`,
    JSON.stringify(mk('temperature', { state_topic: `warema/${snr}/temperature/state`, device_class: 'temperature', unit_of_measurement: 'C' })),
    { retain: DISCOVERY_RETAIN },
  );
  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/wind/config`,
    JSON.stringify(mk('wind', { state_topic: `warema/${snr}/wind/state`, unit_of_measurement: 'm/s' })),
    { retain: DISCOVERY_RETAIN },
  );
  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/rain/config`,
    JSON.stringify(mk('rain', { state_topic: `warema/${snr}/rain/state` })),
    { retain: DISCOVERY_RETAIN },
  );

  mqttClient.publish(`warema/${snr}/availability`, 'online', { retain: true });
}

function setIntervals() {
  try {
    if (typeof stickUsb.setPosUpdInterval === 'function') {
      stickUsb.setPosUpdInterval(POLLING_INTERVAL);
      console.log(`Interval for position update set to ${Math.round(POLLING_INTERVAL / 1000)}s.`);
    }
    if (typeof stickUsb.setWatchMovingBlindsInterval === 'function') {
      stickUsb.setWatchMovingBlindsInterval(MOVING_INTERVAL);
    }
  } catch (e) {
    console.log(`Failed to set intervals: ${e.message || e}`);
  }
}

function registerDevices() {
  if (KNOWN_DEVICES.length > 0) {
    for (const kd of KNOWN_DEVICES) {
      ensureDeviceRegistered(kd);
    }
    return;
  }

  const forced = parseForcedDevices(FORCE_DEVICES_RAW);
  if (forced.length > 0) {
    for (const fd of forced) {
      ensureDeviceRegistered(fd);
    }
  } else {
    console.log('Scanning for devices...');
    try {
      stickUsb.scanDevices({ autoAssignBlinds: false });
    } catch (e) {
      console.log(`scanDevices failed: ${e.message || e}`);
    }
  }
}

/** ============= MQTT ============= */
const mqttClient = mqtt.connect(MQTT_SERVER, {
  username: MQTT_USER || undefined,
  password: MQTT_PASSWORD || undefined,
  will: { topic: BRIDGE_AVAIL_TOPIC, payload: 'offline', retain: true },
});

mqttClient.on('connect', () => {
  console.log('Connected to MQTT');
  mqttClient.subscribe('warema/+/set');
  mqttClient.subscribe('warema/+/set_position');
  mqttClient.subscribe('warema/+/set_tilt');
  mqttClient.subscribe('homeassistant/status');
  mqttClient.publish(BRIDGE_AVAIL_TOPIC, 'online', { retain: true });

  // Reconnect-safe: close old stick instance before creating a new one.
  closeStick();
  initStickWithBestPort();
});

mqttClient.on('error', (err) => {
  console.log(`MQTT Error: ${err && err.message ? err.message : String(err)}`);
});

/** ============= Stick Callback ============= */
function stickCallback(err, msg) {
  if (err) {
    console.log(`ERROR: ${err}`);
    return;
  }
  if (!msg) return;

  switch (msg.topic) {
    case 'wms-vb-init-completion':
      console.log('Warema init completed');
      setIntervals();
      registerDevices();
      break;
    case 'wms-vb-scanned-devices':
      if (msg.payload && Array.isArray(msg.payload.devices)) {
        for (const element of msg.payload.devices) {
          ensureDeviceRegistered({
            snr: element.snr,
            name: String(element.snr),
            type: element.type,
          });
        }
      }
      break;
    case 'wms-vb-rcv-weather-broadcast': {
      if (!msg.payload || !msg.payload.weather) break;
      const w = msg.payload.weather;
      const snr = parseSnr(w.snr);
      if (!snr || IGNORED_DEVICES.has(String(snr))) break;

      console.log(`WMS weather broadcast from ${snr}: temp=${w.temp} wind=${w.wind} rain=${w.rain} lumen=${w.lumen}`);
      announceWeatherSensors(snr);
      mqttClient.publish(`warema/${snr}/illuminance/state`, String(w.lumen ?? ''), { retain: false });
      mqttClient.publish(`warema/${snr}/temperature/state`, String(w.temp ?? ''), { retain: false });
      mqttClient.publish(`warema/${snr}/wind/state`, String(w.wind ?? ''), { retain: false });
      mqttClient.publish(`warema/${snr}/rain/state`, String(w.rain ?? ''), { retain: false });
      break;
    }
    case 'wms-vb-blind-position-update': {
      const snr = parseSnr(msg.payload && msg.payload.snr);
      if (!snr || IGNORED_DEVICES.has(String(snr))) break;

      if (!devices.has(snr)) {
        ensureDeviceRegistered({ snr, name: String(snr), type: 25 });
      }

      const pos = Number.isFinite(parseInt(msg.payload.position, 10)) ? parseInt(msg.payload.position, 10) : 0;
      const ang = Number.isFinite(parseInt(msg.payload.angle, 10)) ? parseInt(msg.payload.angle, 10) : 0;
      console.log(`WMS remote update ${snr}: position=${pos} tilt=${ang}`);
      positions.set(snr, { position: pos, angle: ang });
      mqttClient.publish(`warema/${snr}/position`, String(pos), { retain: false });
      mqttClient.publish(`warema/${snr}/tilt`, String(ang), { retain: false });
      break;
    }
    case 'wms-vb-cmd-result-set-position':
    case 'wms-vb-cmd-result-stop':
      break;
    default:
      break;
  }
}

/** ============= Incoming MQTT commands ============= */
mqttClient.on('message', (topic, messageBuf) => {
  const msgStr = messageBuf.toString();
  const parts = topic.split('/');
  const scope = parts[0];

  if (scope === 'homeassistant') {
    if (parts[1] === 'status' && msgStr === 'online') {
      for (const d of devices.values()) publishDiscoveryForDevice(d);
      for (const s of weatherAnnounced.values()) announceWeatherSensors(s, true);
    }
    return;
  }

  if (scope !== 'warema') return;
  const snr = parseSnr(parts[1]);
  const command = parts[2];
  if (!snr || !command) return;
  if (!['set', 'set_position', 'set_tilt'].includes(command)) return;

  console.log(`${topic}:${msgStr}`);
  console.log(`device: ${snr} === command: ${command}`);

  if (!devices.has(snr)) {
    ensureDeviceRegistered({ snr, name: String(snr), type: 25 });
  }

  const state = positions.get(snr);
  const safePos = state && Number.isFinite(parseInt(state.position, 10)) ? parseInt(state.position, 10) : 0;
  const safeAngle = state && Number.isFinite(parseInt(state.angle, 10)) ? parseInt(state.angle, 10) : 0;

  switch (command) {
    case 'set': {
      const val = msgStr.toUpperCase();
      if (val === 'CLOSE') {
        callStickMethod('vnBlindSetPosition', snr, 100, 0);
      } else if (val === 'OPEN') {
        callStickMethod('vnBlindSetPosition', snr, 0, -100);
      } else if (val === 'STOP') {
        callStickMethod('vnBlindStop', snr);
      }
      break;
    }
    case 'set_position': {
      const target = parseInt(msgStr, 10);
      const pos = Number.isFinite(target) ? target : safePos;
      callStickMethod('vnBlindSetPosition', snr, pos, safeAngle);
      break;
    }
    case 'set_tilt': {
      const target = parseInt(msgStr, 10);
      const ang = Number.isFinite(target) ? target : safeAngle;
      callStickMethod('vnBlindSetPosition', snr, safePos, ang);
      break;
    }
    default:
      break;
  }
});

process.on('SIGINT', () => {
  closeStick();
  process.exit(0);
});
