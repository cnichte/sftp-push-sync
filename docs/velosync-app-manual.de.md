# VeloSync Benutzerhandbuch

VeloSync ist eine Desktop-Anwendung für zuverlässige SFTP-Synchronisationen von einem lokalen Projektverzeichnis auf einen Server. Die Anwendung ist für macOS, Windows und Linux verfügbar und basiert auf der Sync-Engine von `sftp-push-sync`.

## Was macht VeloSync?

- Neue Dateien hochladen
- Remote-Dateien löschen, die lokal nicht mehr vorhanden sind
- Leere beziehungsweise verwaiste Remote-Ordner bereinigen
- Änderungen anhand von Dateigröße und Inhalt erkennen
- Nur tatsächlich geänderte Dateien übertragen
- Sidecar-Dateien getrennt hoch- oder herunterladen
- Mehrere unabhängige Connections parallel ausführen

Zuverlässigkeit steht im Mittelpunkt, damit beispielsweise

- keine verwaisten Dokumente auf dem Server zurückbleiben
- nur die Teile, die sich tatsächlich geändert haben, aktualisiert werden – nicht mehr und nicht weniger.

VeloSync verlässt sich nicht ausschließlich auf Zeitstempel. Textdateien werden je nach Konfiguration über ihren Inhalt verglichen; Binärdateien wie Bilder, Videos, Audiodateien und PDFs werden über SHA-256-Hashes geprüft. Die Hashes werden im lokalen Cache gespeichert, damit spätere Läufe schneller werden.

### VeloSync arbeitet in Phasen

1. Verbindung zum SFTP-Server herstellen
2. Lokale und Remote-Dateien scannen
3. Dateien vergleichen und einen Synchronisationsplan erstellen
4. Remote-Verzeichnisse vorbereiten
5. Dateien übertragen und nicht mehr vorhandene Remote-Dateien löschen
6. Leere Remote-Verzeichnisse bereinigen

Lokaler und Remote-Scan können parallel laufen. Während des Laufs zeigt VeloSync die aktive Phase, Scan-Kanäle, Worker, Fortschritt, Laufzeit und Übertragungsstatus strukturiert an.

`VeloSync` ist die Desktop-Anwendung für mein CLI-Tool `sftp-push-sync`.

Wer seine Webseite zum Beispiel über VS Code pflegt, kann die Uploads direkt über das CLI oder VeloSync anstoßen.

## Inhalt

${toc}

## Voraussetzungen

- Eine installierte VeloSync-App für macOS, Windows oder Linux.
- Eine `sync.config.json` im Projektordner.
- Zugangsdaten für einen erreichbaren SFTP-Server.

Auf macOS kann VeloSync beim ersten Start den Zugriff auf das lokale Netzwerk anfragen. Dieser Zugriff wird benötigt, wenn der SFTP-Server im lokalen Netzwerk liegt, zum Beispiel `fileserver02`, `server.local` oder `192.168.x.x`.

Die Zugangsdaten werden von der aktuellen Konfiguration übernommen. Passwörter liegen in einer `sync.config.json` in der Regel im Klartext. Diese Datei darf deshalb nicht in ein öffentliches Git-Repository gelangen.

## Erste Verbindung hinzufügen

1. Öffne VeloSync.
2. Wähle links oben das Ordner-Symbol, um eine bestehende `sync.config.json` zu importieren.
3. Alternativ ziehe die Datei `sync.config.json` in die linke Verbindungsleiste.
4. Die enthaltenen Connections erscheinen gruppiert nach Projekt.

Über das Plus-Symbol lässt sich auch eine neue Connection anlegen. Wähle dafür eine bereits importierte Konfigurationsdatei oder einen neuen Speicherort und vergebe einen Connection-Namen.

Die Verbindungsliste ist nach Projekt beziehungsweise Speicherort der `sync.config.json` gruppiert. Dadurch können mehrere Projekte gleichnamige Connections enthalten, ohne dass sie verwechselt werden.

