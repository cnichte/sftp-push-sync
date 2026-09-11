# VeloSync User Manual

VeloSync is a desktop application for reliable SFTP synchronization from a local project directory to a server. It is available for macOS, Windows, and Linux and is based on the `sftp-push-sync` synchronization engine.

## What does VeloSync do?

- Upload new files
- Delete remote files that no longer exist locally
- Clean up empty or orphaned remote directories
- Detect changes using file size and content
- Transfer only files that actually changed
- Upload and download sidecar files separately
- Run multiple independent connections in parallel

Reliability is the central design goal: remote files should not be left behind accidentally, and a synchronization should update only what really changed.

VeloSync does not rely exclusively on timestamps. Text files are compared according to the configured rules; binary files such as images, videos, audio files, and PDFs are checked using SHA-256 hashes. Hashes are stored in a local cache so later runs can be faster.

### VeloSync phases

1. Connect to the SFTP server
2. Scan local and remote files
3. Compare files and create a synchronization plan
4. Prepare remote directories
5. Transfer files and delete remote files that no longer exist locally
6. Clean up empty remote directories

The local and remote scans can run in parallel. During a run, VeloSync displays the active phase, scan channels, workers, progress, elapsed time, and transfer status in a structured view.

`VeloSync` is the desktop application for the `sftp-push-sync` CLI tool. If you maintain a website in VS Code, you can start uploads through either the CLI or VeloSync.

## Contents

${toc}

## Requirements

- An installed VeloSync application for macOS, Windows, or Linux
- A `sync.config.json` in the project directory
- Credentials for a reachable SFTP server

On macOS, VeloSync may request local network access on first launch. This is required when the SFTP server is on the local network, for example `fileserver02`, `server.local`, or `192.168.x.x`.

Credentials are read from the current configuration. Passwords are normally stored as plain text in `sync.config.json`; do not commit this file to a public Git repository.

## Import a connection

1. Open VeloSync.
2. Click the folder icon at the top of the left sidebar and select an existing `sync.config.json`.
3. Alternatively, drag the file into the connection sidebar.
4. The connections contained in the file appear grouped by project.

Use the plus icon to create a new connection. Select an imported configuration file or choose a new location, then enter the connection name.

The connection list is grouped by project or by the location of the `sync.config.json`. This allows different projects to contain connections with the same name without causing confusion.

## Manage connections

- Click a connection in the left sidebar to open its properties on the right.
- Click a group to open its project settings and recent runs.

### Edit a connection

The name at the top is the connection name. Saving a changed name renames the corresponding key in `sync.config.json`.

The **Connection** section includes:

- A description for distinguishing similar connections
- SFTP host and port
- Username and password
- Upload and listing worker counts

The connection test is located on the right side of the **Connection** section header. It connects with the values currently entered in the form, checks the remote working directory, and does not modify files. A loader is shown while the test is running.

The **Sync directories** section defines the local and remote roots. The **Sidecar** section defines separate local and remote roots plus upload and download lists.

Click the save icon at the top right of the properties panel to save changes. Properties are read-only while a job for that connection is running. When a connection is renamed, its related log, cache, and recovery files are handled together.

Use the folder icon beside the configuration path to open the location of `sync.config.json` in Finder or the operating system's file manager.

## Sidecars

VeloSync normally synchronizes the local sync root to the remote root. Sidecars are separate files or lists that should explicitly be uploaded or downloaded, such as a counter, status file, or server-generated log file.

Configure the local and remote sidecar roots and the upload and download lists in the **Sidecar** section. List entries are relative paths. A sidecar operation can run together with the normal synchronization or on its own by enabling **Skip normal synchronization**.

## Start and monitor a synchronization

Every connection has a green start button in the connection list.

1. Start the desired connection from the connection list.
2. VeloSync opens a tab for the job.
3. The tab shows the project and connection, for example `my-project | prod`.
4. **Current run** displays the phase, elapsed time, scan channels, workers, and progress.
5. **Log** displays the technical live output.

A running job has an animated status indicator. The heading includes the elapsed time, for example `Compare changes | 12:30` or `Compare changes | dry run | 12:30`. Use the red stop button in the connection row to abort the job in a controlled way. Completed, failed, and aborted jobs can be started again.

At the end, the summary shows the duration, metrics, file and directory changes, and errors. Use the `×` in a tab to close its view. Closing a running job first aborts it.

### Dry run

A **dry run** performs the complete scan and comparison without changing files on the server. The synchronization plan shows which files would be added, changed, or deleted. The tab and summary identify the mode as **dry run**.

A dry run is useful after changing include or exclude patterns, local roots, or remote roots.

## History and logs

After a run, VeloSync stores its summary in the GUI settings store. A history entry includes:

