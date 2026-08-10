import GLPK from './node_modules/glpk.js/dist/index.js';

function print(text) {
    document.getElementById("output").textContent += text + "\n";
}

async function solveOptimization() {
    const glpk = await GLPK();

    const fahrzeuge = ['F1', 'F2', 'F3'];
    const abteilungen = ['Karosserie', 'Lack', 'Elektrik'];
    const T = 10;

    const deadline = { F1: 5, F2: 8, F3: 10 };
    const kapazitaet = { Karosserie: 4, Lack: 2, Elektrik: 3 };

    const aufwand = {
        'F1_Karosserie': 4, 'F1_Lack': 2, 'F1_Elektrik': 3,
        'F2_Karosserie': 6, 'F2_Lack': 4, 'F2_Elektrik': 2,
        'F3_Karosserie': 5, 'F3_Lack': 3, 'F3_Elektrik': 6,
    };

    // ============================
    // Variablen definieren
    // ============================
    const vars = [];

    for (const i of fahrzeuge) {
        for (const j of abteilungen) {
            for (let t = 1; t <= T; t++) {
                vars.push({ name: `x_${i}_${j}_t${t}`, coef: t }); // Zielfunktion
                vars.push({ name: `y_${i}_${j}_t${t}`, coef: 0 }); // keine Kosten
            }
        }
    }

    // ============================
    // Constraints definieren
    // ============================
    const constraints = [];

    // Aufwand + Deadlines
    for (const i of fahrzeuge) {
        for (const j of abteilungen) {

            // Aufwand-Summe bis Deadline
            const validVars = [];
            for (let t = 1; t <= deadline[i]; t++) {
                validVars.push({ name: `x_${i}_${j}_t${t}`, coef: 1 });
            }

            constraints.push({
                name: `Aufwand_${i}_${j}`,
                vars: validVars,
                bnds: { type: glpk.GLP_FX, lb: aufwand[`${i}_${j}`], ub: aufwand[`${i}_${j}`] }
            });

            // Nach Deadline = 0
            for (let t = deadline[i] + 1; t <= T; t++) {
                constraints.push({
                    name: `Deadline_${i}_${j}_t${t}`,
                    vars: [{ name: `x_${i}_${j}_t${t}`, coef: 1 }],
                    bnds: { type: glpk.GLP_FX, lb: 0, ub: 0 }
                });
            }
        }
    }

    // Kapazität
    for (const j of abteilungen) {
        for (let t = 1; t <= T; t++) {
            const deptVars = fahrzeuge.map(i => ({
                name: `x_${i}_${j}_t${t}`,
                coef: 1
            }));

            constraints.push({
                name: `Kapazitaet_${j}_t${t}`,
                vars: deptVars,
                bnds: { type: glpk.GLP_UP, ub: kapazitaet[j] }
            });
        }
    }

    // Kopplung x <= M * y
    for (const i of fahrzeuge) {
        for (const j of abteilungen) {
            for (let t = 1; t <= T; t++) {
                constraints.push({
                    name: `Kopplung_${i}_${j}_t${t}`,
                    vars: [
                        { name: `x_${i}_${j}_t${t}`, coef: 1 },
                        { name: `y_${i}_${j}_t${t}`, coef: -kapazitaet[j] }
                    ],
                    bnds: { type: glpk.GLP_UP, ub: 0 }
                });
            }
        }
    }

    // Exklusivität: Summe y <= 1
    for (const i of fahrzeuge) {
        for (let t = 1; t <= T; t++) {
            const yVars = abteilungen.map(j => ({
                name: `y_${i}_${j}_t${t}`,
                coef: 1
            }));

            constraints.push({
                name: `Exklusivitaet_${i}_t${t}`,
                vars: yVars,
                bnds: { type: glpk.GLP_UP, ub: 1 }
            });
        }
    }

    // ============================
    // Bounds (nur für x nötig - y wird über "binaries" gesteuert)
    // ============================
    const bounds = [];

    for (const i of fahrzeuge) {
        for (const j of abteilungen) {
            for (let t = 1; t <= T; t++) {
                bounds.push({ name: `x_${i}_${j}_t${t}`, type: glpk.GLP_LO, lb: 0 });
            }
        }
    }

    // ============================
    // Modell zusammenbauen
    // ============================
    const model = {
        name: "Fahrzeugplanung",
        objective: {
            direction: glpk.GLP_MIN,
            name: "obj",
            vars: vars
        },
        subjectTo: constraints,
        bounds: bounds,
        // x-Variablen sind Mitarbeiterzahlen -> müssen ganzzahlig sein
        generals: vars.filter(v => v.name.startsWith("x_")).map(v => v.name),
        binaries: vars.filter(v => v.name.startsWith("y_")).map(v => v.name)
    };

    // ============================
    // Solve (WICHTIG: await, da glpk.solve() ein Promise zurückgibt!)
    // ============================
    const result = await glpk.solve(model, { msglev: glpk.GLP_MSG_ERR });

    print(`Status: ${result.result.status}`);

    // GLP_OPT ist der numerische Status-Code für "optimal gelöst"
    if (result.result.status !== glpk.GLP_OPT) {
        print("Keine zulässige Lösung gefunden.");
        glpk.terminate();
        return;
    }

    print("=== OPTIMALER BELEGUNGSPLAN ===");

    const sol = result.result.vars;

    for (let t = 1; t <= T; t++) {
        print(`\n--- Tag ${t} ---`);
        let arbeitHeute = false;

        for (const i of fahrzeuge) {
            for (const j of abteilungen) {
                const name = `x_${i}_${j}_t${t}`;
                const val = sol[name] || 0;

                if (val > 0.01) {
                    print(`  Fahrzeug ${i}: Abteilung ${j} arbeitet mit ${Math.round(val)} Mitarbeiter(n)`);
                    arbeitHeute = true;
                }
            }
        }

        if (!arbeitHeute) {
            print("  (Keine Arbeiten eingeplant)");
        }
    }

    // Worker sauber beenden
    glpk.terminate();
}

async function runSolver() {
    document.getElementById("output").textContent = "";
    print("Starte Optimierung...\n");
    try {
        await solveOptimization();
    } catch (err) {
        print("Fehler: " + err.message);
        console.error(err);
    }
}

// Als ES-Modul geladen -> Funktion für onclick="runSolver()" im HTML sichtbar machen
window.runSolver = runSolver;