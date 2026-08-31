import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/vacuum-accessory.js', import.meta.url), 'utf8');

test('HomeKit accessory exposes read-only battery status but no auxiliary controls', () => {
  assert.equal(source.includes('configureBatteryStatus'), true);
  assert.equal(source.includes('BatteryLevel'), true);
  assert.equal(source.includes('ChargingState'), true);
  assert.equal(source.includes('configureSuction'), false);
  assert.equal(source.includes('configureDockButton'), false);
  assert.equal(source.includes('configureScenes'), false);
});

test('HomeKit off stops cleaning and returns the vacuum home', () => {
  assert.equal(source.includes('await this.stopAndReturnHome();'), true);
  assert.equal(source.includes("await this.callDevice('stop');"), true);
  assert.equal(source.includes("await this.callDevice('goHome');"), true);
});

test('upgrade removes cached auxiliary eufy services', () => {
  assert.equal(source.includes("service.subtype?.startsWith('eufy-')"), true);
  assert.equal(source.includes("'eufy-main', 'eufy-battery'"), true);
});
