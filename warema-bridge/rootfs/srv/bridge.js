// bridge.js — robust, defensive version
'use strict';

const fs = require('fs');
const warema = require('warema-wms-api');
const mqtt = require('mqtt');

/** ============= ENV & Defaults ============= */
const env = (name, def) => ((process.env[name] !== undefined) ? process.env[name] : def);

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
const COMMAND_DEDUP_MS = Math.max(0, parseInt(env('COMMAND_DEDUP_MS', '5000'), 10) || 5000);
const WAKE_COOLDOWN_MS = Math.max(0, parseInt(env('WAKE_COOLDOWN_MS', '30000'), 10) || 30000);
const ENABLE_WAVE_BEFORE_MOVE = String(env('ENABLE_WAVE_BEFORE_MOVE', 'false')).toLowerCase() === 'true';
const SET_POSITION_DEBOUNCE_MS = Math.max(0, parseInt(env('SET_POSITION_DEBOUNCE_MS', '1800'), 10) || 1800);
const POSITION_PROBE_DELAY_MS = Math.max(0, parseInt(env('POSITION_PROBE_DELAY_MS', '7000'), 10) || 7000);
const MOVE_COOLDOWN_MS = Math.max(0, parseInt(env('MOVE_COOLDOWN_MS', '4500'), 10) || 4500);
const TRACKING_INITIAL_DELAY_MS = Math.max(200, parseInt(env('TRACKING_INITIAL_DELAY_MS', '1200'), 10) || 1200);
const TRACKING_INTERVAL_MS = Math.max(500, parseInt(env('TRACKING_INTERVAL_MS', '3000'), 10) || 3000);
const TRACKING_MAX_PROBES = Math.max(1, parseInt(env('TRACKING_MAX_PROBES', '4'), 10) || 4);
const TRAVEL_TIME_FULL_MS = Math.max(1000, parseInt(env('TRAVEL_TIME_FULL_MS', '45000'), 10) || 45000);
const PROGRESS_UPDATE_INTERVAL_MS = Math.max(200, parseInt(env('PROGRESS_UPDATE_INTERVAL_MS', '1000'), 10) || 1000);

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
const recentCommands = new Map(); // SNR -> { key, ts }
const lastWaveByDevice = new Map(); // SNR -> timestamp
const lastMoveByDevice = new Map(); // SNR -> { ts, position, angle }
const pendingMoveTimers = new Map(); // SNR -> timeout handle
const pendingMoveTargets = new Map(); // SNR -> { position, angle }
const probeTimers = new Map(); // SNR -> timeout handle
const moveInFlightUntil = new Map(); // SNR -> timestamp
const trackingTimers = new Map(); // SNR -> timeout handle
const trackingState = new Map(); // SNR -> { remaining:Number, expectedPosition:Number|null }
const progressTimers = new Map(); // SNR -> interval handle
const movementSamples = new Map(); // SNR -> { startPos, targetPos, ts }
const deviceTravelTimeMs = new Map(); // SNR -> measured full-travel time

/** ============= Helpers ============= */

