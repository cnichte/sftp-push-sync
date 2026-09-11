# sftp-push-sync

Reliable local-to-remote SFTP synchronization for websites and other project directories. The package mirrors a local directory to an SFTP server, uploads new and changed files, removes remote files that no longer exist locally, and can clean up empty remote directories.

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

## How it works

The sync engine scans local and remote files, compares content using configured rules and cached hashes, creates a synchronization plan, prepares remote directories, applies changes, and cleans up empty directories. Uploads use temporary files in the target directory and replace the target only after a successful transfer. Recovery state is kept for interrupted long-running jobs.

Relative local paths are resolved relative to the directory containing `sync.config.json`. Remote paths are resolved on the SFTP server.

## Example Output

Please wait – the GIF will take a few seconds to load...

![An console output example](https://github.com/cnichte/sftp-push-sync/blob/main/images/sftp-push-sync-run-example.gif)

## VeloSync desktop app

VeloSync is the Electron desktop application built on the same sync engine. It provides structured progress views, connection and group management, job history, dry runs, connection testing, sidecar controls, and macOS, Windows, and Linux releases.

- Anyone who doesn’t particularly like working via the terminal will soon be able to do the same using the `VeloSync` App. The app will run on Linux, Windows and MacOS.

![Screenshot VeloSync App Benutzeroberfläche](https://github.com/cnichte/sftp-push-sync/blob/main/images/velosync-app-001.jpg?raw=true)

## Documentation

- [VeloSync user manual](https://github.com/cnichte/sftp-push-sync/tree/main/docs)
- [Repository](https://github.com/cnichte/sftp-push-sync)
- [Changelog](https://github.com/cnichte/sftp-push-sync/blob/main/CHANGELOG.md)
- [VeloSync releases](https://github.com/cnichte/sftp-push-sync/releases)

## License

GPL-3.0-or-later
