// @ts-nocheck
// Der eigentliche Solve laeuft in highs-worker.js (HiGHS/WebAssembly), nicht hier: model.run()
// ist synchron/blockierend und wuerde sonst die Seite einfrieren. Dieses Modul baut nur das
// Modell (baueModell/zuHighsModell) und wertet das Ergebnis des Workers aus.

function print(text) {
    const output = document.getElementById("output");
    if (!output) return;
    output.textContent += text + "\n";
}

// Eigener Tooltip fuer alle Elemente mit data-tip. Die eingebauten title-Tooltips des
// Browsers erscheinen z. B. im Simple Browser von VS Code nicht (Webview), dieser hier
// funktioniert ueberall.
function initTooltip() {
    if (typeof document === 'undefined' || !document.body) return;

    const tip = document.createElement('div');
    tip.id = 'tooltip';
    document.body.appendChild(tip);

    let aktuell = null;

    const positioniere = e => {
        const abstand = 14;
        let x = e.clientX + abstand;
        let y = e.clientY + abstand;
        // am Rand des Fensters auf die andere Seite des Mauszeigers klappen
        if (x + tip.offsetWidth > window.innerWidth) x = e.clientX - tip.offsetWidth - abstand;
        if (y + tip.offsetHeight > window.innerHeight) y = e.clientY - tip.offsetHeight - abstand;
        tip.style.left = `${Math.max(0, x)}px`;
        tip.style.top = `${Math.max(0, y)}px`;
    };

    document.addEventListener('mouseover', e => {
        const el = e.target.closest?.('[data-tip]') ?? null;
        if (el === aktuell) return;
        aktuell = el;
        if (el) {
            tip.textContent = el.dataset.tip;
            tip.style.display = 'block';
            positioniere(e);
        } else {
            tip.style.display = 'none';
        }
    });

    document.addEventListener('mousemove', e => {
        if (aktuell) positioniere(e);
    });

    // Element wird neu gezeichnet (z. B. Filter-Klick) -> Tooltip nicht haengen lassen
    document.addEventListener('click', () => {
        aktuell = null;
        tip.style.display = 'none';
    });
}

initTooltip();

// Berechnungsdatum: Vorgabe ist das heutige (lokale) Datum
function initBerechnungsdatum() {
    const feld = typeof document !== 'undefined' && document.getElementById('berechnungsdatum');
    if (!feld || feld.value) return;
    const heute = new Date();
    feld.value = `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}`;
}

initBerechnungsdatum();

// Geleistete Mitarbeiter-Tage: planmaessig (x) oder verspaetet (z).
// Fuer einen Tag ist immer nur eine der beiden Variablen vorhanden.
function arbeitsmenge(sol, i, j, t) {
    return (sol[`x_${i}_${j}_t${t}`] || 0) + (sol[`z_${i}_${j}_t${t}`] || 0);
}

// Datum von Tag n bei einer 5-Tage-Woche: Tag 1 ist der erste Werktag ab startIso,
// Samstag und Sonntag werden uebersprungen (wie bei der Deadline-Berechnung im Server)
function werktagDatum(startIso, n) {
    const d = new Date(`${startIso}T00:00:00Z`);
    let gezaehlt = 0;
    for (;;) {
        const wt = d.getUTCDay();
        if (wt !== 0 && wt !== 6 && ++gezaehlt === n) return d;
        d.setUTCDate(d.getUTCDate() + 1);
    }
}

function formatDatum(d, mitJahr) {
    return d.toLocaleDateString('de-DE', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        ...(mitJahr && { year: 'numeric' }),
        timeZone: 'UTC'
    });
}

// Zahl mit deutschem Dezimalkomma, ohne unnoetige Nachkommastellen (7 -> "7", 104.5 -> "104,5")
function formatZahl(n) {
    return Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

// ISO-Datum (2026-10-07) -> "07.10.2026"; Text wie "bereits angeliefert" bleibt unveraendert
function anlieferungText(wert) {
    if (!wert) return '-';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(wert);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : wert;
}

// Leistungsumfang und Gesamtstunden eines Fahrzeugs (Excel-Daten); sonst leer
function fahrzeugInfo(daten, i) {
    const x = daten.info?.[i];
    if (!x) return null;
    return {
        status: x.status,
        zap: x.zap,
        tooltip: `Leistungsumfang: ${x.leistungsumfang || '-'}\n`
            + `Anlieferung: ${anlieferungText(x.anlieferung)}\n`
            + `Lieferprio: ${x.prio ?? '-'}\n`
            + `Gesamtstunden (Rest): ${formatZahl(x.stunden)} h\n`
            + `ursprünglich geplant: ${formatZahl(x.geplant)} h`
    };
}

// ============================
// Gantt-Diagramm rendern
// ============================
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#9b59b6', '#f1c40f', '#16a085'];

// Zuletzt berechneter Plan und die Abteilungen, die im Gantt gerade angezeigt werden
let plan = null;
const sichtbar = new Set();

export function renderGantt(sol, fahrzeuge, abteilungen, T, deadline, bezeichnung, startIso, auslastung, info = () => null) {
    // Farben den tatsaechlich vorhandenen Abteilungen zuordnen,
    // damit auch DB-Abteilungen ausserhalb der Demo-Daten eingefaerbt werden.
    // Die Zuordnung haengt nicht vom Filter ab, die Farben bleiben also stabil.
    const colors = {};
    abteilungen.forEach((j, idx) => {
        colors[j] = PALETTE[idx % PALETTE.length];
    });

    plan = { sol, fahrzeuge, abteilungen, T, deadline, bezeichnung, startIso, colors, auslastung, info };
    sichtbar.clear();
    abteilungen.forEach(j => sichtbar.add(j));

    zeichneGantt();
    zeichneFilter();
    zeichneLegende();
}

// Auslastung einer Abteilung ueber den ganzen Zeitraum in Prozent (nach Werktagen gewichtet)
function gesamtAuslastung(j) {
    const { wochen, zeilen } = plan.auslastung;
    const zeile = zeilen.find(z => z.name === j);
    if (!zeile) return 0;

    const tage = wochen.reduce((sum, w) => sum + w.tage.length, 0);
    return zeile.prozent.reduce((sum, p, k) => sum + p * wochen[k].tage.length, 0) / tage;
}

// Tooltip einer Abteilung: Auslastung ueber den ganzen Zeitraum und je Kalenderwoche
function auslastungsText(j) {
    const { wochen, zeilen } = plan.auslastung;
    const zeile = zeilen.find(z => z.name === j);
    if (!zeile) return j;

    const proWoche = wochen.map((w, k) => `KW ${isoKalenderwoche(w.montag)}: ${Math.round(zeile.prozent[k])} %`);
    return [`${j}: Auslastung gesamt ${Math.round(gesamtAuslastung(j))} %`, ...proWoche].join('\n');
}

// Fahrzeuge, die in mindestens einer der angezeigten Abteilungen arbeiten
function fahrzeugeMitArbeit() {
    const { sol, fahrzeuge, abteilungen, T } = plan;
    return fahrzeuge.filter(i =>
        abteilungen.some(j => sichtbar.has(j)
            && Array.from({ length: T }, (_, k) => arbeitsmenge(sol, i, j, k + 1)).some(v => v > 0.01)));
}

// Filter-Buttons: eine Schaltflaeche je Abteilung (Ein/Aus) plus "Alle"
function zeichneFilter() {
    const box = document.getElementById('gantt-filter');
    if (!box) return;
    box.innerHTML = '';

    const { abteilungen, fahrzeuge, colors } = plan;

    const alle = document.createElement('button');
    alle.type = 'button';
    alle.className = 'filter-btn' + (sichtbar.size === abteilungen.length ? ' aktiv' : '');
    alle.textContent = 'Alle';
    alle.onclick = () => {
        abteilungen.forEach(j => sichtbar.add(j));
        zeichneGantt();
        zeichneFilter();
    };
    box.appendChild(alle);

    for (const j of abteilungen) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filter-btn' + (sichtbar.has(j) ? ' aktiv' : '');
        btn.style.setProperty('--farbe', colors[j]);
        btn.textContent = `${j} Auslastung ${Math.round(gesamtAuslastung(j))} %`;
        btn.dataset.tip = auslastungsText(j);
        btn.onclick = () => {
            if (sichtbar.has(j)) sichtbar.delete(j);
            else sichtbar.add(j);
            zeichneGantt();
            zeichneFilter();
        };
        box.appendChild(btn);
    }

    const info = document.createElement('span');
    info.className = 'filter-info';
    info.textContent = `${fahrzeugeMitArbeit().length} von ${fahrzeuge.length} Fahrzeugen`;
    box.appendChild(info);
}

