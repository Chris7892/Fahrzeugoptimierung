// @ts-nocheck
// Testskript fuer solver.js. Nutzt den Node-Build von HiGHS und die exportierten
// loeseMitHighs()/HIGHS_STATUS aus solver.js, damit exakt das Produktionsmodell
// geprueft wird - ohne Browser, ohne DOM und ohne Web Worker.

const highsLoader = (await import('highs')).default;
const { loeseMitHighs, HIGHS_STATUS } = await import('./solver.js');

const highs = await highsLoader();

const BASIS = {
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

async function pruefe(titel, daten, erwarteVerspaetung) {
    console.log(`\n${'='.repeat(64)}\n${titel}\n${'='.repeat(64)}`);

    const { status, sol } = loeseMitHighs(highs, daten);

    const geloest = status === HIGHS_STATUS.optimal;
    console.log(`Status: ${status} (optimal=${HIGHS_STATUS.optimal}) -> ${geloest ? 'geloest' : 'KEINE LOESUNG'}`);

    if (!geloest) {
        console.log(`ERGEBNIS: FEHLGESCHLAGEN - Modell unloesbar`);
        return false;
    }

    // Pruefung 1: Aufwand vollstaendig verplant (x + z == aufwand)?
    let aufwandOk = true;
    for (const i of daten.fahrzeuge) {
        for (const j of daten.abteilungen) {
            let summe = 0;
            for (let t = 1; t <= daten.T; t++) {
                summe += (sol[`x_${i}_${j}_t${t}`] || 0) + (sol[`z_${i}_${j}_t${t}`] || 0);
            }
            const soll = daten.aufwand[`${i}_${j}`];
            if (Math.abs(summe - soll) > 0.01) {
                console.log(`  FEHLER Aufwand ${i}/${j}: ${summe} statt ${soll}`);
                aufwandOk = false;
            }
        }
    }

    // Pruefung 2: Kapazitaet je Abteilung und Tag eingehalten?
    let kapaOk = true;
    for (const j of daten.abteilungen) {
        for (let t = 1; t <= daten.T; t++) {
            let summe = 0;
            for (const i of daten.fahrzeuge) {
                summe += (sol[`x_${i}_${j}_t${t}`] || 0) + (sol[`z_${i}_${j}_t${t}`] || 0);
            }
            if (summe > daten.kapazitaet[j] + 0.01) {
                console.log(`  FEHLER Kapazitaet ${j} an Tag ${t}: ${summe} > ${daten.kapazitaet[j]}`);
                kapaOk = false;
            }
        }
    }

    // Pruefung 3: Exklusivitaet - hoechstens eine Abteilung je Fahrzeug und Tag?
    let exklusivOk = true;
    for (const i of daten.fahrzeuge) {
        for (let t = 1; t <= daten.T; t++) {
            const aktive = daten.abteilungen.filter(
                j => (sol[`x_${i}_${j}_t${t}`] || 0) + (sol[`z_${i}_${j}_t${t}`] || 0) > 0.01
            );
            if (aktive.length > 1) {
                console.log(`  FEHLER Exklusivitaet ${i} an Tag ${t}: ${aktive.join(', ')}`);
                exklusivOk = false;
            }
        }
    }

    // Verspaetung ermitteln
    const verzug = {};
    for (const i of daten.fahrzeuge) {
        let letzterTag = 0;
        for (let t = 1; t <= daten.T; t++) {
            for (const j of daten.abteilungen) {
                if ((sol[`x_${i}_${j}_t${t}`] || 0) + (sol[`z_${i}_${j}_t${t}`] || 0) > 0.01) {
                    letzterTag = t;
                }
            }
        }
        verzug[i] = letzterTag - daten.deadline[i];
        const status = verzug[i] > 0 ? `${verzug[i]} Tag(e) ZU SPAET` : 'im Plan';
        console.log(`  ${i}: fertig Tag ${letzterTag}, Deadline ${daten.deadline[i]} -> ${status}`);
    }

    // Pruefung 4: x darf nach der Deadline nicht auftreten, z nicht davor
    let trennungOk = true;
    for (const i of daten.fahrzeuge) {
        for (const j of daten.abteilungen) {
            for (let t = 1; t <= daten.T; t++) {
                if (t > daten.deadline[i] && (sol[`x_${i}_${j}_t${t}`] || 0) > 0.01) {
                    console.log(`  FEHLER x nach Deadline: ${i}/${j} Tag ${t}`);
                    trennungOk = false;
                }
                if (t <= daten.deadline[i] && (sol[`z_${i}_${j}_t${t}`] || 0) > 0.01) {
                    console.log(`  FEHLER z vor Deadline: ${i}/${j} Tag ${t}`);
                    trennungOk = false;
                }
            }
        }
    }

    const gabVerspaetung = Object.values(verzug).some(v => v > 0);
    const erwartungOk = gabVerspaetung === erwarteVerspaetung;

    if (!erwartungOk) {
        console.log(`  FEHLER: Verspaetung=${gabVerspaetung}, erwartet=${erwarteVerspaetung}`);
    }

    const ok = aufwandOk && kapaOk && exklusivOk && trennungOk && erwartungOk;
    console.log(`ERGEBNIS: ${ok ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}`);
    return ok;
}

const ergebnisse = [];

ergebnisse.push(await pruefe(
    'SZENARIO 1: normale Deadlines -> Loesung ohne Verspaetung',
    BASIS,
    false
));

ergebnisse.push(await pruefe(
    'SZENARIO 2: F1 Deadline Tag 1 -> vorher UNLOESBAR, jetzt verspaetet loesbar',
    { ...BASIS, deadline: { F1: 1, F2: 8, F3: 10 } },
    true
));

ergebnisse.push(await pruefe(
    'SZENARIO 3: alle Deadlines Tag 2 -> massive Verspaetung, trotzdem loesbar',
    { ...BASIS, deadline: { F1: 2, F2: 2, F3: 2 } },
    true
));

// Gegenprobe: Horizont endet AN der Deadline -> es gibt keine z-Variablen,
// also keinen Ausweichweg. Das Modell MUSS unloesbar sein. Belegt, dass die
// Loesbarkeit in Szenario 2/3 tatsaechlich von z kommt.
console.log(`\n${'='.repeat(64)}\nGEGENPROBE: T=1, alle Deadlines Tag 1 -> muss UNLOESBAR sein\n${'='.repeat(64)}`);
{
    const eng = { ...BASIS, T: 1, deadline: { F1: 1, F2: 1, F3: 1 } };
    const { status } = loeseMitHighs(highs, eng);
    const unloesbar = status !== HIGHS_STATUS.optimal;
    console.log(`Status: ${status} -> ${unloesbar ? 'unloesbar (wie erwartet)' : 'GELOEST - unerwartet!'}`);
    console.log(`ERGEBNIS: ${unloesbar ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}`);
    ergebnisse.push(unloesbar);
}

console.log(`\n${'='.repeat(64)}`);
console.log(ergebnisse.every(Boolean)
    ? `ALLE ${ergebnisse.length} SZENARIEN BESTANDEN`
    : `FEHLGESCHLAGEN: ${ergebnisse.filter(r => !r).length} von ${ergebnisse.length}`);

process.exit(ergebnisse.every(Boolean) ? 0 : 1);
