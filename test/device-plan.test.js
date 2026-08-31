import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDevicePlan,
  connectionMode,
  hasLocalCredentials,
  shouldUseLocal,
} from '../src/device-plan.js';

test('local credentials require deviceId, ip and localKey', () => {
  assert.equal(hasLocalCredentials({ deviceId: 'abc', ip: '192.0.2.10', localKey: 'key' }), true);
  assert.equal(hasLocalCredentials({ deviceId: 'abc', ip: '192.0.2.10' }), false);
});

test('connection mode auto prefers complete local configuration', () => {
  const config = { deviceId: 'abc', ip: '192.0.2.10', localKey: 'key' };
  assert.equal(connectionMode(config), 'auto');
  assert.equal(shouldUseLocal(config), true);
  assert.equal(shouldUseLocal({ ...config, connection: 'account' }), false);
  assert.equal(shouldUseLocal({ ...config, connection: 'local' }), true);
});

test('account discovered devices and manual local devices coexist', () => {
  const discovered = [
    { deviceId: 'mqtt-1', deviceName: 'New Vacuum', deviceModel: 'T2351', mqtt: true },
    { deviceId: 'old-1', deviceName: 'Old Cloud Vacuum', deviceModel: 'T2251', mqtt: false },
  ];
  const configured = [
    { deviceId: 'old-1', connection: 'local', ip: '192.0.2.20', localKey: 'old-key' },
    { deviceId: 'local-only', name: 'Basement Vacuum', deviceModel: 'T2118', ip: '192.0.2.30', localKey: 'local-key' },
  ];

  const plan = buildDevicePlan(discovered, configured);
  assert.equal(plan.records.length, 3);
  assert.equal(plan.skipped.length, 0);

  const old = plan.records.find((entry) => entry.discovery.deviceId === 'old-1');
  assert.equal(old.source, 'local-override');

  const manual = plan.records.find((entry) => entry.discovery.deviceId === 'local-only');
  assert.equal(manual.source, 'local-manual');
  assert.equal(manual.discovery.deviceModel, 'T2118');
});

test('undiscovered account-only override is skipped instead of creating a broken accessory', () => {
  const plan = buildDevicePlan([], [{ deviceId: 'not-found', connection: 'account' }]);
  assert.equal(plan.records.length, 0);
  assert.equal(plan.skipped.length, 1);
});