function zeichneGantt() {
    const { sol, abteilungen, T, deadline, bezeichnung, startIso, colors, info } = plan;

    const container = document.getElementById('gantt');
    if (!container) return;
    container.innerHTML = '';

    if (!sichtbar.size) {
        container.style.display = 'block';
        container.textContent = 'Keine Abteilung ausgewählt.';
        return;
    }

    container.style.display = 'grid';
    container.style.gridTemplateColumns = `230px repeat(${T}, minmax(46px, 1fr))`;
    container.style.gap = '4px';
    container.style.alignItems = 'center';
    container.style.fontFamily = 'sans-serif';

    // Kopfzeile (die Ecke oben links bleibt beim horizontalen Scrollen wie die Labels fixiert)
    const ecke = document.createElement('div');
    ecke.className = 'gantt-fix';
    container.appendChild(ecke);
    for (let t = 1; t <= T; t++) {
        const h = document.createElement('div');
        const datum = werktagDatum(startIso, t);
        h.innerHTML = `T${t}<br>${datum.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })}`;
        h.dataset.tip = formatDatum(datum, true);
        h.style.cssText = 'font-size:10px;color:#666;text-align:center;padding-bottom:4px;line-height:1.3';
        container.appendChild(h);
    }

    // Eine Zeile pro Fahrzeug (nur Fahrzeuge mit Arbeit in den angezeigten Abteilungen)
    for (const i of fahrzeugeMitArbeit()) {
        const label = document.createElement('div');
        // Leistungsumfang und Gesamtstunden nur als Tooltip
        const zusatz = info(i);
        label.textContent = zusatz?.status ? `${bezeichnung(i)} ${zusatz.status}` : bezeichnung(i);
        if (zusatz) label.dataset.tip = zusatz.tooltip;
        label.className = 'fzg-label gantt-fix' + (zusatz?.zap ? ' zap' : '');
        container.appendChild(label);

        for (let t = 1; t <= T; t++) {
            const cell = document.createElement('div');
            cell.style.cssText = 'height:32px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;background:#eee;';

            // Welche (angezeigte) Abteilung ist an diesem Tag aktiv?
            let activeDept = null;
            let mitarbeiter = 0;
            for (const j of abteilungen) {
                if (!sichtbar.has(j)) continue;
                const val = arbeitsmenge(sol, i, j, t);
                if (val > 0.01) {
                    activeDept = j;
                    mitarbeiter = val;
                    break;
                }
            }

            if (activeDept) {
                const farbe = colors[activeDept];
                const verspaetet = t > deadline[i];

                // Arbeit nach der Deadline schraffiert darstellen
                cell.style.background = verspaetet
                    ? `repeating-linear-gradient(45deg, ${farbe}, ${farbe} 5px, #cc0000 5px, #cc0000 10px)`
                    : farbe;
                cell.style.color = '#fff';
                cell.textContent = activeDept[0];
                cell.dataset.tip = `${bezeichnung(i)}: ${activeDept}, Tag ${t} (${formatDatum(werktagDatum(startIso, t), true)}, ${Math.round(mitarbeiter)} Mitarbeiter)`
                    + (verspaetet ? ' - NACH DEADLINE' : '');
            }

            if (t === deadline[i]) {
                cell.style.boxShadow = 'inset 0 0 0 2px #cc0000';
            }

            container.appendChild(cell);
        }
    }
}

