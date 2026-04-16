const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL || "postgresql://chess_db_sftz_user:lPvCajK6CDsusmqTxcEhXbjNOCzAfBMx@dpg-d70rmd3uibrs738u21s0-a.oregon-postgres.render.com/chess_db_sftz";

const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

async function verEstructura() {
    try {
        await client.connect();
        console.log("Conexion establecida\n");

        // todas las tablas
        const tablas = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

        console.log("==============================");
        console.log("TABLAS EN LA BASE DE DATOS");
        console.log("==============================");
        tablas.rows.forEach(t => console.log(" -", t.table_name));
        console.log("");

        // columnas de cada tabla
        for (const tabla of tablas.rows) {
            const nombre = tabla.table_name;

            const columnas = await client.query(`
                SELECT 
                    column_name,
                    data_type,
                    character_maximum_length,
                    is_nullable,
                    column_default
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
            `, [nombre]);

            console.log("==============================");
            console.log(`TABLA: ${nombre}`);
            console.log("==============================");
            columnas.rows.forEach(c => {
                const tipo = c.character_maximum_length
                    ? `${c.data_type}(${c.character_maximum_length})`
                    : c.data_type;
                const nullable = c.is_nullable === 'YES' ? 'nullable' : 'not null';
                const def = c.column_default ? `default: ${c.column_default}` : '';
                console.log(`  ${c.column_name.padEnd(25)} ${tipo.padEnd(20)} ${nullable.padEnd(12)} ${def}`);
            });

            // indices de la tabla
            const indices = await client.query(`
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE tablename = $1
            `, [nombre]);

            if (indices.rows.length > 0) {
                console.log("\n  INDICES:");
                indices.rows.forEach(i => console.log(`    - ${i.indexname}`));
            }

            // foreign keys de la tabla
            const fks = await client.query(`
                SELECT
                    kcu.column_name,
                    ccu.table_name AS foreign_table,
                    ccu.column_name AS foreign_column
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                    ON tc.constraint_name = kcu.constraint_name
                JOIN information_schema.constraint_column_usage AS ccu
                    ON ccu.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_name = $1
            `, [nombre]);

            if (fks.rows.length > 0) {
                console.log("\n  FOREIGN KEYS:");
                fks.rows.forEach(f =>
                    console.log(`    - ${f.column_name} → ${f.foreign_table}(${f.foreign_column})`)
                );
            }

            // conteo de filas
            const count = await client.query(`SELECT COUNT(*) FROM ${nombre}`);
            console.log(`\n  FILAS ACTUALES: ${count.rows[0].count}`);
            console.log("");
        }

    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        await client.end();
        console.log("Proceso terminado.");
    }
}

verEstructura();