const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const { ethers } = require('ethers');
const { Client } = require('pg');

const app = express();
app.use(cors());

const db = new Client({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false }
});

db.connect()
    .then(() => console.log("✅ Servidor conectado a la DB preparada"))
    .catch(e => console.error("❌ Error: La DB no está lista. Ejecuta init_db.js primero.", e.message));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

const activeGames = new Map();

io.on('connection', (socket) => {
    
    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recoveredAddress = ethers.verifyMessage(message, signature);
            if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
                await db.query(
                    `INSERT INTO users (wallet) VALUES ($1) 
                     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet`, 
                    [address.toLowerCase()]
                );
                socket.wallet = address.toLowerCase();
                socket.emit('auth_success', { wallet: socket.wallet });
            }
        } catch (e) { socket.emit('auth_error', "Error en autenticación"); }
    });

    socket.on('join_room', async (roomId) => {
        if (!socket.wallet) return socket.emit('error_msg', "Inicia sesión primero");

        socket.join(roomId);

        if (!activeGames.has(roomId)) {
            // Lógica de color alternado basada en DB
            let assignedColor = 'w'; 
            try {
                const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [socket.wallet]);
                assignedColor = res.rows[0]?.last_color === 'w' ? 'b' : 'w';
            } catch (e) { console.log("Usando color por defecto"); }

            activeGames.set(roomId, {
                chess: new Chess(),
                white: assignedColor === 'w' ? socket.wallet : null,
                black: assignedColor === 'b' ? socket.wallet : null
            });
        } else {
            const gameData = activeGames.get(roomId);
            if (!gameData.white && gameData.black !== socket.wallet) gameData.white = socket.wallet;
            else if (!gameData.black && gameData.white !== socket.wallet) gameData.black = socket.wallet;
        }

        const gameData = activeGames.get(roomId);
        const myColor = gameData.white === socket.wallet ? 'w' : (gameData.black === socket.wallet ? 'b' : 'viewer');

        io.to(roomId).emit('init_game', {
            pgn: gameData.chess.pgn(),
            white: gameData.white,
            black: gameData.black
        });
        socket.emit('player_color', myColor);
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const gameData = activeGames.get(roomId);
        if (!gameData || !socket.wallet) return;

        const turn = gameData.chess.turn();
        const authorizedWallet = turn === 'w' ? gameData.white : gameData.black;
        
        if (socket.wallet !== authorizedWallet) return socket.emit('error_msg', "No es tu turno");

        try {
            if (gameData.chess.move(moveData)) {
                io.to(roomId).emit('update_game', { pgn: gameData.chess.pgn(), move: moveData });

                if (gameData.chess.isGameOver()) {
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', gameData.white]);
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', gameData.black]);
                }
            }
        } catch (e) { console.log("Ilegal"); }
    });

    socket.on('reset_game', (roomId) => {
        const gameData = activeGames.get(roomId);
        if (gameData) {
            gameData.chess.reset();
            io.to(roomId).emit('init_game', { pgn: "", white: gameData.white, black: gameData.black });
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));