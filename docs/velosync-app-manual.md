# VeloSync Benutzerhandbuch

`VeloSync` ist die Desktop-Anwendung für mein CLI-Tool `sftp-push-sync`.

## Inhaltsverzeichnis

- [Voraussetzungen](#voraussetzungen)
- [Erste Verbindung hinzufügen](#erste-verbindung-hinzufügen)
- [Verbindungen verwalten](#verbindungen-verwalten)
- [Synchronisation starten und beobachten](#synchronisation-starten-und-beobachten)
- [Gleichzeitige Jobs](#gleichzeitige-jobs)
- [Einstellungen, Updates und Info](#einstellungen-updates-und-info)
- [Fehlerbehebung](#fehlerbehebung)

## Voraussetzungen

- Eine installierte VeloSync-App für macOS, Windows oder Linux.
- Eine `sync.config.json` im Projektordner.
- Zugangsdaten für einen erreichbaren SFTP-Server.

Auf macOS kann VeloSync beim ersten Start den Zugriff auf das lokale Netzwerk anfragen. Dieser Zugriff wird benötigt, wenn der SFTP-Server im lokalen Netzwerk liegt, zum Beispiel `fileserver02`, `server.local` oder `192.168.x.x`.

## Erste Verbindung hinzufügen

1. Öffne VeloSync.
2. Wähle links oben das Ordner-Symbol, um eine bestehende `sync.config.json` zu importieren.
3. Alternativ ziehe die Datei `sync.config.json` in die linke Verbindungsleiste.
4. Die enthaltenen Connections erscheinen gruppiert nach Projekt.

Über das Plus-Symbol lässt sich auch eine neue Connection anlegen. Wähle dafür eine bereits importierte Konfigurationsdatei oder einen neuen Speicherort und vergebe einen Connection-Namen.

## Verbindungen verwalten

- Klicke eine Connection in der linken Leiste an. Rechts erscheinen ihre Eigenschaften.
- Klicke auf die Gruppe und verwalte die gemeinsamen eigenschaften für alle Jobs in der GRuppe.

### Connection bearbeiten

Der obere Name ist der Connection-Name und kann geändert werden. Beim Speichern benennt VeloSync den zugehörigen Schlüssel in der `sync.config.json` um.

Im Abschnitt **Verbindung** stehen unter anderem diese Einstellungen zur Verfügung:

- Beschreibung zur Unterscheidung ähnlicher Connections
- Host und Port des SFTP-Servers
- Benutzername und Passwort
- Upload- und Listing-Worker


- Im Abschnitt **Sync-Verzeichnisse** werden lokales und entferntes Root-Verzeichnis festgelegt.
- Der Abschnitt **Sidecar** enthält die getrennt zu synchronisierenden lokalen und entfernten Pfade sowie Upload- und Download-Listen.

Änderungen speicherst du mit dem Disketten-Symbol oben rechts im Eigenschaftenbereich. Während ein Job für diese Connection läuft, sind die Eigenschaften schreibgeschützt.

Über das Ordner-Symbol neben dem angezeigten Config-Pfad öffnest du den Speicherort der `sync.config.json` im Finder beziehungsweise im Dateimanager des Betriebssystems.

## Sidecars

Normal transportiert dieses Tool nur in eine Richtung: Uploads zum Server. Es gibt aber Sonderfälle da möchte ich gezielt einzelne Dateien getrennt behandeln. Beispiel: Einen counter oder eine log datei die auf dem server läuft herunter laden oder wieder herauf laden. Für solche fälle sind sidecars gedacht.

## Synchronisation starten und beobachten

Jede Connection hat links in der Liste einen grünen Start-Button.

1. Starte die gewünschte Connection über den Start-Button.
2. VeloSync öffnet einen Tab für diesen Job.
3. Der Tab zeigt Projektname und Connection, zum Beispiel `mein-projekt | prod`.

Ein laufender Job zeigt einen animierten Statusindikator. Mit dem roten Stop-Button in der Connection-Zeile wird er kontrolliert abgebrochen. Ein abgeschlossener, fehlgeschlagener oder abgebrochener Job kann danach direkt erneut gestartet werden.

Über das `×` im jeweiligen Tab schließt du dessen Terminalansicht. Ein laufender Job wird dabei vorher abgebrochen.

## Gleichzeitige Jobs

VeloSync verhindert gefährliche parallele Synchronisationen:

- Dieselbe Connection kann nur einmal gleichzeitig laufen.
- Zwei Connections dürfen nicht gleichzeitig auf überlappende remote Verzeichnisse zugreifen.
- Connections zum selben Host dürfen nicht gleichzeitig auf überlappende Remote-Verzeichnisse zugreifen.

Connections auf demselben Host mit voneinander getrennten  Remote-Verzeichnissen können parallel laufen.

## Einstellungen, Updates und Info

Unten links befinden sich die allgemeinen App-Aktionen:

- **Einstellungen**: Sprache wählen und Updates verwalten.
- **Info**: Version, Autor, Website sowie verwendete Electron- und Node-Version anzeigen.
- **Update**: Erscheint gelb, sobald eine neue Version verfügbar ist. Ein Klick öffnet direkt den Bereich **Updates** in den Einstellungen.

Updates werden erst nach deiner Bestätigung heruntergeladen. Wenn das Update bereitsteht, beendet und installiert VeloSync es über **Neustart & installieren**.

## Fehlerbehebung

### Verbindung zum SFTP-Server nicht möglich

Prüfe Host, Port, Benutzername und Passwort in den Eigenschaften der Connection. Bei Servern im lokalen Netzwerk prüfe außerdem die macOS-Netzwerkfreigabe für VeloSync und lokale Firewall-Regeln.

### Connection kann nicht gestartet werden

Eine Konfliktmeldung beschreibt die aktuell laufende Connection oder das überlappende lokale beziehungsweise entfernte Verzeichnis. Warte, bis der andere Job fertig ist, oder wähle getrennte Verzeichnisse.

### Config-Datei wird nicht angezeigt

Importiere die gewünschte `sync.config.json` erneut über das Ordner-Symbol oder ziehe sie in die linke Leiste. Der angezeigte Config-Pfad muss auf eine lesbare JSON-Datei zeigen.

### Update kann nicht heruntergeladen werden

Prüfe die Internetverbindung und versuche die Suche nach Updates erneut über die Einstellungen. Installierte Apps verwenden die veröffentlichte Update-Quelle unter `https://carsten-nichte.de/releases/velosync-app/`.

## Medien

Screenshots, kurze Anleitungsvideos und weitere Medien für dieses Handbuch liegen im Verzeichnis [`assets`](assets/).
