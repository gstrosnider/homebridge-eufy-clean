# Homebridge Eufy Clean

Version 0.3.3 provides native Homebridge Matter support with HAP fallback and canonical project attribution to **@gstrosnider**.

## Creator

Created and maintained by **[@gstrosnider](https://github.com/gstrosnider)**.

Project repository: **https://github.com/gstrosnider/homebridge-eufy-clean**

This plugin builds on the community `eufy-clean` SDK and related Eufy integration research; those upstream projects retain their own authorship and licenses.

## Exposure modes

### Matter — preferred when available

When all of the following are true:

1. `enableMatter` is not set to `false` (default is `true`),
2. Homebridge is v2.x with its Matter API available, and
3. Matter is enabled for the main bridge or this plugin's child bridge,

Homebridge Eufy Clean registers each vacuum as a native Matter **RoboticVacuumCleaner**.

The Matter accessory exposes:

- Start cleaning
- Idle/Off → stop/pause and return to dock
- Pause
- Resume
- Return Home
- Running / Paused / Seeking Charger / Charging / Docked / Error operational states
- Battery percentage and low-battery level through the Matter Power Source cluster
- One conservative clean mode: Vacuum

Room selection, scenes, maps, suction presets, mop settings, consumables, and dock-station controls are intentionally not included in 0.3.0.

### HAP/HomeKit fallback

If Matter is disabled, unavailable, or registration fails, the plugin falls back automatically to the existing HomeKit representation:

- **One Switch** — On starts automatic cleaning; Off stops/pauses and returns the vacuum to its dock.
- **Read-only Battery status** — Battery Level, Charging State, and Low-Battery Status.

## Configuration

```json
{
  "platform": "EufyCleanNext",
  "name": "Eufy Clean",
  "username": "you@example.com",
  "password": "your-eufy-password",
  "enableMatter": true,
  "pollInterval": 30,
  "debug": false
}
```

Older/local vacuums can continue to use per-device `deviceId`, `ip`, `localKey`, and `connection: "local"` configuration exactly as in 0.2.x.

## Enabling Matter in Homebridge

Matter must also be enabled on the Homebridge bridge where this plugin runs. Use the Homebridge UI to enable Matter for the main bridge or for the plugin's child bridge, then restart Homebridge.

On a Matter-enabled startup, the log should contain messages similar to:

```text
Registered 2 Eufy Matter RoboticVacuumCleaner accessory/accessories.
Jeeves: prepared native Matter RoboticVacuumCleaner ...
Dobby: prepared native Matter RoboticVacuumCleaner ...
```

If Matter is not enabled, the plugin logs that it is falling back to HAP.

## Switching protocols

0.3.3 avoids publishing the same physical vacuum through HAP and Matter at the same time:

- Successful Matter registration removes the corresponding cached HAP accessory.
- HAP fallback removes cached Matter accessories so Homebridge does not restore a stale duplicate.

Changing protocol can require re-pairing/reorganizing the accessory in Apple Home because HAP and Matter are different accessory transports.

## Matter caveat

Homebridge Matter is community implemented and not CSA certified. Controller behavior for Matter robotic vacuums is still evolving. If Apple Home shows unstable Matter behavior, set `enableMatter` to `false` to return to the HAP switch+battery representation.
