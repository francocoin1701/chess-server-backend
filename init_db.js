const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:gkfdlkfjsdkfjlsdkjfgdfkljgdlkfgsdfglsdkfjgsldkf@db.phrxplbyqqimojrpyqsy.supabase.co:5432/postgres";

const client = new Client({
    host: 'db.phrxplbyqqimojrpyqsy.supabase.co',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: 'gkfdlkfjsdkfjlsdkjfgdfkljgdlkfgsdfglsdkfjgsldkf',
    ssl: { rejectUnauthorized: false },
    family: 4
});

async function crearBaseDeDatos() {
    try {
        await client.connect();
        console.log("✅ Conectado");

        // 1. TABLA USERS
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                wallet TEXT PRIMARY KEY,
                nickname TEXT DEFAULT 'Jugador Nuevo',
                photo_url TEXT,
                elo INTEGER DEFAULT 1200,
                last_color TEXT DEFAULT 'b',
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                balance_earned TEXT DEFAULT '0',
                draws INTEGER DEFAULT 0
            );
        `);
        console.log("✅ users creada");

        // 2. TABLA CHALLENGES
        await client.query(`
            CREATE TABLE IF NOT EXISTS challenges (
                id SERIAL PRIMARY KEY,
                creator_wallet TEXT NOT NULL REFERENCES users(wallet),
                bet_amount TEXT NOT NULL,
                time_limit INTEGER NOT NULL,
                room_id TEXT NOT NULL,
                status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                blockchain_id INTEGER,
                color_creador INTEGER DEFAULT 0,
                CONSTRAINT challenges_room_id_key UNIQUE (room_id),
                CONSTRAINT challenges_blockchain_id_key UNIQUE (blockchain_id),
                CONSTRAINT unique_blockchain_id UNIQUE (blockchain_id)
            );
        `);
        console.log("✅ challenges creada");

        // Índices de challenges
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_challenges_blockchain_id 
            ON challenges(blockchain_id);
        `);
        console.log("✅ índices challenges creados");

        // 3. TABLA GAME_HISTORY
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_history (
                id SERIAL PRIMARY KEY,
                room_id TEXT NOT NULL,
                white_wallet TEXT NOT NULL REFERENCES users(wallet),
                black_wallet TEXT NOT NULL REFERENCES users(wallet),
                winner_wallet TEXT,
                bet_amount TEXT NOT NULL,
                pgn TEXT,
                played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                blockchain_id INTEGER,
                payment_status TEXT DEFAULT 'pending',
                action_type INTEGER DEFAULT 1
            );
        `);
        console.log("✅ game_history creada");

        // Verificar
        const res = await client.query(`
            SELECT table_name, 
                   (SELECT COUNT(*) FROM information_schema.columns 
                    WHERE table_name = t.table_name 
                    AND table_schema = 'public') as columnas
            FROM information_schema.tables t
            WHERE table_schema = 'public'
            AND table_name IN ('users', 'challenges', 'game_history')
            ORDER BY table_name;
        `);

        console.log("\n📋 Resultado:");
        res.rows.forEach(r => console.log(` ✓ ${r.table_name} — ${r.columnas} columnas`));
        console.log("\n🎉 Base de datos lista.");

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await client.end();
        console.log("🏁 Terminado.");
    }
}

crearBaseDeDatos();