function zeichneLegende() {
    const legend = document.getElementById('gantt-legend');
    if (!legend) return;
    legend.innerHTML = '';
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;font-size:12px;color:#555;font-family:sans-serif;';

    for (const [name, color] of Object.entries(plan.colors)) {
        const item = document.createElement('span');
        item.style.cssText = 'display:flex;align-items:center;gap:6px';
        item.innerHTML = `<span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block"></span>${name}`;
        item.dataset.tip = auslastungsText(name);
        legend.appendChild(item);
    }

    const deadlineNote = document.createElement('span');
    deadlineNote.style.cssText = 'display:flex;align-items:center;gap:6px';
    deadlineNote.innerHTML = '<span style="width:10px;height:10px;border-radius:2px;border:2px solid #cc0000;display:inline-block"></span>Deadline-Tag';
    legend.appendChild(deadlineNote);

    const verzugNote = document.createElement('span');
    verzugNote.style.cssText = 'display:flex;align-items:center;gap:6px';
    verzugNote.innerHTML = '<span style="width:10px;height:10px;border-radius:2px;display:inline-block;'
        + 'background:repeating-linear-gradient(45deg,#888,#888 3px,#cc0000 3px,#cc0000 6px)"></span>nach Deadline';
    legend.appendChild(verzugNote);
}

// ============================
// Auslastung pro Woche
// ============================

// ISO-Kalenderwoche (Woche beginnt Montag, KW 1 enthaelt den ersten Donnerstag)
function isoKalenderwoche(d) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
    const jahresanfang = Date.UTC(x.getUTCFullYear(), 0, 1);
    return Math.ceil(((x - jahresanfang) / 86400000 + 1) / 7);
}

function montagDerWoche(d) {
    const m = new Date(d);
    m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
    return m;
}

// Auslastung je Abteilung und Kalenderwoche in Prozent:
// eingesetzte Mitarbeiter-Tage / (Mitarbeiter pro Tag * Werktage der Woche im Planungszeitraum).
// Angebrochene Wochen am Rand zaehlen nur mit den Tagen, die im Planungszeitraum liegen.
export function berechneAuslastung(sol, fahrzeuge, abteilungen, T, kapazitaet, startIso) {
    const wochen = []; // { montag, tage: [t, ...] }

    for (let t = 1; t <= T; t++) {
        const montag = montagDerWoche(werktagDatum(startIso, t));
        const key = montag.getTime();
        let woche = wochen.find(w => w.montag.getTime() === key);
        if (!woche) {
            woche = { montag, tage: [] };
            wochen.push(woche);
        }
        woche.tage.push(t);
    }

    const zeilen = abteilungen.map(j => ({
        name: j,
        prozent: wochen.map(w => {
            const genutzt = w.tage.reduce((sum, t) =>
                sum + fahrzeuge.reduce((s, i) => s + arbeitsmenge(sol, i, j, t), 0), 0);
            return 100 * genutzt / (kapazitaet[j] * w.tage.length);
        })
    }));

    const summeKap = abteilungen.reduce((s, j) => s + kapazitaet[j], 0);
    const gesamt = wochen.map((w, k) => {
        const genutzt = zeilen.reduce((s, z, idx) =>
            s + z.prozent[k] / 100 * kapazitaet[abteilungen[idx]] * w.tage.length, 0);
        return 100 * genutzt / (summeKap * w.tage.length);
    });

    return { wochen, zeilen, gesamt };
}

export function renderAuslastung(auslastung) {
    const box = document.getElementById('auslastung');
    if (!box) return;
    box.innerHTML = '';

    const { wochen, zeilen, gesamt } = auslastung;

    const titel = document.createElement('h2');
    titel.textContent = 'Auslastung pro Woche';
    box.appendChild(titel);

    const tabelle = document.createElement('table');
    tabelle.className = 'auslastung';

    const kopf = document.createElement('tr');
    kopf.appendChild(zelle('th', 'Abteilung'));
    for (const w of wochen) {
        const freitag = new Date(w.montag);
        freitag.setUTCDate(freitag.getUTCDate() + 4);
        const kurz = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
        const th = zelle('th', `KW ${isoKalenderwoche(w.montag)}`);
        th.appendChild(document.createElement('br'));
        const datum = document.createElement('small');
        datum.textContent = `${kurz(w.montag)}–${kurz(freitag)}`;
        th.appendChild(datum);
        kopf.appendChild(th);
    }
    tabelle.appendChild(kopf);

    const zeile = (name, werte, farbe, fett) => {
        const tr = document.createElement('tr');
        if (fett) tr.className = 'gesamt';
        tr.appendChild(zelle('th', name));
        for (const p of werte) {
            const td = zelle('td', `${Math.round(p)} %`);
            // Balken im Hintergrund: Fuellung entspricht der Auslastung
            td.style.background = `linear-gradient(to right, ${farbe}55 ${p}%, transparent ${p}%)`;
            tr.appendChild(td);
        }
        tabelle.appendChild(tr);
    };

    zeilen.forEach((z, idx) => zeile(z.name, z.prozent, PALETTE[idx % PALETTE.length], false));
    zeile('Gesamt', gesamt, '#003A70', true);

    const scroll = document.createElement('div');
    scroll.className = 'auslastung-scroll';
    scroll.appendChild(tabelle);
    box.appendChild(scroll);
}

function zelle(tag, text) {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
}

// Strafgewicht pro verspaetetem Mitarbeiter-Tag: flach, unabhaengig davon, an welchem Tag
// t die Arbeit nach der Deadline stattfindet (anders als vorher, mit t^2 multipliziert).
// Muss deutlich groesser sein als die regulaeren Zielkosten (max. T * Gesamtaufwand),
// damit der Solver Verspaetung nur waehlt, wenn sie unvermeidbar ist.
const STRAFKOSTEN = 1000;

// Randbedingungstypen fuer bounds/constraints in baueModell(): FX = fest (Untergrenze ==
// Obergrenze), LO = nur Untergrenze (Obergrenze unbeschraenkt), UP = nur Obergrenze
// (Untergrenze unbeschraenkt). zuHighsModell() setzt daraus die HiGHS-Spalten-/Zeilengrenzen.
const FX = 'fx';
const LO = 'lo';
const UP = 'up';

// Zeitlimit fuer den Solver in Sekunden (Eingabefeld, Standard 120; siehe solveOptimization)
function zeitlimitSek() {
    return Number.parseInt(document.getElementById('zeitlimit')?.value, 10) || 120;
}

