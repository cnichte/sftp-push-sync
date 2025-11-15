# SFTP Synchronisation Tool

Implements a push syncronisation with Dry-Run. Performs the following tasks:

1. Upload new files
2. Delete remote files that no longer exist locally
3. Identify changes based on size or altered content and upload them

I use the script to transfer [Hugo websites](https://gohugo.io) to the server.

Features:

- multiple connections in `sync.config.json`
- `dry-run` mode
- mirrors local → remote
- adds, updates, deletes files
- text diff detection
- Binary files (images, video, audio, PDF, etc.): SHA-256 hash comparison
- Hashes are cached in .sync-cache.json to save space.
- Parallel uploads/deletions via worker pool
- include/exclude patterns
- special uploads / downloads

The file `sftp-push-sync.mjs` is pure JavaScript (ESM), not TypeScript. Node.js can execute it directly as long as "type": "module" is specified in package.json or the file has the extension .mjs.

## Install

```bash
npm i sftp-push-sync
```

## Config file

Create a `sync.config.json` in the root folder of your project:

```json
{
  "connections": {
    "prod": {
      "host": "your.host.net",
      "port": 23,
      "user": "ftpuser",
      "password": "mypassword",
      "remoteRoot": "/folder/",
      "localRoot": "public",
      "syncCache": ".sync-cache.prod.json",
      "worker": 3
    },
    "staging": {
      "host": "ftpserver02",
      "port": 22,
      "user": "ftp_user",
      "password": "total_secret",
      "remoteRoot": "/web/my-page/",
      "localRoot": "public",
      "syncCache": ".sync-cache.staging.json",
      "worker": 1
    }
  },
  "include": [],
  "exclude": [
    "**/.DS_Store",
    "**/.git/**",
    "**/node_modules/**"
  ],
  "textExtensions": [
    ".html", ".xml", ".txt", ".json", ".js", ".css", ".md", ".svg"
  ],
  "uploadList": [],
  "downloadList": [
    "download-counter.json"
  ]
}
```

### special uploads / downloads

A list of files that are excluded from the sync comparison and can be downloaded or uploaded separately.

- `uploadList`
  - Relative to localRoot "downloads.json"
  - or with subfolders: "data/downloads.json"
- `downloadList`
  - Relative to remoteRoot "download-counter.json"
  - or e.g. "logs/download-counter.json"


```bash
# normal synchronisation
sftp-push-sync staging

# Normal synchronisation + explicitly transfer upload list
sftp-push-sync staging --upload-list

# just fetch the download list from the server (combined with normal synchronisation)
sftp-push-sync prod --download-list --dry-run   # view first
sftp-push-sync prod --download-list             # then do
```

## NPM Scripts

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

## Which files are needed?

- `sync.config.json` - The configuration file (with passwords in plain text, so please leave it out of the git repository)

## Which files are created?

- The cache files: `.sync-cache.*.json`

You can safely delete the local cache at any time. The first analysis will then take longer again (because remote hashes will be streamed again). After that, everything will run fast.

The first run always takes a while, especially with lots of images – so be patient! Once the cache is full, it will be faster.

## Example Output

![An console output example](images/example-output-001.png)

## Links

- <https://www.npmjs.com/package/sftp-push-sync>
- <https://github.com/cnichte/sftp-push-sync>