## Verbindungen verwalten

- Klicke eine Connection in der linken Leiste an. Rechts erscheinen ihre Eigenschaften.
- Klicke auf die Gruppe, um die globalen Projekteinstellungen und die Läufe der Gruppe zu sehen.

### Connection bearbeiten

Der obere Name ist der Connection-Name und kann geändert werden. Beim Speichern benennt VeloSync den zugehörigen Schlüssel in der `sync.config.json` um.

Im Abschnitt **Verbindung** stehen unter anderem diese Einstellungen zur Verfügung:

- Beschreibung zur Unterscheidung ähnlicher Connections
- Host und Port des SFTP-Servers
- Benutzername und Passwort
- Upload- und Listing-Worker

Rechts im Header des Abschnitts **Verbindung** befindet sich der Verbindungstest. Er baut mit den aktuell eingetragenen Werten eine SFTP-Verbindung auf, prüft das Remote-Arbeitsverzeichnis und verändert keine Dateien. Während des Tests wird ein Loader angezeigt.

- Im Abschnitt **Sync-Verzeichnisse** werden lokales und entferntes Root-Verzeichnis festgelegt.
- Der Abschnitt **Sidecar** enthält die getrennt zu synchronisierenden lokalen und entfernten Pfade sowie Upload- und Download-Listen.

Änderungen speicherst du mit dem Disketten-Symbol oben rechts im Eigenschaftenbereich. Während ein Job für diese Connection läuft, sind die Eigenschaften schreibgeschützt. Beim Umbenennen werden die zugehörigen Log-, Cache- und Recovery-Dateien gemeinsam berücksichtigt.

Über das Ordner-Symbol neben dem angezeigten Config-Pfad öffnest du den Speicherort der `sync.config.json` im Finder beziehungsweise im Dateimanager des Betriebssystems.

## Sidecars

Normalerweise synchronisiert VeloSync das lokale Sync-Root zum Remote-Root. Sidecars sind davon getrennte Dateien oder Listen, die ausdrücklich hoch- oder heruntergeladen werden sollen, zum Beispiel ein Zähler, eine Statusdatei oder eine serverseitig erzeugte Logdatei.

Im Abschnitt **Sidecar** können lokales und entferntes Sidecar-Root sowie die Upload- und Download-Listen eingestellt werden. Die Listen enthalten relative Pfade. Ein Sidecar-Lauf kann zusammen mit der normalen Synchronisation oder mit **Normale Synchronisation überspringen** allein ausgeführt werden.

## Synchronisation starten und beobachten

Jede Connection hat links in der Liste einen grünen Start-Button.

1. Starte die gewünschte Connection über den Start-Button in der Verbindungsliste.
2. VeloSync öffnet einen Tab für diesen Job.
3. Der Tab zeigt Projektname und Connection, zum Beispiel `mein-projekt | prod`.
4. Unter **Aktueller Lauf** werden Phase, Laufzeit, Scan-Kanäle, Worker und Fortschritt angezeigt.
5. Unter **Protokoll** steht die technische Live-Ausgabe.

Ein laufender Job zeigt einen animierten Statusindikator. Die Überschrift enthält die aktuelle Laufzeit, zum Beispiel `Änderung vergleichen | 12:30` oder `Änderung vergleichen | dry run | 12:30`. Mit dem roten Stop-Button in der Connection-Zeile wird er kontrolliert abgebrochen. Ein abgeschlossener, fehlgeschlagener oder abgebrochener Job kann danach direkt erneut gestartet werden.

Am Ende zeigt die Zusammenfassung die Laufzeit, Metriken, Datei- und Verzeichnisänderungen sowie Fehler. Über das `×` im jeweiligen Tab schließt du die Ansicht. Ein laufender Job wird dabei vorher abgebrochen.

### Trockenlauf

