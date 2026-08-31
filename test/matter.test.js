import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const matterSource = await readFile(new URL('../src/matter-vacuum-accessory.js', import.meta.url), 'utf8');
const platformSource = await readFile(new URL('../src/platform.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));

test('package declares native Matter transport support', () => {
  assert.equal(pkg.version, '0.3.3');
  assert.equal(pkg.keywords.includes('supports-hap'), true);
  assert.equal(pkg.keywords.includes('supports-matter'), true);
  assert.equal(pkg.author?.name, 'gstrosnider');
  assert.equal(pkg.author?.url, 'https://github.com/gstrosnider');
});

test('Matter is enabled by default but remains configurable', () => {
  assert.equal(schema.schema.properties.enableMatter.default, true);
  assert.equal(platformSource.includes('this.config.enableMatter !== false'), true);
  assert.equal(platformSource.includes('this.api.isMatterEnabled?.()'), true);
});

test('native robotic vacuum device type and core RVC clusters are present', () => {
  assert.equal(matterSource.includes('deviceTypes.RoboticVacuumCleaner'), true);
  assert.equal(matterSource.includes('rvcRunMode'), true);
  assert.equal(matterSource.includes('rvcCleanMode'), true);
  assert.equal(matterSource.includes('rvcOperationalState'), true);
  assert.equal(matterSource.includes('powerSource'), true);
});

test('Matter controls include start pause resume and return home', () => {
  assert.equal(matterSource.includes('handleRunMode'), true);
  assert.equal(matterSource.includes('handlePause'), true);
  assert.equal(matterSource.includes('handleResume'), true);
  assert.equal(matterSource.includes('handleGoHome'), true);
  assert.equal(matterSource.includes("await this.callDevice('goHome');"), true);
});

test('Matter off/idle returns the vacuum home', () => {
  assert.equal(matterSource.includes('await this.stopAndReturnHome();'), true);
  assert.equal(matterSource.includes('mode === RVC_RUN_MODE.IDLE'), true);
});

test('platform tracks cached Matter accessories and falls back to HAP', () => {
  assert.equal(platformSource.includes('configureMatterAccessory(accessory)'), true);
  assert.equal(platformSource.includes('registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories)'), true);
  assert.equal(platformSource.includes('Matter initialization failed; falling back to HAP'), true);
});

import { EufyMatterVacuumAccessory } from '../src/matter-vacuum-accessory.js';

function mockMatterPlatform(controller) {
  const calls = [];
  const matter = {
    uuid: { generate: (value) => `uuid:${value}` },
    deviceTypes: { RoboticVacuumCleaner: { name: 'RVC' } },
    updateAccessoryState: async (uuid, cluster, attributes) => calls.push({ uuid, cluster, attributes }),
  };
  const log = { info() {}, warn() {}, debug() {} };
  const platform = {
    log,
    api: { matter },
    config: { pollInterval: 30, debug: false },
  };
  return { platform, calls, controller };
}

test('Matter accessory builds battery and operational state from a controller', async () => {
  class CloudConnect {
    constructor() { this.novelApi = false; }
    async connect() {}
    async updateDevice() {}
    async getWorkStatus() { return 'charging'; }
    async getPlayPause() { return false; }
    async getBatteryLevel() { return 73; }
    async disconnect() {}
  }
  const controller = new CloudConnect();
  const { platform } = mockMatterPlatform(controller);
  const accessory = new EufyMatterVacuumAccessory(
    platform,
    controller,
    { deviceId: 'abc123', deviceName: 'Test Vac', deviceModelName: 'G40+' },
    {},
    'uuid:test',
  );
  await accessory.initialize();
  const data = accessory.toAccessory();
  assert.equal(data.deviceType.name, 'RVC');
  assert.equal(data.clusters.powerSource.batPercentRemaining, 146);
  assert.equal(data.clusters.rvcOperationalState.operationalState, 65);
  await accessory.shutdown();
});

test('Matter Idle command stops then docks', async () => {
  const calls = [];
  class CloudConnect {
    constructor() { this.novelApi = false; }
    async connect() {}
    async updateDevice() {}
    async getWorkStatus() { return 'running'; }
    async getPlayPause() { return true; }
    async getBatteryLevel() { return 50; }
    async stop() { calls.push('stop'); }
    async goHome() { calls.push('goHome'); }
    async disconnect() {}
  }
  const controller = new CloudConnect();
  const { platform } = mockMatterPlatform(controller);
  const accessory = new EufyMatterVacuumAccessory(
    platform,
    controller,
    { deviceId: 'abc123', deviceName: 'Test Vac' },
    {},
    'uuid:test',
  );
  await accessory.initialize();
  // Avoid the post-command poll in this behavioral unit test.
  accessory.refreshSoon = async () => {};
  const result = await accessory.handleRunMode({ newMode: 0 });
  assert.deepEqual(calls, ['stop', 'goHome']);
  assert.equal(result.status, 0);
  await accessory.shutdown();
});
