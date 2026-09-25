// @ts-nocheck
import express from 'express';
import { getConnection } from './db.js';
import { ladeAuftraege, ABTEILUNGEN } from './excel.js';

const router = express.Router();

// Excel-Fallback: Mitarbeiter-Tage = Reststunden / STUNDEN_PRO_TAG, Auswahl = alle Wittlich-Auftraege,
// die nicht storniert oder ausgeliefert sind (siehe excel.js), nach Werkslieferung sortiert
const STUNDEN_PRO_TAG = 7;
const STANDARD_KAPAZITAET = 3;
const STANDARD_MAX_PRO_FAHRZEUG = 2;
// Zeithorizont fuer Fahrzeuge (Kalendertage ab Berechnungsdatum): bereits angelieferte Fahrzeuge
// und solche, die in dieser Zeit angeliefert werden, kommen in die Planung
const STANDARD_HORIZONT_TAGE = 180;

router.get('/planung', async (req, res) => {
    let conn;
    try {
        conn = await getConnection();

        const result = await conn.execute(`
            SELECT
                fahrzeug_id,
                abteilung,
                aufwand,
                deadline,
                kapazitaet
            FROM fahrzeugplanung
        `);

        res.json(toModel(result.rows));
    } catch (dbErr) {
        console.error(`DB nicht verfuegbar (${dbErr.message}) - nutze Excel-Daten.`);

        try {
            // Mitarbeiter pro Tag je Abteilung: ?kap_Lack=4&kap_FHS=2 ...
            const kapazitaet = {};
            for (const j of Object.keys(ABTEILUNGEN)) {
                const n = Number.parseInt(req.query[`kap_${j}`] ?? STANDARD_KAPAZITAET, 10);
                if (!(n >= 1)) {
                    return res.status(400).json({ error: `kap_${j} muss eine ganze Zahl >= 1 sein` });
                }
                kapazitaet[j] = n;
            }

            // Max. Mitarbeiter je Fahrzeug und Abteilung pro Tag: ?max_fzg=2
            const maxProFahrzeug = Number.parseInt(req.query.max_fzg ?? STANDARD_MAX_PRO_FAHRZEUG, 10);
            if (!(maxProFahrzeug >= 1)) {
                return res.status(400).json({ error: 'max_fzg muss eine ganze Zahl >= 1 sein' });
            }

            // Berechnungsdatum (Tag 1 des Plans): ?start=2026-09-21, Standard heute
            const start = req.query.start;
            if (start !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(start) && !Number.isNaN(new Date(start).getTime()))) {
                return res.status(400).json({ error: 'start muss ein Datum im Format JJJJ-MM-TT sein' });
            }

            // Zeithorizont fuer Fahrzeuge: ?horizont=180
            const horizontTage = Number.parseInt(req.query.horizont ?? STANDARD_HORIZONT_TAGE, 10);
            if (!(horizontTage >= 1)) {
                return res.status(400).json({ error: 'horizont muss eine ganze Zahl >= 1 sein' });
            }

            // Lieferprio beruecksichtigen (Lieferprio, 1 = Termin muss unbedingt gehalten werden):
            // ?liefprio=1
            const liefprioAktiv = req.query.liefprio === '1';

            const auftraege = await ladeAuftraege();
            res.json({
                ...excelToModel(auftraege, { kapazitaet, maxProFahrzeug, start, horizontTage, liefprioAktiv }),
                quelle: 'Excel'
            });
        } catch (xlsErr) {
            console.error(xlsErr);
            res.status(500).json({ error: `DB: ${dbErr.message}; Excel: ${xlsErr.message}` });
        }
    } finally {
        // immer schliessen - auch wenn das SELECT geworfen hat
        if (conn) {
            try {
                await conn.close();
            } catch (closeErr) {
                console.error(closeErr);
            }
        }
    }
});

