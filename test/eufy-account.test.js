import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeDiscoveredDevices } from '../src/eufy-account.js';

test('cloud device wins over duplicate synthetic mqtt record', () => {
  const result = dedupeDiscoveredDevices([
    { deviceId: 'jeeves', deviceName: 'Jeeves', mqtt: false, dps: { 15: 'Charging' } },
    { deviceId: 'jeeves', deviceName: 'Jeeves', mqtt: true, dps: {} },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].mqtt, false);
  assert.equal(result[0].dps[15], 'Charging');
});

test('mqtt-only device is preserved', () => {
  const result = dedupeDiscoveredDevices([
    { deviceId: 'omni', deviceName: 'Omni', mqtt: true, dps: { 152: 'abc' } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].mqtt, true);
});

test('mixed legacy cloud and mqtt-only vacuums remain separate', () => {
  const result = dedupeDiscoveredDevices([
    { deviceId: 'old', mqtt: false },
    { deviceId: 'new', mqtt: true },
  ]);
  assert.deepEqual(result.map((d) => d.deviceId).sort(), ['new', 'old']);
});
