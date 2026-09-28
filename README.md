Das Programm löst ein Reihenfolge- und Kapazitätsproblem in der Fahrzeugfertigung im TMC Wittlich: Mehrere Fahrzeuge müssen durch mehrere Abteilungen (Demo: Karosserie, Lack, Elektrik; Excel: Aufbau, Fgest, FHS, Lack, Elektrik), jede Abteilung hat begrenzt Mitarbeiter, jedes Fahrzeug eine Deadline. Gesucht ist der Belegungsplan — wer arbeitet an welchem Tag mit wie vielen Leuten an welchem Fahrzeug.

Gelöst wird das als gemischt-ganzzahliges lineares Programm (MILP) mit HiGHS, das über WebAssembly in einem Web Worker läuft (nicht mehr im Haupt-Thread), damit die Seite während der Berechnung reagieren bleibt.

So funktioniert es (Ablauf)
Bedienung
1. Server starten: im Projektordner `npm start` oder Doppelklick auf start.bat (in PowerShell: .\start.bat). Das Fenster muss offen bleiben. `npm start` startet den Server mit `node --watch`: Änderungen an server.js, Fahrzeuge.js, excel.js oder db.js laden den Server automatisch neu (vorher musste man ihn von Hand neu starten). Nach Änderungen an solver.js, index.html oder style.css genügt Strg+F5 im Browser. Meldet die Ausgabe „Server läuft noch mit altem Stand“, wurde der Server vor einer Änderung gestartet und muss neu gestartet werden.
2. Im Browser http://localhost:3000 öffnen. Nicht über Live Server (Port 5501) oder per Doppelklick auf index.html: dort gibt es die API nicht, und es erscheinen nur die Demo-Daten.
3. Optional oben die Felder ändern:
   - „Mitarbeiter pro Tag“ je Abteilung (Standard 3)
   - „Max. Mitarbeiter pro Fahrzeug und Abteilung“ (Standard 2)
   - „Berechnungsdatum (Tag 1 des Plans)“ (Standard: heute) — damit lässt sich für unterschiedliche Starttage am selben Tag rechnen, ohne den Kalender abzuwarten
   - „Zeithorizont für Fahrzeuge“ (Standard 180 Kalendertage) — steuert, welche Fahrzeuge überhaupt in die Planung kommen (siehe „Excel-Fallback im Detail“)
   - „Laufzeit bis der Solver abbricht“ (Standard 120 Sekunden) — Zeitlimit für HiGHS
4. „Optimierung starten“ klicken. Mit „Abbrechen“ lässt sich eine laufende Berechnung beenden. Danach erscheinen zuerst der Planungshorizont T, dann die Tagesliste, die Deadline-Auswertung, das Gantt-Diagramm und die Auslastung pro Woche; mit den Abteilungs-Buttons über dem Gantt lässt sich dieses nach Abteilungen filtern.

Was dabei im Hintergrund passiert
1. index.html lädt solver.js als ES-Modul. Der Klick ruft runSolver() auf.
2. solver.js sammelt die Werte der Eingabefelder und ruft /api/planung?kap_<Abteilung>=…&max_fzg=…&horizont=…&start=… auf (start nur, wenn ein Berechnungsdatum gesetzt ist).
3. server.js (Express) reicht die Anfrage an Fahrzeuge.js weiter. Dort wird zuerst die Oracle-DB versucht (db.js, Zugangsdaten aus .env). Schlägt das fehl, wird stattdessen die Excel-Datei verwendet. Auf dem Server steht dann „DB nicht verfuegbar … - nutze Excel-Daten.“ – das ist der Normalfall, solange DB_CONNECT nicht stimmt.
4. Für Excel liest excel.js beim ersten Mal die xlsx (ca. 30 s), filtert die passenden Aufträge und speichert sie als daten/auftraege.json. Danach kommt die Antwort in Millisekunden aus dieser JSON.
5. excelToModel (Fahrzeuge.js) wählt daraus die Fahrzeuge im Zeithorizont aus und macht daraus die Modelldaten: Fahrzeuge, Abteilungen, Aufwand in Mitarbeiter-Tagen, Deadline als Werktag-Nummer, erster Bearbeitungstag je Fahrzeug (Anlieferung), Kapazität, Planungshorizont T, Anzeigenamen/Status/ZAP-Kennzeichen und Startdatum. Sie gehen als JSON zurück an den Browser.
6. solver.js baut daraus mit baueModell() das solver-unabhängige Modell, wandelt es mit zuHighsModell() in ein numerisches HiGHS-Modell um und schickt es an highs-worker.js (Web Worker), der HiGHS (WebAssembly) laedt und loest. Das Ergebnis kommt per postMessage zurueck.
7. Das Ergebnis wird als Tagesliste, Deadline-Auswertung und Gantt-Diagramm ausgegeben.
Bei jedem Klick wird neu geladen und neu gerechnet; geänderte Feldwerte gelten also sofort.
