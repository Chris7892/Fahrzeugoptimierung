// @ts-nocheck
import express from 'express';
import dotenv from 'dotenv';
import fahrzeugeRouter from './Fahrzeuge.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// API: db.js wird ausschliesslich hier - serverseitig - verwendet
app.use('/api', fahrzeugeRouter);

// Frontend (index.html, solver.js, highs-worker.js, Favicons) plus node_modules fuer HiGHS (WASM).
// dotfiles: 'deny' verhindert, dass die .env mit den DB-Zugangsdaten
// unter http://localhost:PORT/.env abrufbar ist.
app.use(express.static(import.meta.dirname, { dotfiles: 'deny' }));

app.listen(PORT, () => {
    console.log(`Server laeuft auf http://localhost:${PORT}`);
});