// Demo-Daten, falls die DB nicht erreichbar ist
const DEMO_DATEN = {
    fahrzeuge: ['F1', 'F2', 'F3'],
    abteilungen: ['Karosserie', 'Lack', 'Elektrik'],
    T: 10,
    deadline: { F1: 5, F2: 8, F3: 10 },
    kapazitaet: { Karosserie: 4, Lack: 2, Elektrik: 3 },
    aufwand: {
        'F1_Karosserie': 4, 'F1_Lack': 2, 'F1_Elektrik': 3,
        'F2_Karosserie': 6, 'F2_Lack': 4, 'F2_Elektrik': 2,
        'F3_Karosserie': 5, 'F3_Lack': 3, 'F3_Elektrik': 6,
    }
};

// Max. Mitarbeiter je Fahrzeug und Abteilung pro Tag (Eingabefeld, Standard 2)
function maxProFahrzeug() {
    return Number.parseInt(document.getElementById('maxFzg')?.value, 10) || 2;
}

// Zeithorizont fuer Fahrzeuge in Kalendertagen (Eingabefeld, Standard 180): beruecksichtigt werden
// Fahrzeuge, die bereits angeliefert sind oder in den naechsten Tagen angeliefert werden
function zeithorizontTage() {
    return Number.parseInt(document.getElementById('zeithorizont')?.value, 10) || 180;
}

// Laufender Durchgang (null, wenn nichts laeuft). abbrechen() beendet das Laden der
// Daten (fetch) und den Solver (Web Worker highs-worker.js).
class AbbruchFehler extends Error {}

let lauf = null;

function abbrechen() {
    if (!lauf || lauf.abgebrochen) return;
    lauf.abgebrochen = true;
    lauf.controller.abort();
    lauf.worker?.terminate(); // killt den Worker; ein laufender Solve meldet sich danach nie mehr
    lauf.beendeSolve?.(); // ... deshalb wird das Warten darauf hier aufgeloest
}

// Zeigt Spinner und verstrichene Sekunden, solange geladen bzw. gerechnet wird
let laufzeitTimer = null;

function setzeLaufZustand(laeuft) {
    const start = document.getElementById('btn-start');
    const stop = document.getElementById('btn-abbrechen');
    const spinner = document.getElementById('spinner');
    const zeit = document.getElementById('laufzeit');
    if (start) start.disabled = laeuft;
    if (stop) stop.disabled = !laeuft;
    if (spinner) spinner.hidden = !laeuft;

    clearInterval(laufzeitTimer);
    if (zeit) {
        zeit.textContent = '';
        if (laeuft) {
            const t0 = Date.now();
            zeit.textContent = 'läuft … 0 s';
            laufzeitTimer = setInterval(() => {
                zeit.textContent = `läuft … ${Math.floor((Date.now() - t0) / 1000)} s`;
            }, 1000);
        }
    }
}

// Planungsdaten aus der Oracle-DB laden (ueber /api/planung -> Fahrzeuge.js -> db.js)
async function ladePlanungsdaten() {
    try {
        // Mitarbeiter pro Tag je Abteilung (Felder .kapazitaet) gelten fuer die Excel-Daten;
        // die DB liefert eigene Werte
        const params = new URLSearchParams();
        document.querySelectorAll('input.kapazitaet').forEach(input => {
            params.set(`kap_${input.dataset.abteilung}`, input.value || 3);
        });
        params.set('max_fzg', maxProFahrzeug());
        params.set('horizont', zeithorizontTage());
        if (document.getElementById('liefprio')?.checked) params.set('liefprio', '1');
        const datum = document.getElementById('berechnungsdatum')?.value;
        if (datum) params.set('start', datum);
        const res = await fetch(`/api/planung?${params}`, { signal: lauf?.controller.signal });

        if (res.status === 404) {
            throw new Error('API nicht gefunden - Seite ueber den Node-Server oeffnen (npm start, http://localhost:3000), nicht ueber Live Server');
        }

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }

        const daten = await res.json();

        if (!daten.fahrzeuge?.length) {
            throw new Error('Tabelle fahrzeugplanung ist leer');
        }

        daten.maxProFahrzeug = maxProFahrzeug(); // gilt fuer alle Datenquellen
        // Excel-Antworten eines veralteten Servers haben kein info -> Tooltip an der Fahrzeugnummer bliebe leer
        if (daten.quelle === 'Excel' && !daten.info) {
            print('Hinweis: Der Server läuft noch mit altem Stand (keine Fahrzeug-Infos) - bitte Server neu starten (Strg+C, dann npm start).\n');
        }
        const mitPrio = daten.prio ? Object.keys(daten.prio).length : 0;
        print(`Daten aus ${daten.quelle ?? 'DB'} geladen: ${daten.fahrzeuge.length}${daten.anzahlAuftraege ? ` von ${daten.anzahlAuftraege}` : ''} Fahrzeuge, ${daten.abteilungen.length} Abteilungen, ${daten.T} Tage\n`);
        if (daten.liefprioAktiv) {
            print(`Lieferprio berücksichtigt: ${mitPrio} von ${daten.fahrzeuge.length} Fahrzeugen haben eine gesetzte Lieferprio.\n`);
        }
        return daten;
    } catch (err) {
        if (err.name === 'AbortError') throw new AbbruchFehler();
        print(`Weder DB noch Excel verfuegbar (${err.message}) - nutze Demo-Daten.\n`);
        return DEMO_DATEN;
    }
}