function parseSnr(val) {
  if (val === undefined || val === null) return null;

  if (typeof val === 'number') {
    return Number.isFinite(val) ? Math.trunc(val) : null;
  }

  const raw = String(val).trim();
  if (!raw) return null;

  // Prefer plain decimal representation if available.
  if (/^[0-9]+$/.test(raw)) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  // Some callbacks use hexadecimal SNR values (e.g. E4CA0E).
  const hexCandidate = raw.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  if (hexCandidate && /[a-fA-F]/.test(hexCandidate)) {
    const n = parseInt(hexCandidate, 16);
    return Number.isFinite(n) ? n : null;
  }

  // Fallback: keep backward-compatible behavior for mixed strings.
  const decCandidate = raw.replace(/[^0-9]/g, '');
  if (!decCandidate) return null;
  const n = parseInt(decCandidate, 10);
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

function getDeviceType(snr) {
  const dev = devices.get(snr);
  return dev ? Number(dev.type) : null;
}

function deviceSupportsTilt(snr) {
  // Type 25 (radio motor / awning) is operated as no-tilt cover.
  return getDeviceType(snr) !== 25;
}

function normalizeAngleForDevice(snr, angle) {
  if (!deviceSupportsTilt(snr)) return 0;
  return angle;
}

function clampPosition(position) {
  const n = parseInt(position, 10);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function toWmsPosition(snr, haPosition) {
  const clamped = clampPosition(haPosition);
  // Keep direct mapping: HA 100(open) -> WMS 100 for awning setup.
  if (getDeviceType(snr) === 25) return clamped;
  return clamped;
}

function fromWmsPosition(snr, wmsPosition) {
  const clamped = clampPosition(wmsPosition);
  if (getDeviceType(snr) === 25) return clamped;
  return clamped;
}

function clearProgressSimulation(snr) {
  clearTimerFor(progressTimers, snr);
}

function getEffectiveTravelTimeMs(snr) {
  const measured = deviceTravelTimeMs.get(snr);
  if (Number.isFinite(measured) && measured >= 1000) return measured;
  return TRAVEL_TIME_FULL_MS;
}

function maybeStartMovementSample(snr, startPos, targetPos) {
  const from = clampPosition(startPos);
  const to = clampPosition(targetPos);
  const distance = Math.abs(to - from);
  if (distance < 80) return;
  movementSamples.set(snr, { startPos: from, targetPos: to, ts: Date.now() });
}

function maybeFinishMovementSample(snr, currentPos) {
  const sample = movementSamples.get(snr);
  if (!sample) return;
  const reached = Math.abs(clampPosition(currentPos) - sample.targetPos) <= 3;
  if (!reached) return;

  const elapsed = Date.now() - sample.ts;
  movementSamples.delete(snr);
  if (elapsed < 5000 || elapsed > 180000) return;

  const fullTravelEstimate = Math.round((elapsed * 100) / Math.max(1, Math.abs(sample.targetPos - sample.startPos)));
  if (fullTravelEstimate < 1000 || fullTravelEstimate > 300000) return;
  const prev = getEffectiveTravelTimeMs(snr);
  const next = Math.round((prev * 0.6) + (fullTravelEstimate * 0.4));
  deviceTravelTimeMs.set(snr, next);
  console.log(`Measured travel time for ${snr}: ${next}ms (sample ${elapsed}ms over ${Math.abs(sample.targetPos - sample.startPos)}%).`);
}

function startProgressSimulation(snr, startPos, targetPos, angle) {
  clearProgressSimulation(snr);
  const from = clampPosition(startPos);
  const to = clampPosition(targetPos);
  if (from === to) return;

  const fullTravelMs = getEffectiveTravelTimeMs(snr);
  const durationMs = Math.max(PROGRESS_UPDATE_INTERVAL_MS, Math.round((fullTravelMs * Math.abs(to - from)) / 100));
  const startTs = Date.now();

  const timer = setInterval(() => {
    const elapsed = Date.now() - startTs;
    const ratio = Math.min(1, elapsed / durationMs);
    const current = Math.round(from + ((to - from) * ratio));
    positions.set(snr, { position: current, angle });
    publishPositionState(snr, current, angle);
    if (ratio >= 1) {
      clearProgressSimulation(snr);
    }
  }, PROGRESS_UPDATE_INTERVAL_MS);

  progressTimers.set(snr, timer);
}

function shouldDispatchCommand(snr, key) {
  const now = Date.now();
  const prev = recentCommands.get(snr);
  if (prev && prev.key === key && (now - prev.ts) < COMMAND_DEDUP_MS) {
    console.log(`Skipping duplicate command for ${snr}: ${key}`);
    return false;
  }
  recentCommands.set(snr, { key, ts: now });
  return true;
}

function clearTimerFor(map, snr) {
  const timer = map.get(snr);
  if (timer) {
    clearTimeout(timer);
    map.delete(snr);
  }
}

function isMoveBusy(snr) {
  const inflightUntil = moveInFlightUntil.get(snr) || 0;
  if (Date.now() < inflightUntil) return true;
  return pendingMoveTimers.has(snr);
}

function publishPositionState(snr, position, angle) {
  mqttClient.publish(`warema/${snr}/position`, String(position), { retain: false });
  mqttClient.publish(`warema/${snr}/tilt`, String(angle), { retain: false });
}

function schedulePositionProbe(snr, delayMs = POSITION_PROBE_DELAY_MS) {
  if (delayMs <= 0) return;
  clearTimerFor(probeTimers, snr);
  const timer = setTimeout(() => {
    probeTimers.delete(snr);
    // Single-shot probe only, otherwise we end up in blindGetPos storms again.
    callStickMethod('vnBlindGetPosition', snr, { cmdConfirmation: false, callbackOnUnchangedPos: true });
  }, delayMs);
  probeTimers.set(snr, timer);
}

function clearPositionTracking(snr) {
  clearTimerFor(trackingTimers, snr);
  trackingState.delete(snr);
}

function scheduleTrackingProbe(snr, delayMs) {
  const timer = setTimeout(() => {
    trackingTimers.delete(snr);
    const state = trackingState.get(snr);
    if (!state) return;

    const current = positions.get(snr);
    if (state.expectedPosition !== null && current && Number.isFinite(current.position)) {
      if (Math.abs(current.position - state.expectedPosition) <= 3) {
        trackingState.delete(snr);
        return;
      }
    }

    callStickMethod('vnBlindGetPosition', snr, { cmdConfirmation: false, callbackOnUnchangedPos: true });
    state.remaining -= 1;
    if (state.remaining <= 0) {
      trackingState.delete(snr);
      return;
    }
    scheduleTrackingProbe(snr, TRACKING_INTERVAL_MS);
  }, delayMs);
  trackingTimers.set(snr, timer);
}

function startPositionTracking(snr, expectedPosition = null) {
  clearPositionTracking(snr);
  clearTimerFor(probeTimers, snr);
  trackingState.set(snr, {
    remaining: TRACKING_MAX_PROBES,
    expectedPosition: Number.isFinite(expectedPosition) ? expectedPosition : null,
  });
  scheduleTrackingProbe(snr, TRACKING_INITIAL_DELAY_MS);
}

function shouldTrackPosition(snr) {
  // Type-25 devices frequently time out on blindGetPos; aggressive probing can
  // overwhelm the queue and degrade movement behavior.
  return getDeviceType(snr) !== 25;
}

function sendMoveCommand(snr, position, angle) {
  const previous = positions.get(snr);
  const startPos = previous && Number.isFinite(parseInt(previous.position, 10))
    ? parseInt(previous.position, 10)
    : clampPosition(position);
  const normalizedPosition = clampPosition(position);
  const normalizedAngle = normalizeAngleForDevice(snr, angle);
  const wmsPosition = toWmsPosition(snr, normalizedPosition);
  const now = Date.now();
  const inflightUntil = moveInFlightUntil.get(snr) || 0;
  if (now < inflightUntil) {
    // Command still in flight: coalesce to last target.
    pendingMoveTargets.set(snr, { position: normalizedPosition, angle: normalizedAngle });
    return false;
  }
  const prevMove = lastMoveByDevice.get(snr);
  // Type-25 devices often report command timeouts despite physically moving.
  // For these devices, suppressing same-target retries for 12s can drop valid
  // user retries (e.g. 100 -> 100). Keep near-duplicate filtering for others.
  const shouldSuppressNearDuplicate = getDeviceType(snr) !== 25;
  if (shouldSuppressNearDuplicate && prevMove && (now - prevMove.ts) < 12000) {
    const samePosition = Math.abs(((prevMove.position !== undefined) ? prevMove.position : 0) - normalizedPosition) <= 2;
    const sameAngle = Math.abs(((prevMove.angle !== undefined) ? prevMove.angle : 0) - normalizedAngle) <= 5;
    if (samePosition && sameAngle) {
      console.log(`Skipping near-duplicate move for ${snr}: position=${normalizedPosition} angle=${normalizedAngle}`);
      return false;
    }
  }

  // Some setups benefit from wave before move, but default off because
  // it can add extra queue pressure on unstable links.
  if (ENABLE_WAVE_BEFORE_MOVE) {
    const lastWave = lastWaveByDevice.get(snr) || 0;
    if ((now - lastWave) >= WAKE_COOLDOWN_MS) {
      callStickMethod('vnBlindWaveRequest', snr);
      lastWaveByDevice.set(snr, now);
    }
  }

  // Do not force STOP before every move: this can itself time out and block queue.
  console.log(`Sending move command to ${snr}: haPosition=${normalizedPosition} wmsPosition=${wmsPosition} angle=${normalizedAngle}`);
  const ok = callStickMethod('vnBlindSetPosition', snr, wmsPosition, normalizedAngle);
  if (ok) {
    lastMoveByDevice.set(snr, { ts: now, position: normalizedPosition, angle: normalizedAngle });
    moveInFlightUntil.set(snr, now + MOVE_COOLDOWN_MS);
    // Optimistic publish keeps HA state from staying "unknown" when callbacks
    // are sparse or delayed.
    positions.set(snr, { position: normalizedPosition, angle: normalizedAngle });
    publishPositionState(snr, normalizedPosition, normalizedAngle);
    maybeStartMovementSample(snr, startPos, normalizedPosition);
    startProgressSimulation(snr, startPos, normalizedPosition, normalizedAngle);
    if (shouldTrackPosition(snr)) {
      startPositionTracking(snr, normalizedPosition);
    } else {
      clearPositionTracking(snr);
      clearTimerFor(probeTimers, snr);
    }
  }
  return ok;
}

function queueSetPositionCommand(snr, position, angle) {
  const normalizedAngle = normalizeAngleForDevice(snr, angle);
  pendingMoveTargets.set(snr, { position, angle: normalizedAngle });
  clearTimerFor(pendingMoveTimers, snr);

  const timer = setTimeout(() => {
    pendingMoveTimers.delete(snr);
    const target = pendingMoveTargets.get(snr);
    pendingMoveTargets.delete(snr);
    if (!target) return;
    // If the queue is still busy with prior command processing, postpone once.
    if (isMoveBusy(snr)) {
      pendingMoveTargets.set(snr, target);
      queueSetPositionCommand(snr, target.position, target.angle);
      return;
    }
    sendMoveCommand(snr, target.position, target.angle);
  }, SET_POSITION_DEBOUNCE_MS);

  pendingMoveTimers.set(snr, timer);
}

function drainPendingMoveIfAny(snr) {
  const target = pendingMoveTargets.get(snr);
  if (!target) return;
  pendingMoveTargets.delete(snr);
  sendMoveCommand(snr, target.position, target.angle);
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

  if (WMS_PAN_ID !== 'FFFF') {
    startStickOnPort(fallback);
    return;
  }

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
    if (typeof stickUsb.setCmdConfirmationNotificationEnabled === 'function') {
      stickUsb.setCmdConfirmationNotificationEnabled(true);
    }
    // If device list is still unknown (early startup), default to conservative mode.
    const hasType25 = (devices.size === 0) || [...devices.values()].some((d) => Number(d.type) === 25);
    if (typeof stickUsb.setPosUpdInterval === 'function') {
      // Type-25 radio motors often do not answer blindGetPos reliably -> disable periodic polling.
      if (hasType25) {
        stickUsb.setPosUpdInterval(0);
        console.log('Type-25 devices detected: disabled periodic position polling to avoid blindGetPos retry storms.');
      } else {
        const effectivePollingInterval = (POLLING_INTERVAL > 0 && POLLING_INTERVAL < 30000) ? 30000 : POLLING_INTERVAL;
        if (effectivePollingInterval !== POLLING_INTERVAL) {
          console.log(`Polling interval ${POLLING_INTERVAL}ms too low, using ${effectivePollingInterval}ms for stability.`);
        }
        stickUsb.setPosUpdInterval(effectivePollingInterval);
        console.log(`Interval for position update set to ${Math.round(effectivePollingInterval / 1000)}s.`);
      }
    }
    if (typeof stickUsb.setWatchMovingBlindsInterval === 'function') {
      if (hasType25) {
        stickUsb.setWatchMovingBlindsInterval(0);
        console.log('Type-25 devices detected: disabled moving-blinds watcher to keep command queue clean.');
      } else {
        const effectiveMovingInterval = (MOVING_INTERVAL > 0 && MOVING_INTERVAL < 5000) ? 5000 : MOVING_INTERVAL;
        if (effectiveMovingInterval !== MOVING_INTERVAL) {
          console.log(`Moving interval ${MOVING_INTERVAL}ms too low, using ${effectiveMovingInterval}ms for stability.`);
        }
        stickUsb.setWatchMovingBlindsInterval(effectiveMovingInterval);
      }
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
    setIntervals();
    return;
  }

  const forced = parseForcedDevices(FORCE_DEVICES_RAW);
  if (forced.length > 0) {
    for (const fd of forced) {
      ensureDeviceRegistered(fd);
    }
    setIntervals();
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
      registerDevices();
      setIntervals();
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
        // Re-apply interval strategy now that concrete device types are known.
        setIntervals();
      }
      break;
    case 'wms-vb-rcv-weather-broadcast': {
      if (!msg.payload || !msg.payload.weather) break;
      const w = msg.payload.weather;
      const snr = parseSnr(w.snr);
      if (!snr || IGNORED_DEVICES.has(String(snr))) break;

      console.log(`WMS weather broadcast from ${snr}: temp=${w.temp} wind=${w.wind} rain=${w.rain} lumen=${w.lumen}`);
      announceWeatherSensors(snr);
      mqttClient.publish(`warema/${snr}/illuminance/state`, String((w.lumen !== undefined) ? w.lumen : ''), { retain: false });
      mqttClient.publish(`warema/${snr}/temperature/state`, String((w.temp !== undefined) ? w.temp : ''), { retain: false });
      mqttClient.publish(`warema/${snr}/wind/state`, String((w.wind !== undefined) ? w.wind : ''), { retain: false });
      mqttClient.publish(`warema/${snr}/rain/state`, String((w.rain !== undefined) ? w.rain : ''), { retain: false });
      break;
    }
    case 'wms-vb-blind-position-update': {
      const snr = parseSnr(msg.payload && msg.payload.snr);
      if (!snr || IGNORED_DEVICES.has(String(snr))) break;

      if (!devices.has(snr)) {
        ensureDeviceRegistered({ snr, name: String(snr), type: 25 });
      }

      const wmsPos = Number.isFinite(parseInt(msg.payload.position, 10)) ? parseInt(msg.payload.position, 10) : 0;
      const pos = fromWmsPosition(snr, wmsPos);
      const ang = Number.isFinite(parseInt(msg.payload.angle, 10)) ? parseInt(msg.payload.angle, 10) : 0;
      console.log(`WMS remote update ${snr}: wmsPosition=${wmsPos} haPosition=${pos} tilt=${ang}`);
      clearProgressSimulation(snr);
      maybeFinishMovementSample(snr, pos);
      positions.set(snr, { position: pos, angle: ang });
      publishPositionState(snr, pos, ang);
      clearTimerFor(probeTimers, snr);
      const state = trackingState.get(snr);
      if (state && state.expectedPosition !== null && Math.abs(pos - state.expectedPosition) <= 3) {
        clearPositionTracking(snr);
      }
      break;
    }
    case 'wms-vb-cmd-result-set-position':
      console.log(`WMS command result set-position: ${JSON.stringify(msg.payload)}`);
      if (msg.payload) {
        const snr = parseSnr(msg.payload.snr);
        const wmsPos = parseInt(msg.payload.position, 10);
        const ang = parseInt(msg.payload.angle, 10);
        if (snr) {
          // Fallback publish: some installations do not emit continuous position
          // updates while moving, so command result should still update MQTT state.
          if (Number.isFinite(wmsPos)) {
            const pos = fromWmsPosition(snr, wmsPos);
            const normalizedAngle = Number.isFinite(ang) ? ang : 0;
            clearProgressSimulation(snr);
            maybeFinishMovementSample(snr, pos);
            positions.set(snr, { position: pos, angle: normalizedAngle });
            publishPositionState(snr, pos, normalizedAngle);
          }
          moveInFlightUntil.set(snr, 0);
          if (shouldTrackPosition(snr)) {
            startPositionTracking(snr, Number.isFinite(wmsPos) ? fromWmsPosition(snr, wmsPos) : null);
          } else {
            clearPositionTracking(snr);
            clearTimerFor(probeTimers, snr);
          }
          drainPendingMoveIfAny(snr);
        }
      }
      break;
    case 'wms-vb-cmd-result-stop':
      console.log(`WMS command result stop: ${JSON.stringify(msg.payload)}`);
      if (msg.payload) {
        const snr = parseSnr(msg.payload.snr);
        if (snr) {
          moveInFlightUntil.set(snr, 0);
          clearPositionTracking(snr);
          drainPendingMoveIfAny(snr);
          schedulePositionProbe(snr, 4000);
        }
      }
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
      if (!shouldDispatchCommand(snr, `set:${val}`)) break;
      if (val === 'CLOSE') {
        sendMoveCommand(snr, 100, 0);
      } else if (val === 'OPEN') {
        sendMoveCommand(snr, 0, -100);
      } else if (val === 'STOP') {
        clearTimerFor(pendingMoveTimers, snr);
        pendingMoveTargets.delete(snr);
        clearPositionTracking(snr);
        clearProgressSimulation(snr);
        movementSamples.delete(snr);
        callStickMethod('vnBlindStop', snr, false);
        schedulePositionProbe(snr, 4000);
      }
      break;
    }
    case 'set_position': {
      const target = parseInt(msgStr, 10);
      const pos = Number.isFinite(target) ? target : safePos;
      // queueSetPositionCommand already debounces slider bursts. Additional
      // duplicate suppression here can drop valid retries for identical targets.
      queueSetPositionCommand(snr, pos, safeAngle);
      break;
    }
    case 'set_tilt': {
      const target = parseInt(msgStr, 10);
      const ang = Number.isFinite(target) ? target : safeAngle;
      if (!shouldDispatchCommand(snr, `set_tilt:${ang}`)) break;
      sendMoveCommand(snr, safePos, ang);
      break;
    }
    default:
      break;
  }
});

process.on('SIGINT', () => {
  for (const timer of pendingMoveTimers.values()) clearTimeout(timer);
  for (const timer of probeTimers.values()) clearTimeout(timer);
  for (const timer of trackingTimers.values()) clearTimeout(timer);
  for (const timer of progressTimers.values()) clearTimeout(timer);
  closeStick();
  process.exit(0);
});