// Flache DB-Zeilen -> Datenstruktur, die solver.js direkt verwenden kann
function toModel(rows) {
    const fahrzeuge = [];
    const abteilungen = [];
    const aufwand = {};
    const deadline = {};
    const kapazitaet = {};

    for (const r of rows) {
        const i = r.FAHRZEUG_ID;
        const j = r.ABTEILUNG;

        if (!fahrzeuge.includes(i)) fahrzeuge.push(i);
        if (!abteilungen.includes(j)) abteilungen.push(j);

        aufwand[`${i}_${j}`] = r.AUFWAND;
        deadline[i] = r.DEADLINE;
        kapazitaet[j] = r.KAPAZITAET;
    }

    // Planungshorizont = spaeteste Deadline
    const T = Math.max(...Object.values(deadline), 0);

    return { fahrzeuge, abteilungen, aufwand, deadline, kapazitaet, T };
}

// Werktage (Mo-Fr) von start bis einschliesslich ende; start ist Tag 1.
// Liegt ende vor start (ueberfaellig), ergibt das 0.
function werktageBis(start, ende) {
    let n = 0;
    for (const d = new Date(start); d <= ende; d.setUTCDate(d.getUTCDate() + 1)) {
        const wt = d.getUTCDay();
        if (wt !== 0 && wt !== 6) n++;
    }
    return n;
}

// Erster Werktag (Tag 1 = erster Werktag ab start), an dem ein Fahrzeug bearbeitet werden kann:
// der Tag der Anlieferung, faellt er auf ein Wochenende der naechste Werktag,
// liegt er vor dem Start Tag 1.
function erstesBearbeitungsTag(start, anlieferungIso) {
    const vortag = new Date(anlieferungIso);
    vortag.setUTCDate(vortag.getUTCDate() - 1);
    return werktageBis(start, vortag) + 1;
}