Mit **Trockenlauf** wird der vollständige Scan- und Vergleichsprozess ausgeführt, ohne Dateien auf dem Server zu verändern. Der Synchronisationsplan zeigt, welche Dateien hinzugefügt, geändert oder gelöscht würden. Im Tab und in der Zusammenfassung wird der Modus als **dry run** gekennzeichnet.

Ein Trockenlauf eignet sich besonders nach Änderungen an `include`, `exclude`, lokalen Roots oder Remote-Roots.

## Historie und Protokolle

Nach einem Lauf speichert VeloSync die Zusammenfassung im GUI-Settings-Store. Ein History-Eintrag enthält unter anderem:

- Status, Laufzeit und Abschlusszeitpunkt
- Anzahl neuer, geänderter und gelöschter Dateien
- Datei- und Verzeichnisänderungen
- Performance-Metriken und übertragene Datenmenge
- echte Fehler, Warnungen und Abbruchinformationen

Unwichtige Statuszeilen wie `dir ok: ...` werden nicht in die kompakte History übernommen. Die Historie eines einzelnen Laufs wird nicht auf eine feste Zeilenzahl gekürzt. Stattdessen wird die Anzahl der aufbewahrten Läufe begrenzt.

Über **Einstellungen > Historie** lässt sich festlegen, wie viele Läufe pro Connection aufbewahrt werden. Dort werden auch die Anzahl der gespeicherten Läufe und der belegte Speicher angezeigt. Die Funktion **Historie bis auf letzten Lauf löschen** entfernt ältere Einträge und behält pro Connection den neuesten Lauf.

### Letzte Läufe einer Gruppe

Beim Öffnen einer Gruppe erscheint eine kompakte Liste der letzten Läufe aller Connections dieser Gruppe. Mit der Detailaktion am jeweiligen Eintrag öffnest du den vollständigen Lauf in einem eigenen Tab mit:

- **Zusammenfassung**
- **Protokoll**

Dadurch bleiben Gruppenlisten übersichtlich, ohne Details zu verlieren.

### Logdatei und Cache

Jede Connection besitzt eine Logdatei und einen Hash-Cache. Im Abschnitt **Job-Dateien** kannst du die Dateien im Dateimanager anzeigen, die Logdatei öffnen und den Cache löschen. Die Logdatei enthält den vollständigen technischen Verlauf des jeweils letzten Laufs. Die gespeicherte Zusammenfassung filtert dagegen reine Statuszeilen, damit die History lesbar bleibt. Der Cache kann jederzeit gelöscht werden; der nächste Vergleich dauert dann länger, weil Hashes erneut ermittelt werden.

## Gleichzeitige Jobs

VeloSync verhindert gefährliche parallele Synchronisationen:

- Dieselbe Connection kann nur einmal gleichzeitig laufen.
- Zwei Connections dürfen nicht gleichzeitig auf überlappende Remote-Verzeichnisse zugreifen.
- Die Überschneidungsprüfung gilt für Connections auf demselben Host.

Connections auf demselben Host mit voneinander getrennten Remote-Verzeichnissen können parallel laufen.

## Einstellungen, Updates und Info

Unten links befinden sich die allgemeinen App-Aktionen:

- **Einstellungen**: Sprache, Historie und Updates verwalten.
- **Info**: Version, Autor, Website sowie verwendete Electron- und Node-Version anzeigen.
- **Update**: Erscheint gelb, sobald eine neue Version verfügbar ist. Ein Klick öffnet direkt den Bereich **Updates** in den Einstellungen.

Updates werden erst nach deiner Bestätigung heruntergeladen. Wenn das Update bereitsteht, beendet und installiert VeloSync es über **Neustart & installieren**.

## CLI und Konfiguration

VeloSync verwendet dieselbe Konfiguration wie das CLI `sftp-push-sync`. Eine minimale Konfiguration sieht so aus:

