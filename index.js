const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const { ethers } = require('ethers');
const { Client } = require('pg');

const app = express();
app.use(cors());

// CONFIGURACIÓN DE BASE DE DATOS
// Priorizamos process.env.DATABASE_URL que es la que usa Render
const connectionString = process.env.DATABASE_URL;

const db = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

if (connectionString) {
    db.connect()
        .then(() => console.log("✅ Conectado a PostgreSQL en Render"))
        .catch(err => console.error("❌ Error de conexión DB:", err));
} else {
    console.error("❌ ERROR: No se encontró la variable DATABASE_URL. Configúrala en Render.");
}

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const games = new Map();

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recoveredAddress = ethers.utils.verifyMessage(message, signature);
            if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
                const res = await db.query(
                    `INSERT INTO users (wallet) VALUES ($1) 
                     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
                     RETURNING *`, 
                    [address.toLowerCase()]
                );
                const userProfile = res.rows[0];
                socket.wallet = userProfile.wallet;
                socket.emit('auth_success', userProfile);
            } else {
                socket.emit('auth_error', "Firma no válida");
            }
        } catch (error) {
            console.error("Error en Auth:", error);
            socket.emit('auth_error', "Error de base de datos");
        }
    });

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!games.has(roomId)) {
            games.set(roomId, new Chess());
        }
        const currentGame = games.get(roomId);
        socket.emit('init_game', currentGame.pgn());
    });

    socket.on('move', ({ roomId, moveData }) => {
        const game = games.get(roomId);
        if (!game) return;
        try {
            const result = game.move(moveData);
            if (result) {
                io.to(roomId).emit('update_game', {
                    pgn: game.pgn(),
                    move: result
                });
            }
        } catch (e) {
            console.log("Movimiento ilegal");
        }
    });

    socket.on('reset_game', (roomId) => {
        if (games.has(roomId)) {
            games.set(roomId, new Chess());
            io.to(roomId).emit('init_game', "");
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});