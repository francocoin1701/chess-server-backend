const { Client } = require('pg');

// Tu URL externa de Render
const connectionString = "postgresql://chess_db_sftz_user:lPvCajK6CDsusmqTxcEhXbjNOCzAfBMx@dpg-d70rmd3uibrs738u21s0-a.oregon-postgres.render.com/chess_db_sftz";

const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

async function actualizarTerreno() {
    try {
        await client.connect();
        console.log("✅ Conexión establecida. Optimizando base de datos...");

        // 1. AMPLIAR TABLA DE USUARIOS (Solo lo que no tenemos)
        // No tocamos wallet, nickname, elo ni last_color porque YA ESTÁN AHÍ.
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS losses INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS balance_earned TEXT DEFAULT '0';
        `);
        console.log("1. ✅ Estadísticas añadidas a la tabla 'users'.");

        // 2. TABLA DE DESAFÍOS (Lobby)
        // Solo guardamos la wallet. El nickname lo traeremos con un "JOIN" en el código.
        await client.query(`
            CREATE TABLE IF NOT EXISTS challenges (
                id SERIAL PRIMARY KEY,
                creator_wallet TEXT NOT NULL REFERENCES users(wallet),
                bet_amount TEXT NOT NULL,
                time_limit INT NOT NULL,
                room_id TEXT UNIQUE NOT NULL,
                status TEXT DEFAULT 'open', -- 'open', 'playing', 'cancelled'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("2. ✅ Tabla de Desafíos (Lobby) vinculada.");

        // 3. TABLA DE HISTORIAL (Recibos)
        // Guardamos el resultado final para que sea permanente.
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_history (
                id SERIAL PRIMARY KEY,
                room_id TEXT NOT NULL,
                white_wallet TEXT NOT NULL REFERENCES users(wallet),
                black_wallet TEXT NOT NULL REFERENCES users(wallet),
                winner_wallet TEXT, -- wallet o NULL si es tablas
                bet_amount TEXT NOT NULL,
                pgn TEXT,
                played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("3. ✅ Tabla de Historial vinculada.");

    } catch (err) {
        console.error("❌ Error de lógica en la DB:", err);
    } finally {
        await client.end();
        console.log("🏁 Base de Datos optimizada. Cimientos listos.");
    }
}

actualizarTerreno();