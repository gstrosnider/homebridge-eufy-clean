import crypto from 'node:crypto';

function richness(device) {
  return Object.keys(device?.dps ?? {}).length + (device?.deviceModel ? 2 : 0) + (device?.deviceName ? 1 : 0);
}

/**
 * De-duplicate the same physical RoboVac when upstream discovery returns it
 * through both Tuya Cloud and a synthetic MQTT fallback.  A working Tuya/cloud
 * record is preferred over an MQTT duplicate because it does not depend on
 * AIOT credentials.  MQTT-only devices are preserved.
 */
export function dedupeDiscoveredDevices(devices = []) {
  const byId = new Map();

  for (const device of Array.isArray(devices) ? devices : []) {
    const deviceId = String(device?.deviceId ?? '');
    if (!deviceId) continue;

    const existing = byId.get(deviceId);
    if (!existing) {
      byId.set(deviceId, device);
      continue;
    }

    // Prefer a non-MQTT record when the same device is also present as MQTT.
    // This specifically avoids the upstream "constructing MQTT devices from
    // cloud device list" fallback creating a second, unusable representation.
    if (existing?.mqtt && !device?.mqtt) {
      byId.set(deviceId, device);
      continue;
    }
    if (!existing?.mqtt && device?.mqtt) {
      continue;
    }

    // Same transport: keep whichever record carries more live metadata/DPS.
    if (richness(device) > richness(existing)) {
      byId.set(deviceId, device);
    }
  }

  return [...byId.values()];
}

async function loadSdkInternals() {
  const entry = import.meta.resolve('eufy-clean');
  const [{ EufyLogin }, { TuyaCloudApi }] = await Promise.all([
    import(new URL('./controllers/Login.js', entry).href),
    import(new URL('./api/TuyaCloudApi.js', entry).href),
  ]);
  return { EufyLogin, TuyaCloudApi };
}

/**
 * Account initialization that works around an upstream authentication defect:
 * the SDK previously accepted the first Eufy login token even when that token
 * could not produce user_center_token/gtoken, then attempted AIOT/MQTT with
 * empty credentials.  We try v2 and v1 and only enable MQTT when a complete
 * user-center credential set is available.  Tuya Cloud discovery remains
 * available with a normal Eufy session even when MQTT credentials are absent.
 */
