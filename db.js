// @ts-nocheck
import oracledb from 'oracledb';
import dotenv from 'dotenv';

dotenv.config();

// Zeilen als Objekte liefern ({ FAHRZEUG_ID: 'F1', ... }) statt als Arrays
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

export async function getConnection() {
    const { DB_USER, DB_PASS, DB_CONNECT } = process.env;

    if (!DB_USER || !DB_PASS || !DB_CONNECT) {
        throw new Error(
            'DB-Zugangsdaten fehlen. Bitte .env mit DB_USER, DB_PASS und DB_CONNECT fuellen.'
        );
    }

    const config = {
        user: DB_USER,
        password: DB_PASS,
        connectString: DB_CONNECT
    };

    // Ist DB_CONNECT ein TNS-Alias (statt host:port/service), muss das
    // Verzeichnis mit der tnsnames.ora ueber TNS_ADMIN bekannt sein.
    if (process.env.TNS_ADMIN) {
        config.configDir = process.env.TNS_ADMIN;
    }

    return await oracledb.getConnection(config);
}
