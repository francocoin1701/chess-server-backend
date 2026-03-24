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
    connectionString: process.env.DATABASE_URL || "TU_URL_EXTERNA_AQUI",
    ssl: { rejectUnauthorized: false }
});

db.connect().then(() => console.log("✅ DB Conectada")).catch(e => console.error(e));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket']
});

// Guardaremos: { chess: ChessObj, white: wallet, black: wallet }
const activeGames = new Map();

io.on('connection', (socket) => {
    
    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recoveredAddress = ethers.verifyMessage(message, signature);
            if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
                const res = await db.query(
                    `INSERT INTO users (wallet) VALUES ($1) 
                     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
                     RETURNING *`, [address.toLowerCase()]
                );
                socket.wallet = address.toLowerCase();
                socket.emit('auth_success', res.rows[0]);
            }
        } catch (e) { socket.emit('auth_error', "Error Auth"); }
    });

    socket.on('join_room', async (roomId) => {
        if (!socket.wallet) return;
        socket.join(roomId);

        // Si la sala no existe, el primer jugador es el CREADOR
        if (!activeGames.has(roomId)) {
            // Consultar último color del creador
            const userRes = await db.query('SELECT last_color FROM users WHERE wallet = $1', [socket.wallet]);
            const lastColor = userRes.rows[0]?.last_color;
            
            // Si el creador usó blancas, ahora le tocan NEGRAS ('b')
            const assignedColor = lastColor === 'w' ? 'b' : 'w';

            activeGames.set(roomId, {
                chess: new Chess(),
                white: assignedColor === 'w' ? socket.wallet : null,
                black: assignedColor === 'b' ? socket.wallet : null
            });
            
            console.log(`🏠 Sala ${roomId} creada. ${socket.wallet} es ${assignedColor}`);
        } else {
            // El segundo jugador toma el color libre
            const gameData = activeGames.get(roomId);
            if (!gameData.white && gameData.black !== socket.wallet) {
                gameData.white = socket.wallet;
            } else if (!gameData.black && gameData.white !== socket.wallet) {
                gameData.black = socket.wallet;
            }
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

        const chess = gameData.chess;
        const turn = chess.turn(); // 'w' o 'b'

        // SEGURIDAD: Validar que la wallet sea la dueña del turno
        const authorizedWallet = turn === 'w' ? gameData.white : gameData.black;
        
        if (socket.wallet !== authorizedWallet) {
            return socket.emit('error_msg', "No es tu turno o no eres ese color");
        }

        try {
            if (chess.move(moveData)) {
                io.to(roomId).emit('update_game', { pgn: chess.pgn(), move: moveData });

                // Si termina el juego, actualizamos 'last_color' en la DB para ambos
                if (chess.isGameOver()) {
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', gameData.white]);
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', gameData.black]);
                    console.log("🏁 Fin del juego. Colores actualizados en DB.");
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
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Puerto ${PORT}`));