export async function initializeEufyAccount(SDK, username, password, log) {
  const eufy = new SDK.EufyClean(username, password);

  try {
    const { EufyLogin, TuyaCloudApi } = await loadSdkInternals();
    const openudid = crypto.randomBytes(16).toString('hex');
    eufy.openudid = openudid;

    const login = new EufyLogin(username, password, openudid);
    const eufyApi = login.eufyApi;

    let fallbackSession = null;
    let selectedSession = null;
    let selectedUser = null;
    let mqttCredentials = null;
    let selectedLabel = null;

    for (const attempt of [
      { v2: true, label: 'v2 Eufy app' },
      { v2: false, label: 'v1 Eufy Clean app' },
    ]) {
      eufyApi.userInfo = undefined;
      const session = await eufyApi.eufyLogin(attempt.v2);
      if (!session?.access_token) continue;

      fallbackSession ??= { session, label: attempt.label };
      eufyApi.session = session;

      const user = await eufyApi.getUserinfo();
      const hasAiotCredentials = Boolean(
        user?.user_center_id && user?.user_center_token && user?.gtoken,
      );

      if (!hasAiotCredentials) {
        log?.debug?.(`Eufy ${attempt.label} login has no usable AIOT user-center token; trying the alternate login.`);
        continue;
      }

      const mqtt = await eufyApi.getMqttCredentials();
      if (mqtt) {
        selectedSession = session;
        selectedUser = user;
        mqttCredentials = mqtt;
        selectedLabel = attempt.label;
        break;
      }
    }

    if (!selectedSession && fallbackSession) {
      selectedSession = fallbackSession.session;
      selectedLabel = fallbackSession.label;
      eufyApi.session = selectedSession;
      eufyApi.userInfo = undefined;
      log?.info?.(`Eufy authenticated via ${selectedLabel}; AIOT/MQTT credentials are unavailable, so Tuya Cloud/local transports will be used.`);
    }

    if (!selectedSession) {
      throw new Error('Eufy authentication failed for both v2 and v1 login endpoints');
    }

    if (selectedUser && mqttCredentials) {
      eufyApi.session = selectedSession;
      eufyApi.userInfo = selectedUser;
      log?.info?.(`Eufy authenticated via ${selectedLabel} with AIOT/MQTT credentials.`);
    }

    login.mqttCredentials = mqttCredentials;

    // Tuya Cloud uses the Eufy session user id but has its own regional login.
    let tuyaApi = null;
    let sid = null;
    for (const region of ['EU', 'US']) {
      try {
        const candidate = new TuyaCloudApi(username, password, selectedSession.user_id, region);
        const candidateSid = await candidate.login();
        if (candidateSid) {
          tuyaApi = candidate;
          sid = candidateSid;
          log?.info?.(`Tuya Cloud ${region} login successful.`);
          break;
        }
      } catch (error) {
        log?.debug?.(`Tuya Cloud ${region} login failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    login.tuyaApi = tuyaApi;
    login.sid = sid;

    // Populate the same arrays the public EufyClean wrapper expects, but do it
    // without making an AIOT request when no valid MQTT credentials exist.
    try {
      login.eufyApiDevices = await eufyApi.getCloudDeviceList();
    } catch {
      login.eufyApiDevices = [];
    }

    login.cloudDevices = [];
    if (sid && tuyaApi) {
      try {
        const rawCloudDevices = await tuyaApi.getDeviceList();
        login.cloudDevices = (rawCloudDevices ?? []).map((device) => ({
          ...login.findModel(device.devId),
          apiType: login.checkApiType(device?.dps ?? {}),
          mqtt: false,
          dps: device?.dps ?? {},
        }));
      } catch (error) {
        log?.warn?.(`Tuya Cloud device discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    login.mqttDevices = [];
    if (mqttCredentials) {
      try {
        let rawMqttDevices = await eufyApi.getDeviceList();
        rawMqttDevices = Array.isArray(rawMqttDevices) ? rawMqttDevices : [];

        // If AIOT returns no device list, only synthesize devices that are NOT
        // already represented by Tuya Cloud.  This preserves MQTT-only models
        // such as newer Omni vacuums without duplicating legacy devices.
        if (!rawMqttDevices.length && login.eufyApiDevices?.length) {
          const cloudIds = new Set(login.cloudDevices.map((device) => device.deviceId));
          rawMqttDevices = login.eufyApiDevices
            .filter((device) => device?.id && !cloudIds.has(String(device.id)))
            .map((device) => ({ device_sn: device.id, dps: device?.dps ?? {} }));
        }

        login.mqttDevices = rawMqttDevices
          .map((device) => ({
            ...login.findModel(device.device_sn, device),
            apiType: login.checkApiType(device?.dps ?? {}),
            matter: Boolean(device?.is_integrated),
            mqtt: true,
            dps: device?.dps ?? {},
          }))
          .filter((device) => !device.invalid);
      } catch (error) {
        log?.warn?.(`Eufy AIOT/MQTT device discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    eufy.eufyCleanApi = login;
    const discovered = dedupeDiscoveredDevices(await eufy.getAllDevices());

    return {
      eufy,
      discovered,
      mqttAvailable: Boolean(mqttCredentials),
      authenticated: true,
    };
  } catch (error) {
    // Keep a fallback to the public upstream initialization path in case its
    // internal file layout changes in a future release.
    log?.warn?.(`Enhanced Eufy authentication path unavailable; falling back to upstream SDK: ${error instanceof Error ? error.message : String(error)}`);
    await eufy.init();
    return {
      eufy,
      discovered: dedupeDiscoveredDevices(await eufy.getAllDevices()),
      mqttAvailable: Boolean(eufy?.eufyCleanApi?.mqttCredentials),
      authenticated: true,
    };
  }
}
