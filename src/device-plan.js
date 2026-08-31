export function hasLocalCredentials(device = {}) {
  return Boolean(device?.deviceId && device?.ip && device?.localKey);
}

export function connectionMode(device = {}) {
  const mode = String(device?.connection ?? 'auto').toLowerCase();
  return ['auto', 'account', 'local'].includes(mode) ? mode : 'auto';
}

export function shouldUseLocal(device = {}) {
  const mode = connectionMode(device);
  if (mode === 'account') return false;
  if (mode === 'local') return true;
  return hasLocalCredentials(device);
}

export function buildDevicePlan(discovered = [], configured = []) {
  const records = new Map();
  const skipped = [];

  for (const item of Array.isArray(discovered) ? discovered : []) {
    const deviceId = String(item?.deviceId ?? '');
    if (!deviceId) continue;
    records.set(deviceId, {
      discovery: item,
      override: {},
      source: 'account',
    });
  }

  for (const override of Array.isArray(configured) ? configured : []) {
    const deviceId = String(override?.deviceId ?? '');
    if (!deviceId) continue;

    const existing = records.get(deviceId);
    if (existing) {
      records.set(deviceId, {
        ...existing,
        override,
        source: shouldUseLocal(override) ? 'local-override' : 'account',
      });
      continue;
    }

    if (hasLocalCredentials(override)) {
      records.set(deviceId, {
        discovery: {
          deviceId,
          deviceName: override.name || override.deviceModelName || `Eufy ${deviceId.slice(-6)}`,
          deviceModel: override.deviceModel || '',
          deviceModelName: override.deviceModelName || override.deviceModel || 'RoboVac',
          mqtt: false,
          manual: true,
        },
        override,
        source: 'local-manual',
      });
    } else {
      skipped.push(override);
    }
  }

  return { records: [...records.values()], skipped };
}