```json
{
	"connections": {
		"staging": {
			"host": "sftp.example.net",
			"port": 22,
			"user": "sftp-user",
			"password": "nicht-in-git-speichern",
			"workerUpload": 3,
			"workerList": 5,
			"sync": {
				"localRoot": "public",
				"remoteRoot": "/webseite/"
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

Relative lokale Pfade werden relativ zum Verzeichnis der `sync.config.json` ausgewertet. Der `remoteRoot` ist ein Pfad auf dem SFTP-Server und wird nicht gegen den lokalen Projektordner aufgelöst.

Die wichtigsten CLI-Optionen sind auch über die GUI verfügbar:

```bash
sftp-push-sync staging --dry-run
sftp-push-sync staging --sidecar-upload
sftp-push-sync staging --sidecar-download
sftp-push-sync staging --skip-sync --sidecar-upload
```

Für die Diagnose der Serverfähigkeiten gibt es außerdem:

```bash
sftp-push-sync staging --check-resume-support
```

Dieser Test prüft unter anderem Append, Remote-Größenprüfung, Read-back und Rename-Unterstützung, ohne einen normalen Sync auszuführen.

## Fehlerbehebung

### Verbindung zum SFTP-Server nicht möglich

Prüfe Host, Port, Benutzername und Passwort in den Eigenschaften der Connection. Bei Servern im lokalen Netzwerk prüfe außerdem die macOS-Netzwerkfreigabe für VeloSync und lokale Firewall-Regeln.

### Connection kann nicht gestartet werden

Eine Konfliktmeldung beschreibt die aktuell laufende Connection oder das überlappende lokale beziehungsweise entfernte Verzeichnis. Warte, bis der andere Job fertig ist, oder wähle getrennte Verzeichnisse.

### Config-Datei wird nicht angezeigt

Importiere die gewünschte `sync.config.json` erneut über das Ordner-Symbol oder ziehe sie in die linke Leiste. Der angezeigte Config-Pfad muss auf eine lesbare JSON-Datei zeigen.

### Upload schlägt beim Ersetzen einer Datei fehl

VeloSync lädt Dateien zunächst in eine temporäre Remote-Datei hoch und ersetzt das Ziel erst nach erfolgreicher Übertragung. Das schützt die bisherige Datei vor unvollständigen Uploads. Einige SFTP-Server erlauben jedoch kein direktes Umbenennen über eine bereits vorhandene Datei. VeloSync versucht in diesem Fall, die alte Datei kurzzeitig zu sichern und danach den Ersatz einzusetzen.

Wenn der Server auch diese Rename-Operation verweigert, prüfe die Schreib- und Umbenennungsrechte des SFTP-Benutzers sowie die Serverkonfiguration. Die Fehlermeldung `_rename: Failure` ist eine generische Servermeldung und kann sowohl auf fehlende Rechte als auch auf eine Einschränkung der Rename-Operation hinweisen.

### Lauf wurde unterbrochen

Bei einem kontrollierten Abbruch oder einem Prozessabsturz kann eine Datei `.sync-recovery.<target>.json` zurückbleiben. Sie enthält den letzten aktiven Abschnitt und bereits bearbeitete Pfade. Beim nächsten Lauf prüft VeloSync die betroffenen Dateien erneut. Nach einem erfolgreichen Lauf wird die Recovery-Datei entfernt.

### Erster Lauf ist langsam

Beim ersten Lauf müssen lokale und Remote-Dateien vollständig erfasst und viele Hashes neu berechnet werden. Der Hash-Cache wird im Projektverzeichnis als `.sync-cache.<target>.ndjson` gespeichert. Nachfolgende Läufe können dadurch deutlich schneller sein.

### Update kann nicht heruntergeladen werden

Prüfe die Internetverbindung und versuche die Suche nach Updates erneut über die Einstellungen. Installierte Apps verwenden die veröffentlichte Update-Quelle unter `https://carsten-nichte.de/releases/velosync-app/`.

## Medien

Screenshots, kurze Anleitungsvideos und weitere Medien für dieses Handbuch liegen im Verzeichnis [`assets`](assets/).
