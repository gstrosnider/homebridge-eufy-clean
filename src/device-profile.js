export const LEGACY_WORK_MODE = Object.freeze({
  AUTO: 'auto',
  ROOM: 'room',
  SMALL_ROOM: 'SmallRoom',
  SPOT: 'Spot',
});

export function controllerTransport(device) {
  const name = String(device?.constructor?.name ?? '').toLowerCase();
  if (name.includes('mqtt')) return 'mqtt';
  if (name.includes('local')) return 'local';
  if (name.includes('cloud')) return 'cloud';
  return 'unknown';
}

export function isNovelDevice(device) {
  return device?.novelApi === true;
}

export function isLegacyDevice(device) {
  return !isNovelDevice(device);
}

export function canUseScenes(device) {
  return isNovelDevice(device) && typeof device?.sceneClean === 'function';
}

export function canUseCleanParams(device) {
  return isNovelDevice(device) && typeof device?.setCleanParam === 'function';
}

export function findRobotAllowed(device, mode = 'auto') {
  const normalized = String(mode ?? 'auto').toLowerCase();
  if (normalized === 'never') return false;
  if (normalized === 'always') return true;
  return !isNovelDevice(device) && controllerTransport(device) !== 'mqtt';
}

export function supportsRawDps(device, key) {
  return Boolean(
    device &&
    typeof device.sendCommand === 'function' &&
    device.DPSMap &&
    device.DPSMap[key] != null
  );
}