// Baut das MILP aus den Planungsdaten. Als eigene Funktion, damit das Modell
// ohne DOM und ohne Browser-Worker getestet werden kann (siehe test-solver.mjs).
//
// Formulierung: Die Arbeit einer Abteilung j an einem Fahrzeug i ist EIN
// zusammenhaengender Block ("ein Fahrzeug fertig machen, dann das naechste").
// Fuer jede Kombination (i, j) gibt es Blockvarianten u_i_j_w_s: ab Starttag s
// arbeiten w Mitarbeiter je Tag, am letzten Tag der Rest. Genau eine Variante
// wird gewaehlt. Das ist als "zeitindizierte" Formulierung viel staerker als
// Big-M-Kopplungen mit Start-Variablen (der Solver findet damit auch bei 40+
// Fahrzeugen schnell eine Loesung).
//
// Die Variablen x_i_j_t (bis zur Deadline) und z_i_j_t (danach) bleiben erhalten:
// sie sind die Mitarbeiter je Tag, folgen aus der gewaehlten Variante und tragen
// die Kosten. Ausgabe, Gantt und Auslastung lesen weiterhin nur x und z.
//
// Das Modell ist absichtlich solver-unabhaengig (keine glpk.js/HiGHS-Typen hier):
// vars sind alle Spalten (Objective-Koeffizient je Variable), constraints die Zeilen
// (Terme + Randbedingungstyp), bounds die von 0..unbeschraenkt abweichenden
// Variablengrenzen, binaries die ganzzahligen 0/1-Variablen. zuHighsModell() unten
// macht daraus das numerische HiGHS-Modell.
export function baueModell(daten) {
    const {
        fahrzeuge,
        abteilungen,
        T,
        deadline,
        kapazitaet,
        aufwand,
        maxProFahrzeug = Infinity, // max. Mitarbeiter je Fahrzeug und Abteilung pro Tag
        verfuegbarAb = {}, // Fahrzeug -> erster Tag, an dem es bearbeitet werden darf (Anlieferung); Standard 1
        prio = {}, // Fahrzeug -> Lieferprio (Spalte "Lieferprio"), nur gesetzt wenn vorhanden; 1 = hoechste Prioritaet
        liefprioAktiv = false // Schaltflaeche "Lieferprio beruecksichtigen" in der GUI
    } = daten;

    const ab = i => verfuegbarAb[i] ?? 1;

    // Mitarbeiter je Tag: bis zur Deadline x, danach z (nur eine der beiden existiert)
    const tagesVar = (i, j, t) => `${t <= deadline[i] ? 'x' : 'z'}_${i}_${j}_t${t}`;

    // Weicher Sicherheitsabstand: Arbeit soll moeglichst 1 Tag vor der Deadline fertig sein.
    // Deshalb kostet Arbeit genau am Deadline-Tag selbst einen Aufschlag - teurer als jeder
    // normale Tag (>= T, schiebt die Arbeit lieber einen Tag frueher, wenn Kapazitaet frei
    // ist), aber immer noch deutlich guenstiger als echte Verspaetung (STRAFKOSTEN), falls
    // kein frueherer Tag mehr frei ist. Bleibt die Deadline dabei bewusst die "echte" Grenze:
    // Arbeit am Deadline-Tag zaehlt weiterhin als x (puenktlich), nicht als z (verspaetet).
    const PUFFERSTRAFE = T + 1;

    // Verspaetete Arbeit (z) bekommt einen winzigen, mit dem Tag wachsenden Zuschlag oben auf
    // die flache STRAFKOSTEN: so bleibt die Grundstrafe fuer alle z-Tage nahezu gleich (kein
    // Vorrang vor puenktlichen Fahrzeugen mehr, siehe unten), aber unter mehreren moeglichen
    // Tagen fuer dieselbe verspaetete Arbeit ist der fruehere weiterhin (minimal) guenstiger -
    // ueberfaellige Fahrzeuge werden also weiterhin so frueh wie moeglich fertig. Der Zuschlag
    // ist bewusst so klein gewaehlt (Summe ueber den ganzen Horizont bleibt unter 1), dass er
    // niemals eine Verzoegerung eines puenktlichen Fahrzeugs (Kosten mindestens 1 pro Tag)
    // aufwiegen kann - die Prioritaet "puenktlich vor ueberfaellig" bleibt also erhalten.
    const VERSPAETUNGS_AUFSCHLAG = 1 / (2 * T);

    // Lieferprio (Spalte "Lieferprio" aus der Excel, ueber die Schaltflaeche "Lieferprio
    // beruecksichtigen" an-/abschaltbar): 1 = Liefertermin muss unter allen Umstaenden erreicht
    // werden, je groesser die Zahl, desto niedriger die Prioritaet. Fahrzeuge ohne Wert bleiben
    // bei der normalen STRAFKOSTEN. PRIO_FAKTOR ist bewusst gross gewaehlt, damit Prio 1 einer
    // harten Grenze so nahe wie moeglich kommt, ohne das Modell durch eine echte harte
    // Restriktion unloesbar machen zu koennen.
    const PRIO_FAKTOR = 1000;
    const strafkosten = i => {
        const p = prio[i];
        return liefprioAktiv && p > 0 ? STRAFKOSTEN * PRIO_FAKTOR / p : STRAFKOSTEN;
    };

    const vars = [];
    const constraints = [];
    const bounds = [];
    const binaries = [];

    // ============================
    // Variablen: Mitarbeiter je Tag (mit Kosten)
    // ============================
    // Nur fuer Fahrzeug/Abteilung-Paare mit Aufwand: ohne Aufwand waere die Variable immer 0
    // und wuerde das Modell nur unnoetig vergroessern.
    for (const i of fahrzeuge) {
        for (const j of abteilungen) {
            if (!(aufwand[`${i}_${j}`] > 0)) continue;
            for (let t = 1; t <= T; t++) {
                const name = tagesVar(i, j, t);
                // x vor dem Deadline-Tag: Kosten t (frueh ist billig).
                // x am Deadline-Tag selbst: PUFFERSTRAFE (siehe oben).
                // z (nach der Deadline): Grundstrafe (mit Lieferprio hochskaliert, siehe oben)
                // + winziger Aufschlag pro Tag.
                const coef = t > deadline[i] ? strafkosten(i) + t * VERSPAETUNGS_AUFSCHLAG
                    : t === deadline[i] ? PUFFERSTRAFE
                        : t;
                vars.push({ name, coef });
                // Vor der Anlieferung darf am Fahrzeug nicht gearbeitet werden
                bounds.push(t < ab(i)
                    ? { name, type: FX, lb: 0, ub: 0 }
                    : { name, type: LO, lb: 0 });
            }
        }
    }

    // ============================
    // Variablen: Blockvarianten, dazu Aufwand-, Kopplungs- und Exklusivitaets-Bedingungen
    // ============================
    // Je Fahrzeug und Tag: alle Blockvarianten, die an dem Tag Arbeit haben
    const belegung = new Map(fahrzeuge.map(i => [i, Array.from({ length: T + 1 }, () => [])]));

    for (const i of fahrzeuge) {
        for (const j of abteilungen) {
            const a = aufwand[`${i}_${j}`];
            if (!(a > 0)) continue; // ohne Aufwand: nichts einplanen, keine Variablen
            const proTag = Array.from({ length: T + 1 }, () => []); // t -> [{ name, menge }]
            const waehle = [];

            const maxW = Math.min(kapazitaet[j], maxProFahrzeug, Math.ceil(a));
            for (let w = 1; w <= maxW; w++) {
                const dauer = Math.ceil(a / w);
                const rest = a - w * (dauer - 1); // Menge am letzten Tag (0 < rest <= w)

                // Block fruehestens am Anlieferungstag starten
                for (let s = ab(i); s + dauer - 1 <= T; s++) {
                    const name = `u_${i}_${j}_w${w}_s${s}`;
                    vars.push({ name, coef: 0 });
                    binaries.push(name);
                    waehle.push({ name, coef: 1 });

                    for (let k = 0; k < dauer; k++) {
                        const t = s + k;
                        proTag[t].push({ name, menge: k === dauer - 1 ? rest : w });
                        belegung.get(i)[t].push({ name, coef: 1 });
                    }
                }
            }

            // Genau eine Blockvariante waehlen.
            // Passt keine Variante in den Horizont, ist das Modell unloesbar (leere Summe = 1).
            constraints.push({
                name: `Block_${i}_${j}`,
                vars: waehle.length ? waehle : [{ name: tagesVar(i, j, 1), coef: 0 }],
                bnds: { type: FX, lb: 1, ub: 1 }
            });

            // Tagesmenge = Summe der Mengen der gewaehlten Variante
            for (let t = 1; t <= T; t++) {
                constraints.push({
                    name: `Menge_${i}_${j}_t${t}`,
                    vars: [
                        { name: tagesVar(i, j, t), coef: 1 },
                        ...proTag[t].map(({ name, menge }) => ({ name, coef: -menge }))
                    ],
                    bnds: { type: FX, lb: 0, ub: 0 }
                });
            }
        }
    }

    // Kapazitaet: Summe ueber alle Fahrzeuge je Abteilung und Tag
    for (const j of abteilungen) {
        const mitAufwand = fahrzeuge.filter(i => aufwand[`${i}_${j}`] > 0);
        if (!mitAufwand.length) continue;
        for (let t = 1; t <= T; t++) {
            constraints.push({
                name: `Kapazitaet_${j}_t${t}`,
                vars: mitAufwand.map(i => ({ name: tagesVar(i, j, t), coef: 1 })),
                bnds: { type: UP, ub: kapazitaet[j] }
            });
        }
    }

    // Exklusivitaet: an einem Fahrzeug arbeitet pro Tag hoechstens eine Abteilung
    for (const i of fahrzeuge) {
        for (let t = 1; t <= T; t++) {
            const aktiv = belegung.get(i)[t];
            if (aktiv.length <= 1) continue;
            constraints.push({
                name: `Exklusivitaet_${i}_t${t}`,
                vars: aktiv,
                bnds: { type: UP, ub: 1 }
            });
        }
    }

    return { vars, constraints, bounds, binaries };
}