// Auftraege aus der Excel-Datei -> Datenstruktur fuer solver.js
export function excelToModel(auftraege, { kapazitaet, maxProFahrzeug = Infinity, start, horizontTage = STANDARD_HORIZONT_TAGE, liefprioAktiv = false } = {}) {
    // Ohne Angabe: heutiges Datum (lokal) als UTC-Mitternacht
    const jetzt = new Date();
    const startDatum = start
        ? new Date(start)
        : new Date(Date.UTC(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()));
    startDatum.setUTCHours(0, 0, 0, 0);
    if (Number.isNaN(startDatum.getTime())) throw new Error(`Ungueltiges Startdatum: ${start}`);

    // Deadline und erster Bearbeitungstag (Werktage ab Start, 1-basiert)
    // Ohne Werkslieferung gibt es keine Deadline (null): Ende des Planungshorizonts T (s. u.)
    const deadlineTag = a => a.werklief ? werktageBis(startDatum, new Date(a.werklief)) : null;
    const ersterTag = a => a.angeliefert ? 1 : erstesBearbeitungsTag(startDatum, a.anlieferung);

    // Auswahl: Fahrzeuge, die bereits auf dem Hof sind, oder deren Anlieferung (AUF_DAT_ANLIEF_AKT)
    // zwischen Berechnungsdatum und Ende des Zeithorizonts liegt. Ueberfaellige (Datum vor dem
    // Berechnungsdatum) oder fehlende Anlieferung zaehlt nicht.
    const startIso = startDatum.toISOString().slice(0, 10);
    const horizontEnde = new Date(startDatum);
    horizontEnde.setUTCDate(horizontEnde.getUTCDate() + horizontTage);
    const endeIso = horizontEnde.toISOString().slice(0, 10);
    const imZeithorizont = a => a.angeliefert
        || (a.anlieferung && a.anlieferung >= startIso && a.anlieferung <= endeIso);

    // Fahrzeuge ohne Aufwand in allen Abteilungen gibt es nichts zu planen: sie bleiben aussen vor
    const gewaehlt = auftraege
        .filter(a => Object.keys(a.stunden).length > 0)
        .filter(imZeithorizont)
        .sort((a, b) => (a.werklief ?? '9999').localeCompare(b.werklief ?? '9999')); // ohne Deadline zuletzt

    const fahrzeuge = gewaehlt.map(a => a.id);
    const abteilungen = [...new Set(gewaehlt.flatMap(a => Object.keys(a.stunden)))];

    const aufwand = {};
    const deadline = {};
    // Erster Werktag (1-basiert), an dem am Fahrzeug gearbeitet werden darf
    const verfuegbarAb = {};
    // Lieferprio (Spalte "Lieferprio"), nur gesetzt, wenn vorhanden und liefprioAktiv; siehe solver.js
    const prio = {};
    const kap = {};
    // Anzeigename: Fahrzeugnummer (AUF_FZGNR), ersatzweise die Auftrags-ID
    const bezeichnung = {};
    // Leistungsumfang und Stunden je Fahrzeug (nur zur Anzeige)
    const info = {};

    for (const j of abteilungen) kap[j] = kapazitaet[j];

    for (const a of gewaehlt) {
        // Ueberfaellige Deadlines (vor dem Start) werden auf 0 gesetzt: die gesamte
        // Arbeit gilt dann als verspaetet
        bezeichnung[a.id] = a.fzgnr || a.id;
        info[a.id] = {
            status: a.status,
            zap: a.auftragsart.toUpperCase() === 'ZAP',
            leistungsumfang: a.leistung,
            // Gesamtstunden = Summe der Reststunden aller Abteilungen (= AUF_STD_REST_GES)
            stunden: Object.values(a.stunden).reduce((sum, h) => sum + h, 0),
            geplant: a.geplant,
            anlieferung: a.angeliefert ? 'bereits angeliefert' : a.anlieferung,
            prio: a.prio
        };
        if (deadlineTag(a) !== null) deadline[a.id] = deadlineTag(a);
        verfuegbarAb[a.id] = ersterTag(a);
        if (liefprioAktiv && a.prio != null) prio[a.id] = a.prio;

        for (const j of abteilungen) {
            // Solver rechnet in ganzen Mitarbeiter-Tagen -> aufrunden
            aufwand[`${a.id}_${j}`] = Math.ceil((a.stunden[j] ?? 0) / STUNDEN_PRO_TAG);
        }
    }

    // Planungshorizont T: spaeteste Deadline, mindestens aber so lang, dass Arbeit
    // moeglich ist (Abteilungsauslastung und pro Fahrzeug nacheinander) - sonst ist
    // das Modell bei ueberfaelligen Auftraegen unloesbar.
    // Vor der Anlieferung darf nicht gearbeitet werden -> Arbeit beginnt fruehestens am jeweiligen Tag.
    const tageAbteilung = abteilungen.map(j => {
        const mitAufwand = fahrzeuge.filter(i => aufwand[`${i}_${j}`] > 0);
        const fruehester = Math.min(...mitAufwand.map(i => verfuegbarAb[i]));
        return (Number.isFinite(fruehester) ? fruehester - 1 : 0)
            + Math.ceil(mitAufwand.reduce((sum, i) => sum + aufwand[`${i}_${j}`], 0) / kap[j]);
    });
    const tageFahrzeug = fahrzeuge.map(i => verfuegbarAb[i] - 1 +
        abteilungen.reduce((sum, j) =>
            sum + Math.ceil(aufwand[`${i}_${j}`] / Math.min(kap[j], maxProFahrzeug)), 0));

    // T = spaeteste Deadline bzw. Kapazitaetsgrenze / noetige Arbeitstage der gewaehlten Fahrzeuge
    const T = Math.max(...Object.values(deadline), ...tageAbteilung, ...tageFahrzeug, 1);

    for (const a of gewaehlt) deadline[a.id] ??= T;

    return { fahrzeuge, abteilungen, aufwand, deadline, verfuegbarAb, kapazitaet: kap, T, bezeichnung, info, maxProFahrzeug,
        prio, liefprioAktiv,
        anzahlAuftraege: auftraege.length,
        startDatum: startDatum.toISOString().slice(0, 10) };
}

export default router;
