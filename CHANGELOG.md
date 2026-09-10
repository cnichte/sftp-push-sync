# Changelog

## [4.0.0] - 2026-09-10

With version `4.0.0`, the app is ‘feature complete’, unless I can think of any new features. From now on, there will only be bug fixes.

- Progress output now includes phase durations, rates, ETA, workload estimates, and cache hit statistics.
- Graceful shutdown persists a per-target recovery state with the last active phase and task progress.
- A subsequent run reports interrupted state and safely re-checks affected files instead of skipping them blindly.
- Normal progress output stays compact; `--verbose` shows all configured scan workers.
- Added explicit `--size-only` mode for workflows where equal file size is sufficient; different-size files are still uploaded.
- Recovery state now records completed paths and reports operations confirmed by the next comparison as not scheduled again.
- Uploads now use same-directory temporary files and a final rename to avoid replacing target files with partial transfers.
- Added a backup-and-restore fallback for SFTP servers which reject renaming over an existing target.
- The fallback now runs only for existing-target rename errors and treats backup cleanup failure as a warning after a successful replacement.
- Added byte-level resume for interrupted uploads through verified same-directory temporary files on servers that pass the capability check.
- Added `--check-resume-support` to verify append, remote-size, read-back, and rename support without running a sync.
- Reserved fixed progress field widths to prevent terminal lines from shifting as counters, ETA, rates, and states change.

## [3.0.5] - 2026-09-09

- Scan-Phase 1 + 2 accelerated
  - The `worker` property is now called `workerUpload`, which describes more precisely what is happening here: it defines the number of parallel workers for the upload.
  - Similarly, there is now a property for the `FTP.list()` command: `workerList`. This sets the number of parallel `list` calls.
  
As each FTP server has different limits on the number of parallel requests it allows, you will need to determine the appropriate values by trial and error. The whole thing is backwards compatible: the `worker` property continues to work as workerUpload.

What does this change achieve? Take 43048 files, for example:

- 1 Worker Duration: 21:07 (1267.2s)
- 5 Worker Duration: 9:17 (557.9s)

## [3.0.4] - 2026-09-09

- compare phase improved with WorkerPool.

## [3.0.3] - 2026-09-09

- Progress bar improved
- Phases in the hash comparison bar
- Speeding up the clean-up of orphaned folders
- Every now and then, an upload would be terminated with ^c at the start of Phase 1 because VS Code was interfering – this has now (hopefully) been fixed.

## [3.0.2] - 2026-03-05

- stability improvements especialy during large and longtime uploads, error handling, log with datetime.

## [3.0.0] - 2026-03-04

- Switched from JSON-file based hash cache to NDJSON-based Cache-implementation.
- Disk-based, only active entries in RAM
- Scales to 100,000+ files without memory issues
- Auto-persist (no explicit saving required)
- Auto-migration - Existing JSON cache is automatically migrated

## [2.5.0] - 2026-03-04

- Parallel remote walker walkers.mjs: scans 8 directories simultaneously
- Batch analysis with concurrency compare.mjs: 8 file comparisons in parallel
- Parallel hash calculation: local + remote hash simultaneously
- Keep-alive: SftpPushSyncApp.mjs prevents server disconnection. A Keep-Alive packet is sent every 10 seconds.

## [2.1.0] - 2025-11-19

Sync only handles files and creates missing directories during upload.
However, it should also manage directories:

- They should (optionally) be removed if:
  - for example, a directory is empty because all files have been deleted from it.
  - or if a directory no longer exists locally.

This is now taken into account with the option: `cleanupEmptyDirs`.

## [2.0.0] - 2025-11-18

### Breaking

- CLI flags renamed:
  - `--upload-list` → `--sidecar-upload`
  - `--download-list` → `--sidecar-download`
- Configuration per connection restructured:
  - `localRoot` / `remoteRoot` now under `sync`
  - `sidecar` block for sidecar uploads/downloads

### Added

- Separate `sidecar.localRoot` / `sidecar.remoteRoot` for Upload-/Download-Lists.

---
