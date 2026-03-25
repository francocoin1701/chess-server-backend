// db.js
const { Client } = require('pg');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

client.connect()
    .then(() => console.log("✅ Conexión a PostgreSQL exitosa (Módulo DB)"))
    .catch(err => console.error("❌ Error en DB:", err.message));

module.exports = client;