import { controllerTransport, isNovelDevice } from './device-profile.js';

const RUNNING_WORDS = [
  'clean', 'cleaning', 'auto', 'room', 'spot', 'zone', 'sweep', 'mop', 'running', 'working', 'resume', 'cruising',
];
const STOPPED_WORDS = [
  'paused', 'pause', 'charging', 'charge', 'standby', 'idle', 'sleep', 'sleeping', 'docked', 'dock', 'completed',
  'recharge', 'go home', 'go_home', 'stopped', 'stop', 'fault',
];

export class EufyVacuumAccessory {
  constructor(platform, accessory, controller, discoveryRecord, override) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.config = platform.config;
    this.accessory = accessory;
    this.device = controller;
    this.discoveryRecord = discoveryRecord ?? {};
    this.override = override ?? {};
    this.timer = null;
    this.refreshing = false;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.name = this.override.name || this.discoveryRecord.deviceName || accessory.context.deviceName || accessory.displayName;
    this.transport = controllerTransport(controller);
  }

  async initialize() {
    await this.device.connect();

    this.configureInformation();
    this.removeAuxiliaryServices();
    this.configureMainService();
    this.configureBatteryStatus();

    await this.refreshState();
    const seconds = Math.max(10, Number(this.override.pollInterval ?? this.config.pollInterval ?? 30));
    this.timer = setInterval(() => void this.refreshState(), seconds * 1000);
    this.timer.unref?.();

    const apiGeneration = isNovelDevice(this.device) ? 'novel' : 'legacy';
    this.log.info(
      `${this.name}: connected using ${this.device.constructor?.name ?? 'eufy-clean controller'} ` +
      `(${this.transport}, ${apiGeneration} API). HomeKit exposes Start/Return Home plus read-only battery status.`,
    );
  }

  async shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    try {
      if (typeof this.device?.disconnect === 'function') {
        await this.device.disconnect();
      }
    } catch (error) {
      this.log.debug?.(`${this.name}: disconnect ignored: ${this.errorMessage(error)}`);
    }
  }

  configureInformation() {
    const info = this.accessory.getService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'Eufy / Anker')
      .setCharacteristic(
        this.Characteristic.Model,
        this.discoveryRecord.deviceModelName || this.discoveryRecord.deviceModel || this.accessory.context.deviceModel || 'RoboVac',
      )
      .setCharacteristic(this.Characteristic.SerialNumber, String(this.accessory.context.deviceId));
  }

  removeAuxiliaryServices() {
    // Keep only the primary Start/Return Home switch and the read-only battery
    // status service. Remove feature services cached by older versions without
    // requiring the user to remove and re-pair the accessory.
    const keep = new Set(['eufy-main', 'eufy-battery']);
    for (const service of [...this.accessory.services]) {
      if (service.subtype?.startsWith('eufy-') && !keep.has(service.subtype)) {
        this.accessory.removeService(service);
      }
    }
  }

  configureMainService() {
    const subtype = 'eufy-main';
    const desiredUuid = this.Service.Switch.UUID;

    // v0.2.0-v0.2.2 allowed Fanv2 as the main service. Replace it with the
    // simpler Switch service when upgrading.
    for (const service of [...this.accessory.services]) {
      if (service.subtype === subtype && service.UUID !== desiredUuid) {
        this.accessory.removeService(service);
      }
    }

    this.mainService = this.getOrAdd(this.Service.Switch, this.name, subtype);
    this.mainService.getCharacteristic(this.Characteristic.On)
      .onGet(async () => await this.getRunningState())
      .onSet(async (value) => {
        if (Boolean(value)) {
          await this.startAuto();
        } else {
          await this.stopAndReturnHome();
        }
      });

    this.mainService.setPrimaryService?.(true);
  }


  configureBatteryStatus() {
    // Homebridge 2/HAP-NodeJS calls this Service.Battery. Older HAP builds used
    // BatteryService, so retain the fallback for Homebridge 1.x compatibility.
    const BatteryService = this.Service.Battery ?? this.Service.BatteryService;
    if (!BatteryService) {
      this.log.warn(`${this.name}: this Homebridge/HAP version has no Battery service; battery status will be omitted.`);
      this.batteryService = null;
      return;
    }

    this.batteryService = this.getOrAdd(BatteryService, `${this.name} Battery`, 'eufy-battery');

    // Battery has no writable/control characteristic. These handlers are all
    // read-only and are also updated by the normal polling loop.
    this.batteryService.getCharacteristic(this.Characteristic.BatteryLevel)
      .onGet(async () => await this.getBatteryLevel());

    this.batteryService.getCharacteristic(this.Characteristic.ChargingState)
      .onGet(async () => await this.getChargingState());

    this.batteryService.getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(async () => {
        const level = await this.getBatteryLevel();
        return level < 20
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });
  }

  async startAuto() {
    this.log.info(`${this.name}: start cleaning.`);
    if (typeof this.device.autoClean === 'function') {
      await this.device.autoClean();
    } else {
      await this.callDevice('play');
    }
    await this.refreshSoon();
  }

  async stopAndReturnHome() {
    this.log.info(`${this.name}: stop cleaning and return home.`);

    // Stop or pause first when supported so both legacy Tuya and newer
    // controllers transition cleanly out of their active cleaning task. A
    // failure here is non-fatal: the important HomeKit Off action is still to
    // attempt goHome().
    try {
      if (typeof this.device.stop === 'function') {
        await this.callDevice('stop');
      } else if (typeof this.device.pause === 'function') {
        await this.callDevice('pause');
      }
    } catch (error) {
      this.log.warn(`${this.name}: stop/pause failed before return home: ${this.errorMessage(error)}`);
    }

    // Give legacy controllers a brief moment to accept the state transition
    // before issuing the dock command.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.callDevice('goHome');
    await this.refreshSoon();
  }

  async callDevice(method) {
    const fn = this.device?.[method];
    if (typeof fn !== 'function') {
      throw new Error(`eufy-clean controller does not implement ${method}()`);
    }
    return await fn.call(this.device);
  }

  async refreshSoon() {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await this.refreshState();
  }

  async refreshState() {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      if (typeof this.device.updateDevice === 'function') {
        await this.device.updateDevice(false);
      }

      const running = await this.getRunningState();
      this.mainService?.updateCharacteristic(this.Characteristic.On, running);
      await this.refreshBatteryStatus();

      if (this.config.debug) {
        const status = await this.getStatus();
        this.log.debug(
          `${this.name}: transport=${this.transport} novel=${String(isNovelDevice(this.device))} ` +
          `status=${String(status)} running=${String(running)}`,
        );
      }
    } catch (error) {
      this.log.warn(`${this.name}: status refresh failed: ${this.errorMessage(error)}`);
    } finally {
      this.refreshing = false;
    }
  }


  async refreshBatteryStatus() {
    if (!this.batteryService) return;

    try {
      const level = await this.getBatteryLevel();
      const chargingState = await this.getChargingState();
      const lowBattery = level < 20
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

      this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, level);
      this.batteryService.updateCharacteristic(this.Characteristic.ChargingState, chargingState);
      this.batteryService.updateCharacteristic(this.Characteristic.StatusLowBattery, lowBattery);
    } catch (error) {
      // Battery reporting must never interfere with Start/Return Home control.
      this.log.debug?.(`${this.name}: battery status refresh failed: ${this.errorMessage(error)}`);
    }
  }

  async getBatteryLevel() {
    if (typeof this.device?.getBatteryLevel !== 'function') {
      throw new Error('eufy-clean controller does not expose battery level');
    }

    const raw = await this.device.getBatteryLevel();
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
      throw new Error(`invalid battery level: ${String(raw)}`);
    }

    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  async getChargingState() {
    const status = await this.getStatus();
    const charging = status.includes('charging') || status === 'charge' || status.includes('recharge');
    return charging
      ? this.Characteristic.ChargingState.CHARGING
      : this.Characteristic.ChargingState.NOT_CHARGING;
  }

  async getRunningState() {
    // Legacy Tuya devices expose PLAY_PAUSE as a boolean and this is generally
    // more reliable than interpreting model-specific status strings.
    if (!isNovelDevice(this.device) && typeof this.device.getPlayPause === 'function') {
      try {
        const playPause = await this.device.getPlayPause();
        if (typeof playPause === 'boolean') return playPause;
      } catch {
        // Fall through to status normalization.
      }
    }

    return this.isRunning(await this.getStatus());
  }

  async getStatus() {
    if (typeof this.device.getWorkStatus === 'function') {
      const status = await this.device.getWorkStatus();
      if (status != null) return String(status).toLowerCase();
    }

    if (typeof this.device.getWorkMode === 'function') {
      const mode = await this.device.getWorkMode();
      if (mode != null) return String(mode).toLowerCase();
    }

    return '';
  }

  isRunning(status) {
    const normalized = String(status ?? '').toLowerCase();
    if (STOPPED_WORDS.some((word) => normalized.includes(word))) return false;
    return RUNNING_WORDS.some((word) => normalized.includes(word));
  }

  getOrAdd(ServiceType, name, subtype) {
    return this.accessory.getServiceById(ServiceType, subtype) || this.accessory.addService(ServiceType, name, subtype);
  }

  errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
}
