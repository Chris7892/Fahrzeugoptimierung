// @ts-nocheck
// Liest die Auftragsuebersicht aus A_Auftragsuebersicht_Lokal.xlsx.
// Die Datei hat ~120 MB XML und wird deshalb nur einmal gestreamt; das
// gefilterte Ergebnis (Werk Wittlich, nicht storniert und nicht ausgeliefert) landet
// als kleine JSON-Datei in daten/ und wird danach von dort gelesen.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const XLSX_PFAD = path.join(import.meta.dirname, 'A_Auftragsübersicht_Lokal.xlsx');
const CACHE_PFAD = path.join(import.meta.dirname, 'daten', 'auftraege.json');

// Bei geaendertem Aufbau der JSON-Datei hochzaehlen, damit der Cache neu erzeugt wird
const CACHE_VERSION = 11;

const WERK = 'Wittlich';
const GESCHLOSSEN = ['ausgeliefert', 'storniert'];

// Abteilung -> Spalte mit den Reststunden
export const ABTEILUNGEN = {
    Aufbau: 'AUF_STD_AUFBAU_REST',
    Fgest: 'AUF_STD_FGEST_REST',
    FHS: 'AUF_STD_FHS_REST',
    Lack: 'AUF_STD_LACK_REST',
    Elektrik: 'AUF_STD_ELEKTRIK_REST'
};

const SPALTEN = ['AUF_ID', 'AUF_FZGNR', 'AUF_STATUS', 'AUF_AUFTRAGSART', 'AUF_TMC_WERK', 'AUF_LEIST_UMF', 'AUF_STD_PLAN_GES', 'AUF_DAT_ANLIEF_IST', 'AUF_DAT_ANLIEF_AKT', 'WERKLIEF', 'Lieferprio', ...Object.values(ABTEILUNGEN)];

// exceljs liefert je nach Zellformat Date oder die rohe Excel-Seriennummer
function alsDatum(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return null;
}

function alsZahl(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

async function leseXlsx() {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(XLSX_PFAD, {
        sharedStrings: 'cache',
        styles: 'cache',
        worksheets: 'emit'
    });

    const auftraege = [];

    for await (const sheet of reader) {
        let idx = null; // Spaltenname -> Position

        for await (const row of sheet) {
            if (!idx) {
                idx = {};
                row.values.forEach((name, pos) => { idx[name] = pos; });

                const fehlt = SPALTEN.filter(s => !(s in idx));
                if (fehlt.length) throw new Error(`Spalten fehlen in der Excel-Datei: ${fehlt.join(', ')}`);
                continue;
            }

            const wert = name => row.values[idx[name]];

            // Grundgesamtheit: Werk Wittlich, nicht storniert und nicht ausgeliefert - sonst kein Filter
            if (String(wert('AUF_TMC_WERK') ?? '').trim() !== WERK) continue;
            if (GESCHLOSSEN.includes(String(wert('AUF_STATUS') ?? '').trim())) continue;

            // AUF_DAT_ANLIEF_IST gefuellt -> bereits angeliefert und sofort bearbeitbar;
            // sonst gilt die geplante Anlieferung (AUF_DAT_ANLIEF_AKT). Fehlt Datum -> null.
            const angeliefert = !!alsDatum(wert('AUF_DAT_ANLIEF_IST'));
            const anliefAkt = alsDatum(wert('AUF_DAT_ANLIEF_AKT'));
            const werklief = alsDatum(wert('WERKLIEF')); // Deadline, kann fehlen

            // Lieferprio: 1 = Liefertermin muss unter allen Umstaenden erreicht werden, je
            // groesser die Zahl, desto niedriger die Prioritaet. Fehlt der Wert -> null, das
            // Fahrzeug wird dann wie bisher ohne besondere Prioritaet behandelt. Stand heute
            // (25.09.2026) hat die Spalte bei allen Auftraegen denselben Wert (4) - technisch
            // gelesen, aber noch keine echte Differenzierung zwischen Fahrzeugen.
            const prioRoh = wert('Lieferprio');
            const prio = Number.isFinite(Number(prioRoh)) && String(prioRoh ?? '').trim() !== ''
                ? Number(prioRoh) : null;

            const stunden = {};
            for (const [abt, spalte] of Object.entries(ABTEILUNGEN)) {
                const h = alsZahl(wert(spalte));
                if (h > 0) stunden[abt] = h;
            }

            auftraege.push({
                id: String(wert('AUF_ID')),
                fzgnr: String(wert('AUF_FZGNR') ?? '').trim(),
                status: String(wert('AUF_STATUS')).trim(),
                auftragsart: String(wert('AUF_AUFTRAGSART') ?? '').trim(),
                leistung: String(wert('AUF_LEIST_UMF') ?? '').trim(),
                geplant: alsZahl(wert('AUF_STD_PLAN_GES')),
                werklief: werklief ? werklief.toISOString().slice(0, 10) : null,
                angeliefert,
                anlieferung: anliefAkt ? anliefAkt.toISOString().slice(0, 10) : null,
                prio,
                stunden
            });
        }

        break; // nur das erste Blatt
    }

    return auftraege;
}

// Alle nicht stornierten und nicht ausgelieferten Wittlich-Auftraege. Die JSON-Datei wird neu erzeugt,
// sobald sie fehlt oder aelter als die xlsx ist.
export async function ladeAuftraege() {
    if (!fs.existsSync(XLSX_PFAD)) {
        throw new Error(`Excel-Datei nicht gefunden: ${XLSX_PFAD}`);
    }

    const cacheAktuell = fs.existsSync(CACHE_PFAD)
        && fs.statSync(CACHE_PFAD).mtimeMs >= fs.statSync(XLSX_PFAD).mtimeMs;

    if (cacheAktuell) {
        const cache = JSON.parse(fs.readFileSync(CACHE_PFAD, 'utf8'));
        if (cache.version === CACHE_VERSION) return cache.auftraege;
    }

    console.log('Lese Excel-Datei (einmalig, dauert etwas) ...');
    const auftraege = await leseXlsx();

    fs.mkdirSync(path.dirname(CACHE_PFAD), { recursive: true });
    fs.writeFileSync(CACHE_PFAD, JSON.stringify({ version: CACHE_VERSION, auftraege }));
    console.log(`${auftraege.length} Wittlich-Auftraege nach ${CACHE_PFAD} geschrieben.`);

    return auftraege;
}
