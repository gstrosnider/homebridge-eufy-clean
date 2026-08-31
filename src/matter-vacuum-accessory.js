import { controllerTransport, isNovelDevice } from './device-profile.js';

const RVC_STATE = Object.freeze({
  STOPPED: 0,
  RUNNING: 1,
  PAUSED: 2,
  ERROR: 3,
  SEEKING_CHARGER: 64,
  CHARGING: 65,
  DOCKED: 66,
});

const RVC_RUN_MODE = Object.freeze({
  IDLE: 0,
  CLEANING: 1,
});

const RUNNING_WORDS = [
  'clean', 'cleaning', 'auto', 'room', 'spot', 'zone', 'sweep', 'mop', 'running', 'working', 'resume', 'cruising',
];

/**
 * Native Homebridge Matter RoboticVacuumCleaner wrapper for an eufy-clean
 * controller. It deliberately implements a conservative Matter surface:
 * start/idle, pause/resume, return home, operational state and battery.
 */
export class EufyMatterVacuumAccessory {
  constructor(platform, controller, discoveryRecord, override, uuid) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.matter = platform.api.matter;
    this.config = platform.config;
    this.device = controller;
    this.discoveryRecord = discoveryRecord ?? {};
    this.override = override ?? {};
    this.UUID = uuid;
    this.name = this.override.name || this.discoveryRecord.deviceName || `Eufy ${String(this.discoveryRecord.deviceId ?? '').slice(-6)}`;
    this.transport = controllerTransport(controller);
    this.timer = null;
    this.registered = false;
    this.refreshing = false;
    this.accessoryData = null;
    this.lastSnapshot = null;
  }

  async initialize() {
    if (!this.matter?.deviceTypes?.RoboticVacuumCleaner) {
      throw new Error('Homebridge Matter RoboticVacuumCleaner device type is unavailable');
    }

    await this.device.connect();
    this.lastSnapshot = await this.readSnapshot(true);
    this.accessoryData = this.buildAccessory(this.lastSnapshot);

    const apiGeneration = isNovelDevice(this.device) ? 'novel' : 'legacy';
    this.log.info(
      `${this.name}: prepared native Matter RoboticVacuumCleaner using ${this.device.constructor?.name ?? 'eufy-clean controller'} ` +
      `(${this.transport}, ${apiGeneration} API).`,
    );
  }

  toAccessory() {
    if (!this.accessoryData) {
      throw new Error('Matter accessory has not been initialized');
    }
    return this.accessoryData;
  }

  async markRegistered() {
    this.registered = true;
    await this.publishState(this.lastSnapshot ?? await this.readSnapshot(false));

    const seconds = Math.max(10, Number(this.override.pollInterval ?? this.config.pollInterval ?? 30));
    this.timer = setInterval(() => void this.refreshState(), seconds * 1000);
    this.timer.unref?.();
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
      this.log.debug?.(`${this.name}: Matter disconnect ignored: ${this.errorMessage(error)}`);
    }
  }

  buildAccessory(snapshot) {
    const deviceId = String(this.discoveryRecord.deviceId ?? this.override.deviceId ?? 'eufy-robovac');
    const serialNumber = deviceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || deviceId.slice(0, 32);
    const model = this.discoveryRecord.deviceModelName || this.override.deviceModelName ||
      this.discoveryRecord.deviceModel || this.override.deviceModel || 'RoboVac';
    const firmwareRevision = String(
      this.discoveryRecord.softwareVersion ??
      this.discoveryRecord.software_version ??
      this.discoveryRecord.firmwareRevision ??
      '1.0.0',
    );

    return {
      UUID: this.UUID,
      displayName: this.name,
      deviceType: this.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber,
      manufacturer: 'Eufy / Anker',
      model,
      firmwareRevision,
      hardwareRevision: '1.0.0',
      context: {
        deviceId,
        deviceModel: this.discoveryRecord.deviceModel || this.override.deviceModel || '',
        source: this.accessorySource(),
      },
      clusters: {
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: RVC_RUN_MODE.IDLE, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: RVC_RUN_MODE.CLEANING, modeTags: [{ value: 16385 }] },
          ],
          currentMode: snapshot.runMode,
        },
        rvcCleanMode: {
          supportedModes: [
            { label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: RVC_STATE.STOPPED },
            { operationalStateId: RVC_STATE.RUNNING },
            { operationalStateId: RVC_STATE.PAUSED },
            { operationalStateId: RVC_STATE.ERROR },
            { operationalStateId: RVC_STATE.SEEKING_CHARGER },
            { operationalStateId: RVC_STATE.CHARGING },
            { operationalStateId: RVC_STATE.DOCKED },
          ],
          operationalState: snapshot.operationalState,
        },
        powerSource: {
          status: snapshot.batteryLevel == null ? 0 : 1,
          order: 0,
          description: 'Battery',
          batPercentRemaining: snapshot.batteryLevel == null ? 0 : snapshot.batteryLevel * 2,
          batChargeLevel: snapshot.batteryLevel == null ? 0 : this.batteryChargeLevel(snapshot.batteryLevel),
          batReplaceability: 1,
        },
      },
      handlers: {
        rvcRunMode: {
          changeToMode: async (request) => await this.handleRunMode(request),
        },
        rvcOperationalState: {
          pause: async () => await this.handlePause(),
          resume: async () => await this.handleResume(),
          goHome: async () => await this.handleGoHome(),
        },
      },
    };
  }

  accessorySource() {
    return this.discoveryRecord.source || this.override.source || 'eufy-clean';
  }

  async handleRunMode(request) {
    const mode = Number(request?.newMode ?? request?.mode ?? -1);
    if (mode === RVC_RUN_MODE.CLEANING) {
      await this.startAuto();
      return { status: 0 };
    }
    if (mode === RVC_RUN_MODE.IDLE) {
      await this.stopAndReturnHome();
      return { status: 0 };
    }
    this.log.warn(`${this.name}: Matter requested unsupported run mode ${String(mode)}.`);
    return { status: 1 };
  }

  async handlePause() {
    this.log.info(`${this.name}: Matter pause.`);
    if (typeof this.device.pause === 'function') {
      await this.callDevice('pause');
    } else {
      await this.callDevice('stop');
    }
    await this.refreshSoon();
    return { errorStateId: 0 };
  }

  async handleResume() {
    this.log.info(`${this.name}: Matter resume.`);
    if (typeof this.device.play === 'function') {
      await this.callDevice('play');
    } else {
      await this.startAuto(false);
    }
    await this.refreshSoon();
    return { errorStateId: 0 };
  }

  async handleGoHome() {
    this.log.info(`${this.name}: Matter return home.`);
    await this.stopAndReturnHome();
    return { errorStateId: 0 };
  }

  async startAuto(refresh = true) {
    this.log.info(`${this.name}: Matter start cleaning.`);
    if (typeof this.device.autoClean === 'function') {
      await this.device.autoClean();
    } else {
      await this.callDevice('play');
    }
    if (refresh) {
      await this.refreshSoon();
    }
  }

  async stopAndReturnHome() {
    this.log.info(`${this.name}: Matter stop cleaning and return home.`);
    try {
      if (typeof this.device.stop === 'function') {
        await this.callDevice('stop');
      } else if (typeof this.device.pause === 'function') {
        await this.callDevice('pause');
      }
    } catch (error) {
      this.log.warn(`${this.name}: Matter stop/pause failed before return home: ${this.errorMessage(error)}`);
    }

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
      const snapshot = await this.readSnapshot(true);
      this.lastSnapshot = snapshot;
      await this.publishState(snapshot);

      if (this.config.debug) {
        this.log.debug(
          `${this.name}: Matter transport=${this.transport} status=${snapshot.status} ` +
          `runMode=${snapshot.runMode} operationalState=${snapshot.operationalState} battery=${String(snapshot.batteryLevel)}`,
        );
      }
    } catch (error) {
      this.log.warn(`${this.name}: Matter status refresh failed: ${this.errorMessage(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  async readSnapshot(updateDevice) {
    if (updateDevice && typeof this.device.updateDevice === 'function') {
      await this.device.updateDevice(false);
    }

    const status = await this.getStatus();
    const running = await this.getRunningState(status);
    const operationalState = this.operationalState(status, running);
    const runMode = running ? RVC_RUN_MODE.CLEANING : RVC_RUN_MODE.IDLE;
    let batteryLevel = null;

    if (typeof this.device.getBatteryLevel === 'function') {
      try {
        const numeric = Number(await this.device.getBatteryLevel());
        if (Number.isFinite(numeric)) {
          batteryLevel = Math.max(0, Math.min(100, Math.round(numeric)));
        }
      } catch (error) {
        this.log.debug?.(`${this.name}: Matter battery read failed: ${this.errorMessage(error)}`);
      }
    }

    return { status, running, operationalState, runMode, batteryLevel };
  }

  async publishState(snapshot) {
    if (!this.registered || !this.matter) return;

    await this.matter.updateAccessoryState(this.UUID, 'rvcRunMode', {
      currentMode: snapshot.runMode,
    });
    await this.matter.updateAccessoryState(this.UUID, 'rvcOperationalState', {
      operationalState: snapshot.operationalState,
    });

    if (snapshot.batteryLevel != null) {
      await this.matter.updateAccessoryState(this.UUID, 'powerSource', {
        status: 1,
        batPercentRemaining: snapshot.batteryLevel * 2,
        batChargeLevel: this.batteryChargeLevel(snapshot.batteryLevel),
      });
    }
  }

  batteryChargeLevel(level) {
    return level <= 10 ? 2 : level <= 20 ? 1 : 0;
  }

  operationalState(status, running) {
    const normalized = String(status ?? '').toLowerCase();
    if (normalized.includes('fault') || normalized.includes('error')) return RVC_STATE.ERROR;
    if (normalized.includes('charging') || normalized === 'charge') return RVC_STATE.CHARGING;
    if (normalized.includes('go_home') || normalized.includes('go home') || normalized.includes('recharge')) return RVC_STATE.SEEKING_CHARGER;
    if (normalized.includes('paused') || normalized === 'pause') return RVC_STATE.PAUSED;
    if (running) return RVC_STATE.RUNNING;
    if (normalized.includes('completed') || normalized.includes('docked') || normalized.includes('standby')) return RVC_STATE.DOCKED;
    return RVC_STATE.STOPPED;
  }

  async getRunningState(status = null) {
    if (!isNovelDevice(this.device) && typeof this.device.getPlayPause === 'function') {
      try {
        const playPause = await this.device.getPlayPause();
        if (typeof playPause === 'boolean') return playPause;
      } catch {
        // Fall through to status normalization.
      }
    }

    const normalized = String(status ?? await this.getStatus()).toLowerCase();
    return RUNNING_WORDS.some((word) => normalized.includes(word));
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

  errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
}
