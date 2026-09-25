// @ts-nocheck
// Web Worker: laedt HiGHS (WebAssembly) und loest das MILP, ohne den Haupt-Thread zu blockieren.
// model.run() (in loeseMitHighs, solver.js) ist synchron/blockierend - deshalb laeuft der Solve
// hier und nicht direkt in solver.js. worker.terminate() (Abbrechen-Button in solver.js) killt
// diesen Worker mitsamt einem laufenden run().
//
// Kein window in diesem Scope (Web Worker) - solver.js prueft das selbst, bevor es
// window.runSolver/abbrechen setzt.

import highsLoader from './node_modules/highs/build/highs.mjs';
import { loeseMitHighs } from './solver.js';

self.onmessage = async ({ data: { daten, zeitlimit } }) => {
    try {
        const highs = await highsLoader();
        const ergebnis = loeseMitHighs(highs, daten, zeitlimit);
        self.postMessage({ ok: true, ...ergebnis });
    } catch (err) {
        self.postMessage({ ok: false, error: err.message });
    }
};
