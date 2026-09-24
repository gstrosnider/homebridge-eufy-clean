import { buildDevicePlan, hasLocalCredentials, shouldUseLocal } from './device-plan.js';
import { EufyMatterVacuumAccessory } from './matter-vacuum-accessory.js';
import { EufyVacuumAccessory } from './vacuum-accessory.js';
import { dedupeDiscoveredDevices, initializeEufyAccount } from './eufy-account.js';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';

const DEFAULT_REAUTH_INTERVAL_MINUTES = 12 * 60;
const MIN_REAUTH_INTERVAL_MINUTES = 60;
const MAX_REAUTH_INTERVAL_MINUTES = 7 * 24 * 60;
const REAUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export function isAuthenticationFailure(error) {
  const code = String(error?.code ?? error?.response?.status ?? error?.status ?? '').toLowerCase();
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return [code, message].some((value) => [
    '401',
    '403',
    'auth',
    'credential',
    'expired',
    'forbidden',
    'invalid session',
    'invalid sid',
    'invalid token',
    'login required',
    'must call login',
    'not logged',
    'session invalid',
    'token invalid',
    'unauthorized',
    'user_session_invalid',
  ].some((part) => value.includes(part)));
}

export class EufyCleanPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.cachedAccessories = new Map();
    this.cachedMatterAccessories = new Map();
    this.handlers = new Map();
    this.matterHandlers = new Map();
    this.eufy = null;
    this.accountDiscoverySucceeded = false;
    this.discoveryPromise = null;
    this.reauthTimer = null;
    this.lastReauthAttempt = 0;
    this.reauthHookTargets = new WeakSet();
    this.shuttingDown = false;

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices('startup').finally(() => this.scheduleAccountRefresh());
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.reauthTimer) {
        clearInterval(this.reauthTimer);
        this.reauthTimer = null;
      }
      for (const handler of this.handlers.values()) {
        void handler.shutdown?.();
      }
      for (const handler of this.matterHandlers.values()) {
        void handler.shutdown?.();
      }
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory) {
    this.cachedMatterAccessories.set(accessory.UUID, accessory);
  }

  async discoverDevices(reason = 'manual refresh') {
    if (this.discoveryPromise) return await this.discoveryPromise;
    this.discoveryPromise = this.runDiscovery(reason);
    try {
      return await this.discoveryPromise;
    } finally {
      this.discoveryPromise = null;
    }
  }

  async runDiscovery(reason) {
    const hasUsername = Boolean(this.config.username);
    const hasPassword = Boolean(this.config.password);
    const accountConfigured = hasUsername && hasPassword;

    if (hasUsername !== hasPassword) {
      this.log.warn('Both Eufy username and password are required for account discovery. Local-only devices can still initialize.');
    }

    let discovered = [];
    let SDK;

    try {
      SDK = await import('eufy-clean');
      this.eufy = new SDK.EufyClean(
        accountConfigured ? this.config.username : undefined,
        accountConfigured ? this.config.password : undefined,
      );

      if (accountConfigured) {
        try {
          const account = await initializeEufyAccount(
            SDK,
            this.config.username,
            this.config.password,
            this.config.debug ? this.log : {
              info: this.log.info.bind(this.log),
              warn: this.log.warn.bind(this.log),
              debug: () => {},
            },
          );
          this.eufy = account.eufy;
          this.installAccountFailureHooks(this.eufy?.eufyCleanApi);
          discovered = dedupeDiscoveredDevices(account.discovered);
          if (!Array.isArray(discovered)) {
            throw new Error('eufy-clean returned an invalid device list');
          }
          this.accountDiscoverySucceeded = account.authenticated;
          this.log.info(`Discovered ${discovered.length} usable Eufy Clean device(s) from the account${account.mqttAvailable ? ' (MQTT available)' : ' (Tuya Cloud/local mode)'}.`);
          if (reason !== 'startup') {
            this.log.info(`Eufy account session renewed automatically (${reason}).`);
          }
        } catch (error) {
          this.accountDiscoverySucceeded = false;
          this.log.error(`Eufy account discovery/login failed: ${this.errorMessage(error)}`);
          this.log.warn('Continuing with any manually configured local RoboVac devices.');
        }
      } else {
        this.log.info('Eufy account discovery is disabled; checking for manually configured local RoboVac devices.');
      }

      const { records, skipped } = buildDevicePlan(discovered, this.config.devices ?? []);
      for (const entry of skipped) {
        this.log.warn(
          `Configured device ${entry.deviceId || '(missing deviceId)'} was not discovered and has no complete local configuration (deviceId + ip + localKey); skipping it.`,
        );
      }

      const staleCleanupIsAuthoritative = this.accountDiscoverySucceeded || !accountConfigured;
      const matterRequested = this.config.enableMatter !== false;
      const matterEnabled = matterRequested && this.isMatterReady();

      if (matterRequested && !matterEnabled) {
        this.log.warn('Matter is enabled in the plugin but is not enabled/available on this Homebridge bridge. Falling back to HAP HomeKit switch + battery accessories.');
      }

      let mode = 'hap';
      if (matterEnabled) {
        const matterResult = await this.initializeMatterDevices(records, SDK);
        if (matterResult.success) {
          mode = 'matter';
          await this.removeHapAccessoriesForMatter(matterResult.deviceIds);
          if (staleCleanupIsAuthoritative) {
            this.removeStaleAccessories(new Set());
            await this.removeStaleMatterAccessories(matterResult.liveUuids);
          }
        } else {
          this.log.warn('Matter initialization failed; falling back to HAP for this startup.');
          await this.shutdownMatterHandlers();
          await this.removeNewMatterAccessories(matterResult.newAccessories);
        }
      }

      if (mode === 'hap') {
        const liveHapUuids = new Set();
        for (const plan of records) {
          await this.initializePlannedHapDevice(plan, SDK, liveHapUuids);
        }
        if (staleCleanupIsAuthoritative) {
          this.removeStaleAccessories(liveHapUuids);
        }
        // Cached Matter accessories are automatically restored by Homebridge, so
        // they must be explicitly removed while the plugin is operating in HAP mode.
        await this.removeAllMatterAccessories();
      }

      if (records.length === 0) {
        this.log.warn('No usable Eufy Clean devices were found. Configure account credentials and/or a local device entry.');
      }
    } catch (error) {
      this.log.error(`Unable to load or initialize eufy-clean: ${this.errorMessage(error)}`);
    }
  }

  accountRefreshMinutes() {
    const configured = Number(this.config.reauthInterval ?? DEFAULT_REAUTH_INTERVAL_MINUTES);
    if (configured === 0) return 0;
    if (!Number.isFinite(configured)) return DEFAULT_REAUTH_INTERVAL_MINUTES;
    return Math.max(MIN_REAUTH_INTERVAL_MINUTES, Math.min(MAX_REAUTH_INTERVAL_MINUTES, Math.round(configured)));
  }

  scheduleAccountRefresh() {
    if (this.reauthTimer) {
      clearInterval(this.reauthTimer);
      this.reauthTimer = null;
    }
    if (this.shuttingDown || !this.config.username || !this.config.password) return;

    const minutes = this.accountRefreshMinutes();
    if (minutes === 0) {
      this.log.info('Automatic Eufy account renewal is disabled by reauthInterval=0.');
      return;
    }

    this.log.info(`Eufy account session will renew automatically every ${minutes} minutes.`);
    this.reauthTimer = setInterval(
      () => void this.requestAccountRefresh('scheduled credential renewal', { force: true }),
      minutes * 60 * 1000,
    );
    this.reauthTimer.unref?.();
  }

  async requestAccountRefresh(reason, { force = false } = {}) {
    if (this.shuttingDown || !this.config.username || !this.config.password) return false;
    if (this.discoveryPromise) {
      await this.discoveryPromise;
      return this.accountDiscoverySucceeded;
    }

    const now = Date.now();
    if (!force && now - this.lastReauthAttempt < REAUTH_FAILURE_COOLDOWN_MS) {
      this.log.debug?.(`Eufy reauthentication suppressed by cooldown (${reason}).`);
      return false;
    }
    this.lastReauthAttempt = now;
    this.log.warn(`Eufy credentials need renewal (${reason}); reauthenticating automatically.`);
    await this.discoverDevices(reason);
    return this.accountDiscoverySucceeded;
  }

  installAccountFailureHooks(account) {
    const targets = [
      { value: account, methods: ['getCloudDevice', 'sendCloudCommand', 'getMqttDevice'] },
      { value: account?.tuyaApi, methods: ['getDevice', 'getDeviceList', 'sendCommand'] },
      { value: account?.eufyApi, methods: ['getCloudDeviceList', 'getDeviceList', 'getMqttCredentials'] },
    ];

    for (const { value, methods } of targets) {
      if (
        !value ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        this.reauthHookTargets.has(value)
      ) continue;
      this.reauthHookTargets.add(value);

      for (const method of methods) {
        const original = value[method];
        if (typeof original !== 'function') continue;
        value[method] = async (...args) => {
          try {
            return await original.apply(value, args);
          } catch (error) {
            if (isAuthenticationFailure(error)) {
              const detail = error instanceof Error ? error.message : String(error);
              void this.requestAccountRefresh(`${method}: ${detail}`);
            }
            throw error;
          }
        };
      }
    }
  }

  isMatterReady() {
    return Boolean(
      this.api.isMatterEnabled?.() &&
      this.api.matter &&
      this.api.matter.deviceTypes?.RoboticVacuumCleaner,
    );
  }

  async initializeMatterDevices(records, SDK) {
    const matter = this.api.matter;
    const liveUuids = new Set();
    const deviceIds = new Set();
    const newAccessories = [];
    const preparedHandlers = [];

    try {
      for (const plan of records) {
        const metadata = this.resolvePlanMetadata(plan, SDK);
        if (!metadata || plan.override?.hide) continue;

        const { deviceId, device, override, modelName, displayName } = metadata;
        const uuid = matter.uuid.generate(`eufy-clean-matter:${deviceId}`);

        const controller = await this.createController(plan, displayName);
        if (!controller) continue;

        // Only mark the device live after we have a controller that can actually
        // back the Matter endpoint. This prevents a failed controller from
        // removing a still-working cached HAP fallback accessory.
        liveUuids.add(uuid);
        deviceIds.add(deviceId);

        const previous = this.matterHandlers.get(uuid);
        await previous?.shutdown?.();

        const handler = new EufyMatterVacuumAccessory(this, controller, {
          ...device,
          source: plan.source,
          deviceModelName: modelName,
        }, override, uuid);
        await handler.initialize();
        preparedHandlers.push(handler);
        this.matterHandlers.set(uuid, handler);

        const data = handler.toAccessory();
        const cached = this.cachedMatterAccessories.get(uuid);
        if (cached) {
          cached.displayName = data.displayName;
          cached.context = data.context;
          cached.clusters = data.clusters;
          cached.handlers = data.handlers;
          cached.manufacturer = data.manufacturer;
          cached.model = data.model;
          cached.firmwareRevision = data.firmwareRevision;
          cached.hardwareRevision = data.hardwareRevision;
          await matter.updatePlatformAccessories([cached]);
          this.log.info(`Restored ${displayName} as a Matter RoboticVacuumCleaner.`);
        } else {
          newAccessories.push(data);
          this.cachedMatterAccessories.set(uuid, data);
        }
      }

      if (newAccessories.length > 0) {
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
        this.log.info(`Registered ${newAccessories.length} Eufy Matter RoboticVacuumCleaner accessory/accessories.`);
      }

      for (const handler of preparedHandlers) {
        await handler.markRegistered();
      }

      return { success: true, liveUuids, deviceIds, newAccessories };
    } catch (error) {
      this.log.error(`Matter registration failed: ${this.errorMessage(error)}`);
      return { success: false, liveUuids, deviceIds, newAccessories };
    }
  }

  async initializePlannedHapDevice(plan, SDK, liveUuids) {
    const metadata = this.resolvePlanMetadata(plan, SDK);
    if (!metadata || plan.override?.hide) return;

    const { deviceId, device, override, modelName, displayName } = metadata;
    const uuid = this.api.hap.uuid.generate(`eufy-clean:${deviceId}`);
    liveUuids.add(uuid);

    let accessory = this.cachedAccessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.deviceId = deviceId;
      accessory.context.deviceModel = override.deviceModel || device.deviceModel || '';
      accessory.context.deviceName = displayName;
      accessory.context.source = plan.source;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory);
      this.log.info(`Registered ${displayName} (${deviceId}) using HAP fallback.`);
    } else {
      accessory.context.deviceId = deviceId;
      accessory.context.deviceModel = override.deviceModel || device.deviceModel || accessory.context.deviceModel || '';
      accessory.context.deviceName = displayName;
      accessory.context.source = plan.source;
    }

    try {
      const controller = await this.createController(plan, displayName);
      if (!controller) return;

      const existing = this.handlers.get(uuid);
      await existing?.shutdown?.();

      const handler = new EufyVacuumAccessory(this, accessory, controller, {
        ...device,
        deviceModelName: modelName,
      }, override);
      this.handlers.set(uuid, handler);
      await handler.initialize();
    } catch (error) {
      this.log.error(`Failed to initialize ${displayName}: ${this.errorMessage(error)}`);
    }
  }

  resolvePlanMetadata(plan, SDK) {
    const device = plan.discovery ?? {};
    const override = plan.override ?? {};
    const deviceId = String(device.deviceId ?? override.deviceId ?? '');
    if (!deviceId) return null;

    const modelName = override.deviceModelName ||
      device.deviceModelName ||
      SDK.EUFY_CLEAN_DEVICES?.[override.deviceModel || device.deviceModel] ||
      override.deviceModel ||
      device.deviceModel ||
      'RoboVac';
    const displayName = override.name || device.deviceName || modelName || `Eufy ${deviceId.slice(-6)}`;

    if (this.config.debug) {
      this.log.debug(`${displayName}: plan=${plan.source} model=${String(override.deviceModel || device.deviceModel || 'unknown')} mqtt=${String(device.mqtt ?? 'unknown')} connection=${String(override.connection ?? 'auto')}`);
    }

    return { deviceId, device, override, modelName, displayName };
  }

  async createController(plan, displayName) {
    const device = plan.discovery ?? {};
    const override = plan.override ?? {};
    const deviceId = String(device.deviceId ?? override.deviceId ?? '');
    const initConfig = {
      deviceId,
      deviceModel: override.deviceModel || device.deviceModel || undefined,
      debug: Boolean(this.config.debug),
    };

    if (shouldUseLocal(override)) {
      if (!hasLocalCredentials(override)) {
        throw new Error('connection=local requires deviceId, ip, and localKey');
      }
      initConfig.ip = override.ip;
      initConfig.localKey = override.localKey;
    }

    if (!shouldUseLocal(override) && !this.accountDiscoverySucceeded) {
      this.log.warn(`${displayName}: account transport unavailable because Eufy login/discovery did not succeed.`);
      return null;
    }

    const controller = await this.eufy.initDevice(initConfig);
    if (!controller) {
      this.log.warn(`${displayName}: SDK did not return a controller. Model=${String(initConfig.deviceModel ?? 'unknown')}.`);
      return null;
    }
    return controller;
  }

  async removeHapAccessoriesForMatter(deviceIds) {
    const toRemove = [...this.cachedAccessories.values()].filter((accessory) => deviceIds.has(String(accessory.context?.deviceId ?? '')));
    if (toRemove.length === 0) return;

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
    for (const accessory of toRemove) {
      this.cachedAccessories.delete(accessory.UUID);
      await this.handlers.get(accessory.UUID)?.shutdown?.();
      this.handlers.delete(accessory.UUID);
    }
    this.log.info(`Removed ${toRemove.length} HAP accessory/accessories now represented natively through Matter.`);
  }

  async removeNewMatterAccessories(accessories) {
    if (!this.api.matter || !accessories?.length) return;
    try {
      await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    } catch (error) {
      this.log.debug?.(`Matter cleanup after failed registration ignored: ${this.errorMessage(error)}`);
    }
    for (const accessory of accessories) {
      this.cachedMatterAccessories.delete(accessory.UUID);
    }
  }

  async removeStaleMatterAccessories(liveUuids) {
    if (!this.api.matter) return;
    const stale = [...this.cachedMatterAccessories.values()].filter((accessory) => !liveUuids.has(accessory.UUID));
    if (stale.length === 0) return;

    await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const accessory of stale) {
      this.cachedMatterAccessories.delete(accessory.UUID);
      await this.matterHandlers.get(accessory.UUID)?.shutdown?.();
      this.matterHandlers.delete(accessory.UUID);
    }
    this.log.info(`Removed ${stale.length} stale Eufy Matter accessory/accessories.`);
  }

  async removeAllMatterAccessories() {
    if (!this.api.matter || this.cachedMatterAccessories.size === 0) return;
    const all = [...this.cachedMatterAccessories.values()];
    try {
      await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, all);
    } catch (error) {
      this.log.warn(`Failed to remove cached Matter accessories while using HAP fallback: ${this.errorMessage(error)}`);
      return;
    }

    for (const accessory of all) {
      this.cachedMatterAccessories.delete(accessory.UUID);
      await this.matterHandlers.get(accessory.UUID)?.shutdown?.();
      this.matterHandlers.delete(accessory.UUID);
    }
    this.log.info(`Removed ${all.length} Matter accessory/accessories while operating in HAP mode.`);
  }

  async shutdownMatterHandlers() {
    for (const handler of this.matterHandlers.values()) {
      await handler.shutdown?.();
    }
    this.matterHandlers.clear();
  }

  removeStaleAccessories(liveUuids) {
    const stale = [...this.cachedAccessories.values()].filter((accessory) => !liveUuids.has(accessory.UUID));
    if (stale.length === 0) return;

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const accessory of stale) {
      this.cachedAccessories.delete(accessory.UUID);
      void this.handlers.get(accessory.UUID)?.shutdown?.();
      this.handlers.delete(accessory.UUID);
    }
    this.log.info(`Removed ${stale.length} stale Eufy Clean HAP accessory/accessories.`);
  }

  errorMessage(error) {
    if (error instanceof Error) {
      return error.stack || error.message;
    }
    return String(error);
  }
}