// baueModell()-Ausgabe (Namen, Terme) -> numerisches HiGHS-Modell: dichte Spaltenvektoren
// (Kosten, Grenzen, Ganzzahligkeit) und die Restriktionsmatrix im CSR-Format (eine Zeile pro
// Restriktion, so wie constraints ohnehin aufgebaut ist). Die Spaltenreihenfolge entspricht
// exakt vars; loeseMitHighs() nutzt das, um die geloesten Werte den Variablennamen zuzuordnen.
// Namen gehen dabei bewusst nicht ins HiGHS-Modell (colNames/rowNames): bei den grossen
// Modellen (teils >100.000 Spalten/Zeilen) spart das unnoetiges Kopieren in den Wasm-Speicher.
export function zuHighsModell({ vars, constraints, bounds, binaries }) {
    const spalte = new Map(vars.map((v, k) => [v.name, k]));
    const numCols = vars.length;
    const numRows = constraints.length;

    const colCost = new Float64Array(numCols);
    vars.forEach((v, k) => { colCost[k] = v.coef; });

    // Standardgrenzen 0..unbeschraenkt; bounds/binaries setzen davon abweichende Werte
    const colLower = new Float64Array(numCols);
    const colUpper = new Float64Array(numCols).fill(Infinity);
    for (const b of bounds) {
        const k = spalte.get(b.name);
        colLower[k] = b.lb;
        colUpper[k] = b.type === FX ? b.ub : Infinity;
    }

    const integrality = new Int32Array(numCols); // 0 = stetig (Standard)
    for (const name of binaries) {
        const k = spalte.get(name);
        integrality[k] = 1; // 1 = ganzzahlig (siehe highs.constants.variableType)
        if (colUpper[k] === Infinity) colUpper[k] = 1; // ohne eigene bounds: binaer = 0..1
    }

    const rowLower = new Float64Array(numRows);
    const rowUpper = new Float64Array(numRows);
    const starts = new Int32Array(numRows + 1);
    const indices = [];
    const values = [];
    constraints.forEach((c, i) => {
        starts[i] = indices.length;
        for (const { name, coef } of c.vars) {
            indices.push(spalte.get(name));
            values.push(coef);
        }
        rowLower[i] = c.bnds.type === UP ? -Infinity : c.bnds.lb;
        rowUpper[i] = c.bnds.ub;
    });
    starts[numRows] = indices.length;

    return {
        numCols,
        numRows,
        colCost,
        colLower,
        colUpper,
        rowLower,
        rowUpper,
        matrix: { format: 'csr', numRows, numCols, starts, indices: Int32Array.from(indices), values: Float64Array.from(values) },
        integrality
    };
}

// HiGHS-Modellstatus, den solveOptimization() auswertet (siehe node_modules/highs/types.d.ts,
// ModelStatusCode bzw. highs.constants.modelStatus): 7 = optimal bewiesen, 13 = Zeitlimit erreicht.
export const HIGHS_STATUS = { optimal: 7, timeLimit: 13 };

