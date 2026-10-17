# RECHERCHE: Network - Stay Awake

## Electron

In einer Electron-App das Einschlafen des Rechners und das Trennen der Netzwerkverbindung mit dem integrierten powerSaveBlocker-API von Electron verhindern:

```ts
const { app, powerSaveBlocker } = require('electron');
let blockerId = null;

app.whenReady().then(() => {
  // Startet das Blockieren des Energiesparmodus
  // 'prevent-display-sleep' hält den Bildschirm UND den Rechner/das Netzwerk aktiv.
  blockerId = powerSaveBlocker.start('prevent-display-sleep');
  
  console.log(`Energiesparmodus blockiert. ID: ${blockerId}`);
});
// Wichtig: Blockierung aufheben, wenn sie nicht mehr gebraucht wird oder die App schließt
app.on('will-quit', () => {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
});
```

Die powerSaveBlocker-API bietet zwei verschiedene Stufen die sich in ihrer Wirkung unterscheiden:

- `prevent-app-suspension`
  - Hält die App aktiv, erlaubt es dem Betriebssystem aber, den Bildschirm auszuschalten.
  - Risiko: Bei manchen Betriebssystemen (insb. macOS/Windows-Laptops im Akkubetrieb) kann die Netzwerkkarte dennoch in den Stromsparmodus versetzt werden.
- `prevent-display-sleep`
  - Hält den Bildschirm und das gesamte System komplett wach.
  - Sicher: Da das System denkt, der Nutzer schaut aktiv auf den Bildschirm, bleibt die Netzwerkverbindung garantiert stabil.

`prevent-display-sleep` am besten nur dann benutzen, wenn eine aktive Aufgabe läuft (zB. ein großer Download oder Upload - eine aktive Datenübertragung) und schalte ihn danach wieder ab, um den Akku des Nutzers zu schonen. Du kannst powerSaveBlocker.stop(blockerId) jederzeit im laufenden Betrieb aufrufen.

## CLI

Da Node.js im Terminal standardmäßig keinen Zugriff auf die UI-Bibliotheken des Betriebssystems hat, lösen npm-Module dies meist über native Bindings oder indem sie die systemeigenen Kommandozeilen-Tools im Hintergrund ansteuern.

Zwei bewährte npm-Pakete, die genau das in reinen Node.js/TypeScript-Terminalanwendungen tun, lösen dieses Problem:

### 1. Die native Lösung: node-prevent-sleep

Dieses Modul nutzt native C++ Bindings, um direkt mit den Energiespar-APIs von Windows, macOS und Linux zu kommunizieren. Es ist die stabilste und sauberste Variante für ein Terminal-Skript.

```ts
// Installation: npm install node-prevent-sleep
// In TypeScript / ES-Modulen:

import preventSleep from 'node-prevent-sleep';
// Verhindert, dass der Rechner/das System (und somit das Netzwerk) einschläft
preventSleep.enable();
console.log("Energiesparmodus erfolgreich blockiert.");
// Wenn deine Aufgabe erledigt ist oder das Skript beendet wird:// preventSleep.disable();

(Hinweis: Falls du eine Fehlermeldung bezüglich fehlender Typen erhältst, erstelle eine einfache .d.ts-Datei oder binde es per const preventSleep = require('node-prevent-sleep'); ein).
```

### 2. Die leichtgewichtige Alternative: stay-awake

