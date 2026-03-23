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
const db = new Client({
    // Usa la URL de Render en producción o la externa para pruebas locales
    connectionString: process.env.DATABASE_URL || "TU_URL_EXTERNA_AQUI",
    ssl: { rejectUnauthorized: false }
});

db.connect()
    .then(() => console.log("✅ Conectado a PostgreSQL"))
    .catch(err => console.error("❌ Error de conexión DB:", err));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Diccionario para manejar múltiples partidas por sala
const games = new Map();

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    // --- LOGIN WEB3 ---
    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            // Verificar la firma criptográfica
            const recoveredAddress = ethers.utils.verifyMessage(message, signature);
            
            if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
                // Upsert del usuario en la base de datos
                const res = await db.query(
                    `INSERT INTO users (wallet) VALUES ($1) 
                     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
                     RETURNING *`, 
                    [address.toLowerCase()]
                );

                const userProfile = res.rows[0];
                socket.wallet = userProfile.wallet; // Vinculamos la wallet al socket
                socket.emit('auth_success', userProfile);
                console.log(`👤 Usuario autenticado: ${userProfile.wallet}`);
            } else {
                socket.emit('auth_error', "Firma no válida");
            }
        } catch (error) {
            console.error("Error en Auth:", error);
            socket.emit('auth_error', "Error en el servidor de autenticación");
        }
    });

    // --- ENTRAR A UNA SALA (ROOM) ---
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        
        // Si la sala no tiene un juego activo, lo creamos
        if (!games.has(roomId)) {
            games.set(roomId, new Chess());
        }

        const currentGame = games.get(roomId);
        // Enviamos el estado actual de esa sala específica
        socket.emit('init_game', currentGame.pgn());
        console.log(`🏠 Socket ${socket.id} entró a sala: ${roomId}`);
    });

    // --- MOVIMIENTO ---
    socket.on('move', ({ roomId, moveData }) => {
        const game = games.get(roomId);
        if (!game) return;

        try {
            const result = game.move(moveData);
            if (result) {
                // Emitir solo a los usuarios que están en esa sala
                io.to(roomId).emit('update_game', {
                    pgn: game.pgn(),
                    move: result
                });
                
                if (game.isGameOver()) {
                    console.log(`🏁 Partida finalizada en sala ${roomId}`);
                }
            }
        } catch (e) {
            console.log("Movimiento ilegal detectado");
        }
    });

    // --- REINICIAR JUEGO DE LA SALA ---
    socket.on('reset_game', (roomId) => {
        if (games.has(roomId)) {
            games.set(roomId, new Chess());
            io.to(roomId).emit('init_game', "");
            console.log(`🔄 Juego reiniciado en sala: ${roomId}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de Ajedrez corriendo en puerto ${PORT}`);
});