- Status, duration, and completion time
- Counts of added, updated, and deleted files
- File and directory changes
- Performance metrics and transferred data
- Real errors, warnings, and abort information

Unimportant status lines such as `dir ok: ...` are excluded from the compact history. A single history entry is not truncated to a fixed number of lines; instead, the number of retained runs is limited.

Use **Settings > History** to choose how many runs to keep per connection. The panel also displays the number of stored runs and the space they use. **Delete history except latest run** removes older entries while retaining the newest run for each connection.

### Recent runs of a group

Opening a group shows a compact list of recent runs for all connections in that group. Use the detail action on an entry to open the complete run in its own tab with:

- **Summary**
- **Log**

This keeps group lists compact without losing access to details.

### Log file and cache

Every connection has a log file and a hash cache. In the **Job files** section, you can reveal the files in the file manager, open the log file, and delete the cache. The log file contains the complete technical output of the most recent run. The stored summary filters pure status lines so that history remains readable. The cache can be deleted at any time; the next comparison will take longer because hashes must be calculated again.

## Concurrent jobs

VeloSync prevents unsafe concurrent synchronizations:

- The same connection can run only once at a time.
- Two connections cannot access overlapping remote directories at the same time.
- The overlap check applies to connections on the same host.

Connections on the same host can run in parallel when their remote directories are separate.

## Settings, updates, and information

The general application actions are available from the toolbar:

- **Settings**: Manage language, history, and updates.
- **Info**: Show the version, author, website, and runtime information.
- **Update**: Appears when a new version is available and opens the **Updates** section in Settings.

Updates are downloaded only after confirmation. Once an update is ready, use **Restart and install** to close and update VeloSync.

## CLI and configuration

VeloSync uses the same configuration as the `sftp-push-sync` CLI. A minimal configuration looks like this:

```json
{
  "connections": {
    "staging": {
      "host": "sftp.example.net",
      "port": 22,
      "user": "sftp-user",
      "password": "do-not-commit-this",
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
  "include": [],
  "exclude": ["**/.DS_Store", "**/.git/**", "**/node_modules/**"],
  "textExtensions": [".html", ".xml", ".txt", ".json", ".js", ".css", ".md", ".svg"],
  "mediaExtensions": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".mp3", ".wav", ".flac"],
  "logLevel": "normal",
  "logTimestamps": false,
  "logFile": ".sftp-push-sync.{target}.log"
}
```

Relative local paths are resolved relative to the directory containing `sync.config.json`. `remoteRoot` is a path on the SFTP server and is not resolved against the local project directory.

The most important CLI options are also available in the GUI:

```bash
sftp-push-sync staging --dry-run
sftp-push-sync staging --sidecar-upload
sftp-push-sync staging --sidecar-download
sftp-push-sync staging --skip-sync --sidecar-upload
```

To diagnose server capabilities, run:

```bash
sftp-push-sync staging --check-resume-support
```

This checks append, remote-size verification, read-back, and rename support without running a normal synchronization.

## Troubleshooting

### Cannot connect to the SFTP server

Check the host, port, username, and password in the connection properties. For local network servers, also check macOS network permission for VeloSync and local firewall rules. The **Test connection** button in the Connection section can verify the current values without changing files.

### A connection cannot be started

A conflict message identifies the running connection or the overlapping local or remote directory. Wait until the other job finishes or choose separate remote directories.

### The configuration file is not shown

Import the desired `sync.config.json` again using the folder icon or drag it into the left sidebar. The displayed configuration path must point to a readable JSON file.

### Upload fails while replacing a file

VeloSync first uploads a file to a temporary remote file and replaces the target only after the transfer succeeds. This protects the existing file from incomplete uploads. Some SFTP servers do not allow a direct rename over an existing file, so VeloSync may first move the old target to a temporary backup and then install the replacement.

If the server also rejects that rename operation, check the SFTP user's write and rename permissions and the server configuration. The `_rename: Failure` message is a generic server error and may indicate either missing permissions or a server restriction on rename operations.

### A run was interrupted

After a controlled abort or process crash, a `.sync-recovery.<target>.json` file may remain. It records the last active phase and completed paths. On the next run, VeloSync checks affected files again. The recovery file is removed after a successful run.

### The first run is slow

During the first run, local and remote files must be scanned and many hashes must be calculated from scratch. The hash cache is stored in the project directory as `.sync-cache.<target>.ndjson`. Later runs can be significantly faster.

### An update cannot be downloaded

Check the internet connection and try checking for updates again in Settings. Installed applications fetch updates directly from the GitHub Releases of `https://github.com/cnichte/sftp-push-sync`.

## Media

Screenshots, short tutorial videos, and other media for this manual belong in the [`assets`](assets/) directory.
