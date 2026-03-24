const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const { ethers } = require('ethers'); // Asegúrate que sea v6
const { Client } = require('pg');

const app = express();
app.use(cors());

const connectionString = process.env.DATABASE_URL;

const db = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

async function connectDB() {
    if (!connectionString) {
        console.error("❌ ERROR: DATABASE_URL no definida en Render.");
        return;
    }
    try {
        await db.connect();
        console.log("✅ Conexión a PostgreSQL exitosa");
    } catch (err) {
        console.error("❌ Error conectando a la DB:", err.message);
    }
}
connectDB();

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

const games = new Map();

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            // CORRECCIÓN PARA ETHERS V6: Se usa ethers.verifyMessage directamente
            const recoveredAddress = ethers.verifyMessage(message, signature);
            
            if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
                const res = await db.query(
                    `INSERT INTO users (wallet) VALUES ($1) 
                     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
                     RETURNING *`, 
                    [address.toLowerCase()]
                );
                
                socket.wallet = address.toLowerCase();
                socket.emit('auth_success', res.rows[0]);
                console.log("👤 Login exitoso:", address);
            } else {
                socket.emit('auth_error', "Firma inválida.");
            }
        } catch (error) {
            console.error("❌ Error en auth_web3:", error.message);
            socket.emit('auth_error', "Error de servidor: " + error.message);
        }
    });

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!games.has(roomId)) games.set(roomId, new Chess());
        socket.emit('init_game', games.get(roomId).pgn());
    });

    socket.on('move', ({ roomId, moveData }) => {
        const game = games.get(roomId);
        if (!game) return;
        try {
            if (game.move(moveData)) {
                io.to(roomId).emit('update_game', { pgn: game.pgn(), move: moveData });
            }
        } catch (e) { console.log("Movimiento ilegal"); }
    });

    socket.on('reset_game', (roomId) => {
        if (games.has(roomId)) {
            games.set(roomId, new Chess());
            io.to(roomId).emit('init_game', "");
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
});