// Nachbearbeitung der geloesten sol (nicht Teil des MILP): schiebt Abteilungsbloecke eines
// Fahrzeugs so weit wie moeglich zusammen, damit es nicht laenger als noetig auf dem
// Stellplatz steht. Ein direkter Versuch, Luecken IM Solver zu bestrafen (zusaetzliche
// Spannweiten-Variablen je Fahrzeug + Big-M-Restriktionen), hat das Modell bei den echten
// Datenmengen unloesbar gemacht (Big-M schwaecht die LP-Relaxation stark) - deshalb hier als
// billige Nachbesserung nach dem Solve, ohne den Solver selbst zu belasten.
//
// Blöcke werden ausschliesslich FRUEHER geschoben, nie spaeter, und nur in Kapazitaet, die zum
// Zeitpunkt der Verschiebung tatsaechlich frei ist (nie in Tage, die andere Fahrzeuge belegen).
// Das kann eine Deadline dadurch nur verbessern, nie verschlechtern, und aendert nichts an
// Aufwand, Kapazitaetsauslastung oder Exklusivitaet - nur WANN genau gearbeitet wird.
export function verdichteLuecken(daten, sol) {
    const { fahrzeuge, abteilungen, T, deadline, kapazitaet, verfuegbarAb = {} } = daten;
    const ab = i => verfuegbarAb[i] ?? 1;
    const wert = (i, j, t) => (sol[`x_${i}_${j}_t${t}`] || 0) + (sol[`z_${i}_${j}_t${t}`] || 0);

    // Aktuelle Kapazitaetsnutzung je Abteilung/Tag (Summe ueber alle Fahrzeuge) - wird beim
    // Verschieben live nachgefuehrt, damit nie mehr als kapazitaet[j] belegt wird.
    const belegt = {};
    for (const j of abteilungen) {
        for (let t = 1; t <= T; t++) {
            belegt[`${j}_${t}`] = fahrzeuge.reduce((summe, i) => summe + wert(i, j, t), 0);
        }
    }

    const neu = { ...sol };

    for (const i of fahrzeuge) {
        // Bloecke dieses Fahrzeugs: zusammenhaengende Tagesfolgen je Abteilung, in der
        // geloesten Reihenfolge (nach Starttag) - mehr als eine Abteilung am selben Tag
        // gibt es wegen der Exklusivitaet ohnehin nicht.
        const bloecke = [];
        for (const j of abteilungen) {
            let block = null;
            for (let t = 1; t <= T; t++) {
                const menge = wert(i, j, t);
                if (menge > 0.01) {
                    if (!block) block = { j, start: t, tage: [] };
                    block.tage.push(menge);
                } else if (block) {
                    bloecke.push(block);
                    block = null;
                }
            }
            if (block) bloecke.push(block);
        }
        bloecke.sort((a, b) => a.start - b.start);

        // Der erste Block bleibt unangetastet: ihn moeglichst frueh zu schieben, OHNE
        // Ruecksicht auf die folgenden Bloecke, wuerde die Spanne des Fahrzeugs eher
        // vergroessern als verkleinern (der erste Block waere frueher, aber der letzte bliebe
        // gleich weit hinten). Ab dem zweiten Block wird jeweils nur die Luecke zum direkt
        // vorherigen (ggf. schon verschobenen) Block geschlossen - das verkuerzt die Spanne
        // garantiert, egal ob die Luecke ganz oder nur teilweise geschlossen werden kann.
        let fruehesterStart = bloecke.length ? bloecke[0].start + bloecke[0].tage.length : ab(i);
        for (const block of bloecke.slice(1)) {
            const dauer = block.tage.length;
            let neuerStart = block.start;

            // Fruehesten Tag suchen, ab dem der ganze Block (alle Tage mit ihrem bisherigen
            // Besetzungsmuster) in freie Kapazitaet passt.
            for (let kandidat = fruehesterStart; kandidat < block.start; kandidat++) {
                let passt = true;
                for (let k = 0; k < dauer; k++) {
                    if (belegt[`${block.j}_${kandidat + k}`] + block.tage[k] > kapazitaet[block.j] + 1e-9) {
                        passt = false;
                        break;
                    }
                }
                if (passt) {
                    neuerStart = kandidat;
                    break;
                }
            }

            if (neuerStart < block.start) {
                for (let k = 0; k < dauer; k++) {
                    const alterTag = block.start + k;
                    const neuerTag = neuerStart + k;
                    const menge = block.tage[k];

                    belegt[`${block.j}_${alterTag}`] -= menge;
                    belegt[`${block.j}_${neuerTag}`] += menge;

                    delete neu[`x_${i}_${block.j}_t${alterTag}`];
                    delete neu[`z_${i}_${block.j}_t${alterTag}`];
                    neu[`${neuerTag <= deadline[i] ? 'x' : 'z'}_${i}_${block.j}_t${neuerTag}`] = menge;
                }
                block.start = neuerStart;
            }

            fruehesterStart = block.start + dauer;
        }
    }

    return neu;
}

// Baut und loest das Modell mit einer bereits geladenen HiGHS-Instanz. Eigene Funktion, damit
// der Web Worker (highs-worker.js) und die Tests (test-solver.mjs) dieselbe Loesungs-Extraktion
// nutzen. sol enthaelt nur Werte spuerbar ueber 0 (der Rest gilt beim Lesen ohnehin als 0, siehe
// arbeitsmenge()) - bei den grossen Modellen spart das viel Speicher/Transferzeit zum Worker.
export function loeseMitHighs(highs, daten, zeitlimit) {
    const modell = baueModell(daten);
    const model = highs.createModel(zuHighsModell(modell));
    try {
        model.options.set({
            output_flag: false,
            ...(Number.isFinite(zeitlimit) ? { time_limit: zeitlimit } : {})
        });
        model.run();

        const status = model.getModelStatus();
        const feasible = model.info.get('primal_solution_status') === highs.constants.solutionStatus.feasible;

        const sol = {};
        if (feasible) {
            const { colValue } = model.getSolution();
            modell.vars.forEach((v, k) => {
                const wert = colValue[k];
                if (Math.abs(wert) > 1e-6) sol[v.name] = wert;
            });
        }

        return { status, feasible, sol: feasible ? verdichteLuecken(daten, sol) : sol };
    } finally {
        model.dispose();
    }
}

