# SFTP Synchronisation Tool

Implements a push syncronisation with Dry-Run. Performs the following tasks:

1. Upload new files
2. Delete remote files that no longer exist locally
3. Identify changes based on size or altered content and upload them

Why?

Reliability was mega important to me, so that for example  no orphaned documents are left on the server and only the parts that have changed are actually updated.

- I use the script to transfer [Hugo websites](https://gohugo.io) to the server.
- This is part of the [Hugo-Toolbox](https://www.npmjs.com/package/hugo-toolbox).

Features:

- multiple connections in `sync.config.json`
- `dry-run` mode
- mirrors local → remote
- adds, updates, deletes files
- text diff detection
- Binary files (images, video, audio, PDF, etc.): SHA-256 hash comparison
- Hashes are cached in `.sync-cache.*.ndjson`
- Parallel uploads/deletions via worker pool
- Parallel remote directory listings via configurable scan worker pool
- include/exclude patterns
- Sidecar uploads / downloads - Bypassing the sync process

The file `sftp-push-sync.mjs` is pure JavaScript (ESM). Node.js can execute it directly as long as `"type": "module"` is specified in `package.json` or the file has the extension `.mjs`.

## News

- Latest Version: `4.0.0` - Damit ist er "Feature Complete".
- I’ve improved the loading-bar and made tons of stability, performance improvements in the latest Updates, [see also CHANGELOG.md](https://github.com/cnichte/sftp-push-sync/blob/main/CHANGELOG.md).

### Breaking changes in 3.0.0

- New Cache Mechanism: NDJSON instead of JSON.
- The cache can now handle any number of files.

### Breaking changes in 2.0.0

- The flags `--upload-list` / `--download-list` have been replaced by
  `--sidecar-upload` / `--sidecar-download`.
- The settings for sidecars are now located in the `sidecar` block of the connection.

## Install

```bash
npm i -D sftp-push-sync
# or
npm install --save-dev sftp-push-sync
# or
yarn add --dev sftp-push-sync
# or
pnpm add -D sftp-push-sync
```

## Setup

Create a `sync.config.json` in the root folder of your project:

```json
{
  "connections": {
    "prod": {
      "host": "your.host.net",
      "port": 23,
      "user": "ftpuser",
      "password": "mypassword",
      "syncCache": ".sync-cache.prod.json",
      "workerUpload": 3,
      "workerList": 5,
      "sync": {
        "localRoot": "public",
        "remoteRoot": "/folder/"
      },
      "sidecar": {
        "localRoot": "sidecar-local",
        "remoteRoot": "/sidecar-remote/",
        "uploadList": [],
        "downloadList": []
      }
    },
    "staging": {
      "host": "ftpserver02",
      "port": 22,
      "user": "ftp_user",
      "password": "total_secret",
      "syncCache": ".sync-cache.staging.json",
      "workerUpload": 1,
      "workerList": 5,
      "sync": {
        "localRoot": "public",
        "remoteRoot": "/web/my-page/"
      },
      "sidecar": {
        "localRoot": "sidecar-local",
        "remoteRoot": "/sidecar-remote/",
        "uploadList": [],
        "downloadList": []
      }
    }
  },
  "parallelScan": true,
  "cleanupEmptyDirs": true,
  "include": [],
  "exclude": ["**/.DS_Store", "**/.git/**", "**/node_modules/**"],
  "textExtensions": [".shtml",".xml",".txt",".json",".js",".css",".md",".svg"],
  "mediaExtensions": [".jpg",".jpeg",".png",".webp",".gif",".avif",".tif",".tiff",".mp4",".mov",".m4v","mp3",".wav",".flac"],
  "progress": {
    "scanChunk": 10,
    "analyzeChunk": 1
  },
  "logLevel": "normal",
  "logTimestamps": false,
  "logFile": ".sftp-push-sync.{target}.log"
}
```

### CLI Usage

```bash
# Normal synchronisation
node bin/sftp-push-sync.mjs staging

# Normal synchronisation + sidecar upload list
node bin/sftp-push-sync.mjs staging --sidecar-upload

# Normal synchronisation + sidecar download list
node bin/sftp-push-sync.mjs staging --sidecar-download

# Only sidecar lists, no standard synchronisation
node bin/sftp-push-sync.mjs staging --skip-sync --sidecar-upload
node bin/sftp-push-sync.mjs staging --skip-sync --sidecar-download

# (optional) only run lists dry
node bin/sftp-push-sync.mjs staging --skip-sync --sidecar-upload --dry-run
```

- Can be conveniently started via the scripts in `package.json`:

```bash
# For example
npm run sync:staging
# or short
npm run ss
```

If you have stored the scripts in `package.json` as follows:

```json

"scripts": {
    "sync:staging": "sftp-push-sync staging",
    "sync:staging:dry": "sftp-push-sync staging --dry-run",
    "ss": "npm run sync:staging",
    "ssd": "npm run sync:staging:dry",

    "sync:prod": "sftp-push-sync prod",
    "sync:prod:dry": "sftp-push-sync prod --dry-run",
    "sp": "npm run sync:prod",
    "spd": "npm run sync:prod:dry",
  },
```

The dry run is a great way to compare files and fill the cache.

### How ist works

There are 7 steps to follow:

- Phase 1: Scan local files
- Phase 2: Scan remote files
- Phase 3: Compare & Decide
- Phase 4: Removing orphaned remote files
- Phase 5: Preparing remote directories
- Phase 6: Apply changes
- Phase 7: Cleaning up empty remote directories

Phases 1 and 2 can optionally be executed in parallel. Phase 2 uses `workerList` parallel remote directory listings. Phase 6 uses `workerUpload` parallel file operations for uploads/deletions. The old `worker` setting is still accepted as a fallback for `workerUpload`.

### Sidecar uploads / downloads

A list of files that are excluded from the sync comparison and can be downloaded or uploaded separately.

- `sidecar.uploadList`
  - Relative to sidecar.localRoot, e.g. "downloads.json" or "data/downloads.json"
- `sidecar.downloadList`
  - Relative to sidecar.remoteRoot, e.g. "download-counter.json" or "logs/download-counter.json"

```bash
# normal synchronisation
sftp-push-sync staging

# Normal synchronisation + explicitly transfer sidecar upload list
sftp-push-sync staging --sidecar-upload

# just fetch the sidecar download list from the server
# combined with normal synchronisation
sftp-push-sync prod --sidecar-download --dry-run   # view first
sftp-push-sync prod --sidecar-download             # then do
```

- The sidecar is always executed together with sync when using `--sidecar-download` or `--sidecar-upload`.
- With `--skip-sync`, you can exclude the sync process and only process the sidecar:

```bash
sftp-push-sync prod --sidecar-download --skip-sync
```

### Logging Progress

Logging can also be configured.

- `logLevel` - normal, verbose, laconic.
- `logTimestamps` - true/false. When enabled, each log line is prefixed with a timestamp `[YYYY-MM-DD HH:mm:ss.SSS]`.
- `logFile` - an optional logFile.
- `workerUpload` - How many upload/delete operations may run in parallel for one connection?
- `workerList` - How many remote directories may be listed in parallel during Phase 2? Default: 5.
- `scanChunk` - After how many elements should a log output be generated during scanning?
- `analyzeChunk` - After how many elements should a log output be generated during analysis?

For >100k files, use analyzeChunk = 10 or 50, otherwise the TTY output itself is a relevant factor.

### Progress output

The normal progress view stays compact and shows up to three active remote-listing workers. Use `--verbose` to show all configured listing workers and additional phase details.

For change lists with more than 20 added or updated files, normal mode prints a count instead of every path. Use `--verbose` when the complete file list is needed.

After scanning and comparing, the sync plan reports local and remote file counts, planned changes, upload size, workload category, and a rough transfer-time range. The estimate is intentionally a band rather than an exact ETA because server latency and connection quality can dominate the actual duration.

During operations, progress bars show the current rate and ETA where a total is known. Counters, ETA, rate, state, and compare-phase fields reserve fixed display widths so terminal lines do not shift while values change. Large binary comparisons additionally show a per-file MB/s rate. The final summary includes completed phase durations and identifies the slowest phase.

Use `--size-only` only when matching file sizes are sufficient for your workflow. Equal-size files are treated as unchanged and content hashes are skipped; files with different sizes are still uploaded.

If a run is interrupted, a target-specific `.sync-recovery.<target>.json` file records the last active phase, task progress, and completed paths. The next run reports this state and re-checks affected files safely. Paths confirmed by the fresh comparison are not scheduled again. Recovery data is removed after a successful sync; it does not cause files to be skipped blindly.

This includes byte-level continuation of a partially uploaded temporary file when the target server supports it.

Run `sftp-push-sync <target> --check-resume-support` to test append, remote-size verification, read-back, and rename support on a target server. The check uses uniquely named temporary files below the configured remote root and removes them afterwards. It does not run a sync.

When this capability check passes, an interrupted upload keeps its own temporary remote file. The next run verifies its saved target path, expected local size, and actual remote size before uploading only the remaining bytes. Missing, oversized, or inconsistent temporary files automatically fall back to a complete atomic upload.

Uploads use a temporary file in the target directory and rename it only after the transfer completes. On servers that do not allow renaming over an existing file, the old target is first moved to a temporary backup and restored if the replacement fails. An interrupted upload therefore does not replace the previous target file; temporary files are cleaned up when possible and are treated as remote orphans on the next sync if necessary.

### Wildcards

Examples for Wirdcards for `include`, `exclude`, `uploadList` and `downloadList`:

- `"content/**"` -EVERYTHING below `content/`
- `".html", ".htm", ".md", ".txt", ".json"`- Only certain file extensions
- `"**/*.html"` - all HTML files
- `"**/*.md"`- all Markdown files
- `"content/**/*.md"` - only Markdown in `content/`
- `"static/images/**/*.jpg"`
- `"**/thumb-*.*"` - thumb images everywhere
- `"**/*-draft.*"` -Files with -draft before the extension
- `"content/**/*.md"` - all Markdown files
- `"config/**"` - complete configuration
- `"static/images/covers/**"`- cover images only
- `"logs/**/*.log"` - all logs from logs/
- `"reports/**/*.xlsx"`

practical excludes:

```txt
"exclude": [
  ".git/**",           // kompletter .git Ordner
  ".idea/**",          // JetBrains
  "node_modules/**",   // Node dependencies
  "dist/**",           // Build Output
  "**/*.map",          // Source Maps
  "**/~*",             // Emacs/Editor-Backups (~Dateien)
  "**/#*#",            // weitere Editor-Backups
  "**/.DS_Store"       // macOS Trash
]
```

### Folder handling

Sync only handles files and creates missing directories during upload.
However, it should also manage directories:

- They should (optionally) be removed if:
  - for example, a directory is empty because all files have been deleted from it.
  - or if a directory no longer exists locally.

## Which files are needed?

- `sync.config.json` - The configuration file (with passwords in plain text, so please leave it out of the git repository)

## Which files are created?

- The cache files: `.sync-cache.*.ndjson`. The old ones can be deleted: `.sync-cache.*.json`
- The log file: `.sftp-push-sync.{target}.log` (Optional, overwritten with each run)

You can safely delete the local cache at any time. The first analysis will then take longer, because remote hashes will be streamed again. After that, everything will run fast.

- Note 1: The first run always takes a while, especially with lots of media – so be patient! Once the cache is full, it will be faster.
- Note 2: Reliability and accuracy are more important to me than speed.

## Example Output

Please wait – the GIF will take a few seconds to load...

![An console output example](https://github.com/cnichte/sftp-push-sync/blob/main/images/sftp-push-sync-run-example.gif)

## Links

- <https://www.npmjs.com/package/sftp-push-sync>
- <https://github.com/cnichte/sftp-push-sync>
- <https://www.npmjs.com/package/hugo-toolbox>
- <https://carsten-nichte.de>
