require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect()
    .then(() => console.log("Conexion a PostgreSQL exitosa"))
    .catch(err => console.error("Error en DB:", err.message));

module.exports = {
    query: (text, params) => pool.query(text, params)
};