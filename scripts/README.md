# Skripte

- `npm run generate:icons` erzeugt aus `app-icon.svg` die macOS-, Windows- und Linux-App-Icons in `packages/gui/resources`.
- `npm run release:mac` erstellt auf macOS einen VeloSync-Release und kopiert dessen veröffentlichbare Artefakte nach `static/releases/velosync-app/v<Version>/macos-arm64` der Website. Die Updater-Datei `latest-mac.yml` bleibt im Verzeichnis `velosync-app`.
- `npm run release:transport` transportiert bereits vorhandene Dateien aus `packages/gui/release` dorthin.
- `npm run release:tag` prüft den sauberen Git-Stand, erstellt aus der GUI-Version den annotierten Tag `v<Version>` und pusht ihn. Dadurch startet der Linux-Release auf GitHub Actions. `npm run release:tag:dry` zeigt den geplanten Schritt ohne Git-Änderung.
- `npm run release:patch`, `npm run release:minor` und `npm run release:major` erhöhen die GUI-Version, aktualisieren das Lockfile, committen die Versionsdateien und starten über den Tag den Linux-Release auf GitHub Actions. Mit `-- --dry-run` lassen sich die Schritte vorab anzeigen.