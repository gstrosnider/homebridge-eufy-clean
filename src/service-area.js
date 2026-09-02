const ROOM_CONTAINER_KEYS = [
  'rooms', 'roomList', 'room_list', 'roomParams', 'room_params', 'segments', 'data',
];

const MAP_CONTAINER_KEYS = [
  'maps', 'mapList', 'map_list', 'mapData', 'map_data', 'mapInfo', 'map_info',
  'currentMap', 'current_map', 'curMapRoom', 'cur_map_room',
];

function integer(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function first(object, keys) {
  for (const key of keys) {
    if (object?.[key] != null) return object[key];
  }
  return undefined;
}

function addRoom(target, value, fallbackMapId = null) {
  if (!value || typeof value !== 'object') return;
  const id = integer(first(value, ['id', 'roomId', 'room_id', 'segmentId', 'segment_id', 'areaId', 'area_id']));
  if (id == null) return;
  const nameValue = first(value, ['name', 'roomName', 'room_name', 'label']);
  const name = String(nameValue ?? `Room ${id}`).trim() || `Room ${id}`;
  const mapId = integer(first(value, ['mapId', 'map_id'])) ?? fallbackMapId;
  target.set(id, { id, name, mapId });
}

function inspectContainer(value, rooms, maps, fallbackMapId = null, depth = 0) {
  if (!value || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      addRoom(rooms, item, fallbackMapId);
      inspectContainer(item, rooms, maps, fallbackMapId, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  const mapId = integer(first(value, ['mapId', 'map_id', 'id'])) ?? fallbackMapId;
  const mapName = first(value, ['mapName', 'map_name']);
  if (mapId != null && (mapName != null || ROOM_CONTAINER_KEYS.some((key) => key in value) || MAP_CONTAINER_KEYS.some((key) => key in value))) {
    maps.set(mapId, String(mapName ?? `Map ${mapId}`).trim() || `Map ${mapId}`);
  }

  for (const key of ROOM_CONTAINER_KEYS) {
    const list = value[key];
    if (Array.isArray(list)) {
      for (const room of list) addRoom(rooms, room, mapId);
    }
  }
  for (const key of MAP_CONTAINER_KEYS) {
    if (value[key] != null) inspectContainer(value[key], rooms, maps, mapId, depth + 1);
  }
}

export function normalizeConfiguredRooms(configured = [], defaultMapId = null) {
  const rooms = new Map();
  for (const room of Array.isArray(configured) ? configured : []) {
    addRoom(rooms, room, integer(room?.mapId) ?? integer(defaultMapId));
  }
  return [...rooms.values()].sort((a, b) => a.id - b.id);
}

/**
 * Collect decoded room metadata exposed by current or future eufy-clean
 * transports. Raw encrypted/base64 map streams are intentionally ignored.
 */
export async function discoverServiceAreas(controller, discoveryRecord = {}, configuredRooms = [], configuredMapId = null) {
  const rooms = new Map();
  const maps = new Map();
  const candidates = [discoveryRecord, controller?.rooms, controller?.roomList, controller?.mapData];

  for (const method of ['getRooms', 'getRoomList', 'getMapData', 'getMaps', 'getRobovacData']) {
    if (typeof controller?.[method] !== 'function') continue;
    try {
      candidates.push(await controller[method]());
    } catch {
      // Discovery is optional; callers log the final fallback decision.
    }
  }

  for (const candidate of candidates) inspectContainer(candidate, rooms, maps);

  const automaticallyDiscovered = rooms.size;
  const manual = normalizeConfiguredRooms(configuredRooms, configuredMapId);
  for (const room of manual) rooms.set(room.id, room);

  for (const room of rooms.values()) {
    if (room.mapId != null && !maps.has(room.mapId)) maps.set(room.mapId, `Map ${room.mapId}`);
  }
  const defaultMap = integer(configuredMapId);
  if (defaultMap != null && !maps.has(defaultMap)) maps.set(defaultMap, `Map ${defaultMap}`);

  return {
    rooms: [...rooms.values()].sort((a, b) => a.id - b.id),
    maps: [...maps.entries()].map(([mapId, name]) => ({ mapId, name })).sort((a, b) => a.mapId - b.mapId),
    source: manual.length ? (automaticallyDiscovered ? 'automatic+manual' : 'manual') : (automaticallyDiscovered ? 'automatic' : 'none'),
  };
}

let sdkEncode;

async function loadSdkEncode() {
  if (sdkEncode) return sdkEncode;
  const entry = import.meta.resolve('eufy-clean');
  ({ encode: sdkEncode } = await import(new URL('./lib/utils.js', entry).href));
  return sdkEncode;
}

/** Send a selected-room command using the protocol bundled by eufy-clean. */
export async function cleanSelectedRooms(controller, roomIds, mapId = null) {
  const ids = [...new Set(roomIds.map(integer).filter((id) => id != null))];
  if (!ids.length) throw new Error('At least one valid room ID is required');

  if (controller?.novelApi === true && typeof controller?.sendCommand === 'function' && controller?.DPSMap?.PLAY_PAUSE != null) {
    const encode = await loadSdkEncode();
    const value = await encode('proto/cloud/control.proto', 'ModeCtrlRequest', {
      method: 1,
      selectRoomsClean: {
        rooms: ids.map((id, index) => ({ id, order: index + 1 })),
        cleanTimes: 1,
        ...(integer(mapId) != null ? { mapId: integer(mapId) } : {}),
        mode: 0,
      },
    });
    return await controller.sendCommand({ [controller.DPSMap.PLAY_PAUSE]: value });
  }

  // Future SDK versions may add a parameter-aware public method. The pinned
  // v1.0.1 implementation accepts no parameters, so do not call it here: doing
  // so would start an unconstrained room clean.
  if (typeof controller?.cleanRooms === 'function') {
    return await controller.cleanRooms({ roomIds: ids, mapId: integer(mapId) });
  }
  throw new Error('Selected-room cleaning is unavailable on this Eufy transport/API generation');
}
