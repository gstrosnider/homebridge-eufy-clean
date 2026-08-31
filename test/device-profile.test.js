import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canUseCleanParams,
  canUseScenes,
  controllerTransport,
  findRobotAllowed,
  supportsRawDps,
} from '../src/device-profile.js';

class LocalConnect {}
class CloudConnect {}
class MqttConnect {}

function controller(Type, novelApi) {
  const value = new Type();
  value.novelApi = novelApi;
  value.DPSMap = { FIND_ROBOT: '103', WORK_MODE: '5' };
  value.sendCommand = async () => {};
  value.sceneClean = async () => {};
  value.setCleanParam = async () => {};
  return value;
}

test('transport is inferred from SDK controller class', () => {
  assert.equal(controllerTransport(controller(LocalConnect, false)), 'local');
  assert.equal(controllerTransport(controller(CloudConnect, false)), 'cloud');
  assert.equal(controllerTransport(controller(MqttConnect, true)), 'mqtt');
});

test('scenes and clean params are novel API features', () => {
  const legacy = controller(LocalConnect, false);
  const modern = controller(MqttConnect, true);
  assert.equal(canUseScenes(legacy), false);
  assert.equal(canUseCleanParams(legacy), false);
  assert.equal(canUseScenes(modern), true);
  assert.equal(canUseCleanParams(modern), true);
});

test('find robot auto mode is conservative and legacy-only', () => {
  assert.equal(findRobotAllowed(controller(LocalConnect, false), 'auto'), true);
  assert.equal(findRobotAllowed(controller(CloudConnect, false), 'auto'), true);
  assert.equal(findRobotAllowed(controller(MqttConnect, true), 'auto'), false);
  assert.equal(findRobotAllowed(controller(MqttConnect, true), 'always'), true);
  assert.equal(findRobotAllowed(controller(LocalConnect, false), 'never'), false);
});

test('raw DPS capability check requires command path and mapped key', () => {
  const legacy = controller(LocalConnect, false);
  assert.equal(supportsRawDps(legacy, 'FIND_ROBOT'), true);
  assert.equal(supportsRawDps(legacy, 'MISSING'), false);
});
