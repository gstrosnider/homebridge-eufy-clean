# Changelog

## 0.3.3

- Added explicit npm `maintainers` metadata for `gstrosnider` in addition to the package author.
- Linked creator metadata to `https://github.com/gstrosnider`.
- Linked package homepage, repository, and issue metadata to `https://github.com/gstrosnider/homebridge-eufy-clean`.
- Prepared metadata for Homebridge UI author attribution after the package is published to npm under the `gstrosnider` maintainer account.
- No Eufy transport, HomeKit, or Matter behavior changes.


## 0.3.2

- Renamed the package from `homebridge-eufy-clean-next` to `homebridge-eufy-clean`.
- Updated the display name to **Homebridge Eufy Clean**.
- Added canonical GitHub repository, homepage, and issue-tracker metadata for `gstrosnider/homebridge-eufy-clean`.
- Kept the Homebridge platform alias `EufyCleanNext` unchanged for configuration compatibility with existing installations.
- No Eufy transport, HomeKit, or Matter behavior changes.

## 0.3.1

- Set the package author/creator to `gstrosnider` with GitHub profile `https://github.com/gstrosnider`.
- Updated the MIT license copyright attribution to `gstrosnider`.
- Added an explicit Creator section to the README.
- No runtime, Eufy transport, HomeKit, or Matter behavior changes from 0.3.0.

## 0.3.0

- Added native Homebridge Matter support using the Matter `RoboticVacuumCleaner` device type.
- Added `supports-matter` package metadata and an `enableMatter` configuration option (default `true`).
- Matter mode exposes Start, Idle/Return Home, Pause, Resume, Return Home, operational state, and battery status.
- Matter Power Source reports battery percentage and low-battery level.
- Preserved the 0.2.5 HAP switch + read-only battery implementation as an automatic fallback.
- Added cached Matter accessory restoration/update support through `configureMatterAccessory`.
- Prevented HAP and Matter duplicates by removing the inactive protocol representation after successful startup.
- Added automatic HAP fallback when Matter is disabled, unavailable, or fails to register.
- Preserved Cloud/MQTT and legacy Tuya/local Eufy transports.

## 0.2.5

- Added a standard read-only HomeKit Battery service to each vacuum.
- Battery service reports percentage, charging state, and low-battery status.
- Battery is informational and contains no writable/control characteristic.
- Preserved the single Start/Return Home switch as the only controllable HomeKit service.
