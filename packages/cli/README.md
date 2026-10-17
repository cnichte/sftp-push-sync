# CatoPushSync CLI

Reliable local-to-remote SFTP synchronization for websites and other project directories. The package mirrors a local directory to an SFTP server, uploads new and changed files, removes remote files that no longer exist locally, and can clean up empty remote directories.

The legacy command `sftp-push-sync` remains available. New installations can also use the product command `cato-push-sync`.

## Install

```bash
npm install --save-dev sftp-push-sync
```

Or install it globally:

```bash
npm install --global sftp-push-sync
```

## Configuration

Create a `sync.config.json` in your project directory:

```json
{
  "connections": {
    "staging": {
      "host": "sftp.example.net",
      "port": 22,
      "user": "sftp-user",
      "password": "do-not-commit-this-file",
      "workerUpload": 3,
      "workerList": 5,
      "sync": {
        "localRoot": "public",
        "remoteRoot": "/website/"
      },
      "sidecar": {
        "localRoot": "sidecar-local",
        "remoteRoot": "/sidecar/",
        "uploadList": [],
        "downloadList": []
      }
    }
  },
  "parallelScan": true,
  "cleanupEmptyDirs": true,
  "exclude": ["**/.DS_Store", "**/.git/**", "**/node_modules/**"],
  "logFile": ".sftp-push-sync.{target}.log"
}
```

Keep credentials out of public repositories. The `password` field is retained for compatibility; use a secret manager or the system keychain for production workflows.

## Usage

```bash
# Normal synchronization
sftp-push-sync staging

# Show the plan without changing the server
sftp-push-sync staging --dry-run

# Run sidecar transfers together with synchronization
sftp-push-sync staging --sidecar-upload
sftp-push-sync staging --sidecar-download

# Run only sidecar transfers
sftp-push-sync staging --skip-sync --sidecar-upload
sftp-push-sync staging --skip-sync --sidecar-download

# Check server support for resumable uploads and rename operations
sftp-push-sync staging --check-resume-support
```

The CLI also supports `--verbose`, `--laconic`, and `--size-only` for output and comparison control.

## Local file-copy (development version)

Local profiles require `transport: "local"`, `stateFile`, and a `sync` block
containing `sourceRoot`, `targetRoot` and an explicit `mode`.
Use `mirror` for an exclusive target root whose entire content follows the
source, including deletions. Use `managed` for a partial project export which
must preserve unrelated files and track its own published files.

```bash
cato-push-sync vault-archive --dry-run --plan-file ./approved-plan.json
# Review the complete JSON plan, then:
cato-push-sync vault-archive --apply-plan ./approved-plan.json
```

Existing source/target and state-parent directories are required. All profile
paths resolve against the configuration file; CLI plan-file paths resolve
against the shell working directory. Plan and state files must stay outside
both content roots. A missing source is an error, not a deletion request.
Local writes without an approved plan are rejected. Local copies include hidden
files and do not use global SFTP filters or sidecar lists.

Transfers are atomic per file, **not for the entire tree**. Failed runs report
completed operations and checkpoint ownership for replanning; they do not
promise rollback or automatic crash recovery. Symlinks, special files,
file/directory replacements and ambiguous case/Unicode paths are rejected.
New copies use restrictive permissions; original filesystem attributes are
not preserved. Local profile editing in the desktop app is not implemented.

See the [complete local transport contract and library API](https://github.com/cnichte/sftp-push-sync#local-file-copy).

## SFTP execution

The sync engine scans local and remote files, compares content using configured rules and cached hashes, creates a synchronization plan, prepares remote directories, applies changes, and cleans up empty directories. Uploads use temporary files in the target directory and replace the target only after a successful transfer. Recovery state is kept for interrupted long-running jobs.

Relative local paths are resolved relative to the directory containing `sync.config.json`. Remote paths are resolved on the SFTP server.

## Example Output

Please wait – the GIF will take a few seconds to load...

![An console output example](https://github.com/cnichte/sftp-push-sync/blob/main/images/sftp-push-sync-run-example.gif)

## CatoPushSync desktop app

CatoPushSync is the Electron desktop application built on the same sync engine. It provides structured progress views, connection and group management, job history, dry runs, connection testing, sidecar controls, and macOS, Windows, and Linux releases.

- Anyone who doesn’t particularly like working via the terminal will soon be able to do the same using the `CatoPushSync` App. The app will run on Linux, Windows and MacOS.

![Screenshot CatoPushSync App Benutzeroberfläche](https://github.com/cnichte/sftp-push-sync/blob/main/images/catopushsync-app-001.jpg?raw=true)

## Documentation

- [CatoPushSync user manual](https://github.com/cnichte/sftp-push-sync/tree/main/docs)
- [Repository](https://github.com/cnichte/sftp-push-sync)
- [Changelog](https://github.com/cnichte/sftp-push-sync/blob/main/CHANGELOG.md)
- [CatoPushSync releases](https://github.com/cnichte/sftp-push-sync/releases)

## License

GPL-3.0-or-later
