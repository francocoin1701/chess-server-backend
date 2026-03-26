const { Client } = require('pg');

// ⚠️ Mejor usar variable de entorno (seguridad)
const connectionString = process.env.DATABASE_URL || "postgresql://chess_db_sftz_user:lPvCajK6CDsusmqTxcEhXbjNOCzAfBMx@dpg-d70rmd3uibrs738u21s0-a.oregon-postgres.render.com/chess_db_sftz";

const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

async function actualizarTerreno() {
    try {
        await client.connect();
        console.log("✅ Conexión establecida. Optimizando base de datos...");

        // 🔥 TRANSACTION (MUY IMPORTANTE)
        await client.query('BEGIN');

        // 1. USERS
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS losses INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS balance_earned TEXT DEFAULT '0';
        `);
        console.log("1. ✅ Estadísticas añadidas a 'users'.");

        // 2. CHALLENGES
        await client.query(`
            CREATE TABLE IF NOT EXISTS challenges (
                id SERIAL PRIMARY KEY,
                creator_wallet TEXT NOT NULL REFERENCES users(wallet),
                bet_amount TEXT NOT NULL,
                time_limit INT NOT NULL,
                room_id TEXT UNIQUE NOT NULL,
                status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("2. ✅ Tabla 'challenges' lista.");

        // 🔥 blockchain_id (tu cambio clave)
        await client.query(`
            ALTER TABLE challenges
            ADD COLUMN IF NOT EXISTS blockchain_id INTEGER UNIQUE;
        `);
        console.log("2.1. ✅ blockchain_id añadido.");

        // 🔥 índice extra (PRO rendimiento)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_challenges_blockchain_id 
            ON challenges(blockchain_id);
        `);

        // 3. GAME HISTORY
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_history (
                id SERIAL PRIMARY KEY,
                room_id TEXT NOT NULL,
                white_wallet TEXT NOT NULL REFERENCES users(wallet),
                black_wallet TEXT NOT NULL REFERENCES users(wallet),
                winner_wallet TEXT,
                bet_amount TEXT NOT NULL,
                pgn TEXT,
                played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("3. ✅ Tabla 'game_history' lista.");

        // ✅ TODO OK
        await client.query('COMMIT');
        console.log("🎉 Migración completada correctamente.");

    } catch (err) {
        await client.query('ROLLBACK'); // 🔥 importante
        console.error("❌ Error en la DB:", err);
    } finally {
        await client.end();
        console.log("🏁 Proceso terminado.");
    }
}

actualizarTerreno();