Das Paket [stay-awake](https://github.com/dapetcu21/node-stay-awake) nutzt keine C++ Erweiterungen, sondern triggert im Hintergrund Betriebssystem-Befehle (wie z. B. caffeinate unter macOS oder powercfg unter Windows).

```ts
// Installation: npm install stay-awake
// In TypeScript:

import stayAwake from 'stay-awake';
// Verhindert das Einschlafen
stayAwake.prevent((err) => {
  if (err) console.error("Fehler beim Blockieren:", err);
  else console.log("System bleibt wach!");
});
// Um den Rechner wieder normal schlafen zu lassen:// stayAwake.allow();
```

### 3. Der "No-Dependency"-Trick (Ohne npm-Modul)

Wenn du für dein CLI-Tool gar kein npm-Modul installieren möchtest, kannst du die bordeigenen Befehle der Betriebssysteme direkt über Node.js child_process starten.
Besonders unter macOS ist das extrem elegant, weil es den Befehl caffeinate gibt, der sich automatisch beendet, sobald dein Node-Prozess stirbt:

```ts
import { spawn } from 'child_process';import os from 'os';
if (os.platform() === 'darwin') {
  // Startet 'caffeinate' im Hintergrund und koppelt es an die PID dieses Node-Prozesses (-w)
  // -i verhindert den System-Idle-Sleep, -n verhindert den Display-Sleep
  const caffeinate = spawn('caffeinate', ['-w', process.pid.toString(), '-i']);
  console.log("macOS Caffeinate aktiv.");
}
```

Daraus könnte man ein kurzes, plattformübergreifendes Wrapper-Skript schreiben...

Das Skript ist so gebaut, dass es die Energiespar-Blocker automatisch beendet, sobald du das Programm mit STRG + C (SIGINT) schließt oder es regulär fertig ist.

#### plattformübergreifendes "No-Dependency" Beispiel

```ts
import { spawn, ChildProcess } from 'child_process';import os from 'os';
let blockerProcess: ChildProcess | null = null;
/**
 * Startet den plattformspezifischen Befehl, um den Sleep-Modus zu verhindern.
 */export function preventSleep(): void {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      // macOS: 'caffeinate' an die PID dieses Node-Prozesses koppeln (-w)
      blockerProcess = spawn('caffeinate', ['-w', process.pid.toString(), '-i']);
      console.log('🛡️ [KeepAwake] macOS Caffeinate aktiv (System bleibt wach).');
      
    } else if (platform === 'win32') {
      // Windows: Nutzen von 'powercfg', um das System temporär im "Away Mode" zu halten
      // -requestsoverride zwingt das System, Aktivität vorzutäuschen
      blockerProcess = spawn('powercfg', ['/requestsoverride', 'PROCESS', 'node.exe', 'System']);
      console.log('🛡️ [KeepAwake] Windows powercfg-Anpassung aktiv.');
      
    } else if (platform === 'linux') {
      // Linux: Versucht 'systemd-inhibit' zu nutzen, um den Sleep-Modus zu blockieren
      blockerProcess = spawn('systemd-inhibit', [
        '--why="Node.js Script läuft"',
        '--what=sleep:idle',
        '--mode=block',
        'sleep', 'infinity'
      ]);
      console.log('🛡️ [KeepAwake] Linux systemd-inhibit aktiv.');
    } else {
      console.warn(`⚠️ [KeepAwake] Plattform "${platform}" wird nicht nativ unterstützt.`);
    }
  } catch (error) {
    console.error('❌ Fehler beim Starten des Sleep-Blockers:', error);
  }
}
/**
 * Hebt die Blockierung wieder auf und erlaubt dem System das Einschlafen.
 */export function allowSleep(): void {
  if (blockerProcess) {
    blockerProcess.kill();
    blockerProcess = null;
    
    // Windows-Spezifisch: Den Request wieder entfernen
    if (os.platform() === 'win32') {
      try {
        spawn('powercfg', ['/requestsoverride', 'PROCESS', 'node.exe']);
      } catch (e) {
        // Ignorieren falls bereits geschlossen
      }
    }
    
    console.log('🌙 [KeepAwake] Blockierung aufgehoben. System darf wieder schlafen.');
  }
}
// --- Automatische Bereinigung bei Programmende ---const cleanUp = () => {
  allowSleep();
  process.exit(0);
};

process.on('SIGINT', cleanUp);  // STRG+C
process.on('SIGTERM', cleanUp); // Kill-Befehl
process.on('exit', () => allowSleep());

## So wendest du es in deinem Hauptskript an:

import { preventSleep, allowSleep } from './sleep-blocker';
async function main() {
  // 1. Verhindere das Einschlafen vor deiner Aufgabe
  preventSleep();

  console.log("Starte langanhaltenden Netzwerk-Task...");
  
  // Simuliere einen 10-sekündigen Task (z.B. Download, Datenverarbeitung)
  await new Promise((resolve) => setTimeout(resolve, 10000));

  console.log("Task erfolgreich beendet!");

  // 2. Erlaube dem System wieder das normale Energiesparen
  allowSleep();
}

main();
```

Wichtige Plattform-Hinweise für Windows & Linux:

- Windows: Der Befehl powercfg benötigt unter Umständen Administratorrechte, je nach Sicherheitsrichtlinie des Systems. Wenn das Skript ohne Admin-Rechte läuft, schlägt der Befehl fehl (wird abgefangen, lässt das Skript aber nicht abstürzen).
- Linux: systemd-inhibit ist der Standard auf modernen Linux-Distributionen (Ubuntu, Debian, Fedora, Arch). Auf Servern ohne systemd hat dieser Befehl keine Wirkung.

Das macht die ganze sache also im Grunde unbrauchbar.

Man könnte jetzt für Windows eine alternative Methode über native Windows-APIs (Kernel32.dll) via node-ffi oder napi einbauen, um die Administratorrechte-Pflicht zu umgehen... aber dann kann ich auch gleich ein npm modul nehmen waa alles ordentlich implemetiert.
