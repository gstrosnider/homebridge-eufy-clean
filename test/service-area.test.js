import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSelectedRooms, discoverServiceAreas, normalizeConfiguredRooms } from '../src/service-area.js';

test('manual rooms are normalized, de-duplicated and assigned the default map', () => {
  assert.deepEqual(normalizeConfiguredRooms([
    { id: 2, name: 'Kitchen' },
    { id: 1, name: 'Hall' },
    { id: 2, name: 'Kitchen renamed' },
  ], 12), [
    { id: 1, name: 'Hall', mapId: 12 },
    { id: 2, name: 'Kitchen renamed', mapId: 12 },
  ]);
});

test('automatic decoded room data is discovered and manual names override it', async () => {
  const controller = {
    async getMapData() {
      return { mapId: 7, mapName: 'Downstairs', roomParams: [
        { id: 3, name: 'Cookery' },
        { id: 4, name: 'Lounge' },
      ] };
    },
  };
  const result = await discoverServiceAreas(controller, {}, [{ id: 3, name: 'Kitchen', mapId: 7 }]);
  assert.equal(result.source, 'automatic+manual');
  assert.deepEqual(result.maps, [{ mapId: 7, name: 'Downstairs' }]);
  assert.deepEqual(result.rooms, [
    { id: 3, name: 'Kitchen', mapId: 7 },
    { id: 4, name: 'Lounge', mapId: 7 },
  ]);
});

test('future parameter-aware SDK room API receives selected room IDs', async () => {
  let command;
  const controller = {
    async cleanRooms(request) { command = request; },
  };
  await cleanSelectedRooms(controller, [4, 2, 4], 9);
  assert.deepEqual(command, { roomIds: [4, 2], mapId: 9 });
});

test('legacy pinned SDK roomClean is not used because it ignores room IDs', async () => {
  const controller = { async roomClean() { throw new Error('must not be called'); } };
  await assert.rejects(
    () => cleanSelectedRooms(controller, [1], 2),
    /unavailable on this Eufy transport/,
  );
});
