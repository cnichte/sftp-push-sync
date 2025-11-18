# Changelog

## [2.0.0] - 2025-11-18

### Breaking

- CLI flags renamed:
  - `--upload-list` → `--sidecar-upload`
  - `--download-list` → `--sidecar-download`
- Configuration per connection restructured:
  - `localRoot` / `remoteRoot` now under `sync`
  - `sidecar` block for sidecar uploads/downloads

### Added

- Separate `sidecar.localRoot` / `sidecar.remoteRoot` für Upload-/Download-Listen.

---