async function solveOptimization() {
    const daten = await ladePlanungsdaten();
    if (lauf.abgebrochen) throw new AbbruchFehler();

    const { fahrzeuge, abteilungen, T, deadline } = daten;
    // Anzeigename (Fahrgestellnummer); DB- und Demo-Daten haben keinen -> ID
    const bezeichnung = i => daten.bezeichnung?.[i] ?? i;
    // Tag 1 = startDatum der Excel-Daten, sonst heute (lokales Datum)
    const heute = new Date();
    const startIso = daten.startDatum
        ?? `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}`;

    print(`Planungshorizont T = ${T} Werktage (Tag 1 = ${formatDatum(werktagDatum(startIso, 1), true)}, Tag ${T} = ${formatDatum(werktagDatum(startIso, T), true)})\n`);

    // ============================
    // Solve im Web Worker (HiGHS/WebAssembly)
    // ============================
    // Zeitlimit als Schutz bei grossen Datenmengen; dann ist der Plan zulaessig,
    // aber nicht als optimal bewiesen (feasible, aber Status != optimal)
    const zeitlimit = zeitlimitSek();
    print(`Solver läuft (höchstens ${zeitlimit} s, mit „Abbrechen“ früher beendbar) ...`);

    const worker = new Worker(new URL('./highs-worker.js', import.meta.url), { type: 'module' });
    lauf.worker = worker;

    const abbruch = new Promise(resolve => { lauf.beendeSolve = resolve; });
    const antwort = new Promise((resolve, reject) => {
        worker.onmessage = e => resolve(e.data);
        worker.onerror = e => reject(new Error(e.message));
    });
    worker.postMessage({ daten, zeitlimit });

    const ergebnis = await Promise.race([antwort, abbruch]);
    if (lauf.abgebrochen) throw new AbbruchFehler();
    if (!ergebnis.ok) throw new Error(ergebnis.error);

    const { status, feasible, sol } = ergebnis;
    print(`Status: ${status}`);

    if (!feasible) {
        print(status === HIGHS_STATUS.timeLimit
            ? `Zeitlimit von ${zeitlimit} s erreicht, bevor eine Lösung gefunden wurde - Kapazität erhöhen oder weniger Fahrzeuge planen.`
            : "Keine zulässige Lösung gefunden.");
        worker.terminate();
        return;
    }

    if (status !== HIGHS_STATUS.optimal) {
        print(`Hinweis: Zeitlimit von ${zeitlimit} s erreicht - Plan zulässig, aber nicht als optimal bewiesen.`);
    }

    print("=== OPTIMALER BELEGUNGSPLAN ===");

    // Letzter Arbeitstag je Fahrzeug -> daraus die Verspaetung
    const fertigstellung = {};

    for (let t = 1; t <= T; t++) {
        print(`\n--- Tag ${t} ---`);
        let arbeitHeute = false;

        for (const i of fahrzeuge) {
            for (const j of abteilungen) {
                const val = arbeitsmenge(sol, i, j, t);

                if (val > 0.01) {
                    const verspaetet = t > deadline[i];
                    const hinweis = verspaetet ? '  << NACH DEADLINE' : '';
                    print(`  Fahrzeug ${bezeichnung(i)}: Abteilung ${j} arbeitet mit ${Math.round(val)} Mitarbeiter(n)${hinweis}`);
                    fertigstellung[i] = t;
                    arbeitHeute = true;
                }
            }
        }

        if (!arbeitHeute) {
            print("  (Keine Arbeiten eingeplant)");
        }
    }

    // Zusammenfassung der Deadline-Verletzungen
    print("\n=== DEADLINES ===");
    let alleImPlan = true;

    for (const i of fahrzeuge) {
        const fertig = fertigstellung[i] ?? 0;
        const verzug = fertig - deadline[i];

        if (verzug > 0) {
            print(`  ${bezeichnung(i)}: fertig an Tag ${fertig}, Deadline Tag ${deadline[i]} -> ${verzug} Tag(e) zu spaet`);
            alleImPlan = false;
        } else {
            print(`  ${bezeichnung(i)}: fertig an Tag ${fertig}, Deadline Tag ${deadline[i]} -> im Plan`);
        }
    }

    if (alleImPlan) {
        print("  Alle Fahrzeuge innerhalb ihrer Deadline.");
    }

    // Gantt-Diagramm zeichnen
    const auslastung = berechneAuslastung(sol, fahrzeuge, abteilungen, T, daten.kapazitaet, startIso);
    renderGantt(sol, fahrzeuge, abteilungen, T, deadline, bezeichnung, startIso, auslastung, i => fahrzeugInfo(daten, i));
    renderAuslastung(auslastung);

    // Worker sauber beenden
    worker.terminate();
}

async function runSolver() {
    const output = document.getElementById("output");
    const gantt = document.getElementById("gantt");
    const legend = document.getElementById("gantt-legend");
    const filter = document.getElementById("gantt-filter");
    const auslastung = document.getElementById("auslastung");
    if (output) output.textContent = "";
    if (gantt) gantt.innerHTML = "";
    if (legend) legend.innerHTML = "";
    if (filter) filter.innerHTML = "";
    if (auslastung) auslastung.innerHTML = "";
    plan = null;
    if (lauf) return; // laeuft schon
    lauf = { abgebrochen: false, controller: new AbortController(), worker: null, beendeSolve: null };
    setzeLaufZustand(true);
    print("Starte Optimierung...\n");
    try {
        await solveOptimization();
    } catch (err) {
        if (err instanceof AbbruchFehler) {
            print("Abgebrochen.");
        } else {
            print("Fehler: " + err.message);
            console.error(err);
        }
    } finally {
        lauf.worker?.terminate(); // idempotent; raeumt den Worker auch nach Fehlern auf
        lauf = null;
        setzeLaufZustand(false);
    }
}

// Als ES-Modul geladen -> Funktionen fuer onclick="runSolver()" im HTML sichtbar machen.
// Guard fuer den Import in highs-worker.js (Web Worker) und test-solver.mjs (Node): dort gibt
// es kein window.
if (typeof window !== 'undefined') {
    window.runSolver = runSolver;
    window.abbrechen = abbrechen;
}