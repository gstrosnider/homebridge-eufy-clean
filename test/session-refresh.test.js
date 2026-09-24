import test from 'node:test';
import assert from 'node:assert/strict';
import { EufyCleanPlatform, isAuthenticationFailure } from '../src/platform.js';

function mockPlatform(config = {}) {
  const events = new Map();
  const messages = [];
  const log = {
    info: (message) => messages.push(['info', message]),
    warn: (message) => messages.push(['warn', message]),
    error: (message) => messages.push(['error', message]),
    debug: (message) => messages.push(['debug', message]),
  };
  const api = { on: (event, handler) => events.set(event, handler) };
  return { platform: new EufyCleanPlatform(log, config, api), events, messages };
}

test('authentication failures recognize Eufy/Tuya session expiry without matching ordinary network errors', () => {
  assert.equal(isAuthenticationFailure(new Error('USER_SESSION_INVALID')), true);
  assert.equal(isAuthenticationFailure({ response: { status: 401 } }), true);
  assert.equal(isAuthenticationFailure(new Error('Must call login() first.')), true);
  assert.equal(isAuthenticationFailure(new Error('connect ETIMEDOUT')), false);
});

test('account renewal defaults to twelve hours, supports disable, and clamps short intervals', () => {
  assert.equal(mockPlatform({}).platform.accountRefreshMinutes(), 720);
  assert.equal(mockPlatform({ reauthInterval: 0 }).platform.accountRefreshMinutes(), 0);
  assert.equal(mockPlatform({ reauthInterval: 5 }).platform.accountRefreshMinutes(), 60);
});

test('runtime account hooks request automatic renewal on an expired session', async () => {
  const { platform } = mockPlatform({ username: 'user', password: 'pass' });
  let reason = '';
  platform.requestAccountRefresh = async (value) => { reason = value; return true; };
  const account = {
    async getCloudDevice() { throw new Error('USER_SESSION_INVALID'); },
  };

  platform.installAccountFailureHooks(account);
  await assert.rejects(() => account.getCloudDevice('vacuum'), /USER_SESSION_INVALID/);
  assert.match(reason, /getCloudDevice.*USER_SESSION_INVALID/);
});

test('runtime hooks inspect the underlying Tuya error before the SDK rewrites it', async () => {
  const { platform } = mockPlatform({ username: 'user', password: 'pass' });
  let reason = '';
  platform.requestAccountRefresh = async (value) => { reason = value; return true; };
  const account = {
    tuyaApi: {
      async getDevice() { throw new Error('invalid sid'); },
    },
  };

  platform.installAccountFailureHooks(account);
  await assert.rejects(() => account.tuyaApi.getDevice('vacuum'), /invalid sid/);
  assert.match(reason, /getDevice.*invalid sid/);
});

test('concurrent discovery requests share one account login', async () => {
  const { platform } = mockPlatform({ username: 'user', password: 'pass' });
  let calls = 0;
  let release;
  platform.runDiscovery = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
  };

  const first = platform.discoverDevices('first');
  const second = platform.discoverDevices('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
});
