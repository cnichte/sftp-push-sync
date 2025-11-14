# SFTP Synchronisation Tool

Implements a push syncronisation with Dry-Run. Performs the following tasks:

1. Upload new files
2. Delete remote files that no longer exist locally
3. Identify changes based on size or altered content and upload them
   
Features:
 - multiple connections in sync.config.json
 - dry-run mode
 - mirrors local → remote
 -  adds, updates, deletes files
 - text diff detection
 - Binary files (images, video, audio, PDF, etc.): SHA-256 hash comparison
 - Hashes are cached in .sync-cache.json to save space.
 - Parallel uploads/deletions via worker pool
 - include/exclude patterns
  
The file shell-scripts/sync-sftp.mjs is pure JavaScript (ESM), not TypeScript. Node.js can execute it directly as long as "type": "module" is specified in package.json or the file has the extension .mjs.

## Config file

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
  ]
}
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
    "sync:staging": "node ./shell-scripts/sync-sftp.mjs staging",
    "sync:staging:dry": "node ./shell-scripts/sync-sftp.mjs staging --dry-run",
    "ss": "npm run sync:staging",
    "ssd": "npm run sync:staging:dry",

    "sync:prod": "node ./shell-scripts/sync-sftp.mjs prod",
    "sync:prod:dry": "node ./shell-scripts/sync-sftp.mjs prod --dry-run",
    "sp": "npm run sync:prod",
    "spd": "npm run sync:prod:dry",
  },
```

The dry run is a great way to compare files and fill the cache.

Which files are included?

- `shell-scripts/sync-sftp.mjs` - The upload script (for details, see the script)
- `sync.config.json`- The configuration file (with passwords in plain text, so please leave it out of the git repository)
- The cache files: `.sync-cache.*.json`

You can safely delete the local cache at any time. The first analysis will then take longer again (because remote hashes will be streamed again). After that, everything will run extremely fast again.
