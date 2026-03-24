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
db.connect().catch(e => console.error("Error DB:", e.message));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket'] });

const activeGames = new Map();

io.on('connection', (socket) => {
    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recovered = ethers.verifyMessage(message, signature);
            if (recovered.toLowerCase() === address.toLowerCase()) {
                await db.query(`INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet`, [address.toLowerCase()]);
                socket.wallet = address.toLowerCase();
                socket.emit('auth_success', { wallet: socket.wallet });
            }
        } catch (e) { socket.emit('auth_error', "Error Auth"); }
    });

    socket.on('join_room', async (roomId) => {
        if (!socket.wallet) return;
        socket.join(roomId);

        if (!activeGames.has(roomId)) {
            // Lógica de alternancia: el creador toma el color opuesto a su última partida
            const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [socket.wallet]);
            const last = res.rows[0]?.last_color;
            const assigned = (last === 'w') ? 'b' : 'w';

            activeGames.set(roomId, {
                chess: new Chess(),
                white: assigned === 'w' ? socket.wallet : null,
                black: assigned === 'b' ? socket.wallet : null
            });
            console.log(`Sala ${roomId}: Creador ${socket.wallet} asignado a ${assigned}`);
        } else {
            const g = activeGames.get(roomId);
            // El segundo en entrar toma el color que quede libre
            if (!g.white && g.black !== socket.wallet) g.white = socket.wallet;
            else if (!g.black && g.white !== socket.wallet) g.black = socket.wallet;
            console.log(`Sala ${roomId}: Segundo jugador ${socket.wallet} unido.`);
        }

        const g = activeGames.get(roomId);
        const myColor = g.white === socket.wallet ? 'w' : (g.black === socket.wallet ? 'b' : 'viewer');

        // Sincronización total para ambos PCs
        io.to(roomId).emit('init_game', {
            pgn: g.chess.pgn(),
            white: g.white,
            black: g.black
        });
        socket.emit('player_color', myColor);
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const g = activeGames.get(roomId);
        if (!g || !socket.wallet) return;

        const chess = g.chess;
        // El motor dice de quién es el turno ('w' o 'b')
        const currentTurnColor = chess.turn(); 
        const authorizedWallet = currentTurnColor === 'w' ? g.white : g.black;

        // Solo la wallet dueña del color de turno puede mover
        if (socket.wallet !== authorizedWallet) {
            return socket.emit('error_msg', "No es tu turno de mover");
        }

        try {
            if (chess.move(moveData)) {
                io.to(roomId).emit('update_game', { pgn: chess.pgn() });
                
                if (chess.isGameOver()) {
                    // Actualizar historial en DB al finalizar
                    if (g.white) await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', g.white]);
                    if (g.black) await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', g.black]);
                }
            }
        } catch (e) { socket.emit('error_msg', "Movimiento ilegal"); }
    });

    socket.on('reset_game', (roomId) => {
        const g = activeGames.get(roomId);
        if (g) {
            g.chess.reset();
            io.to(roomId).emit('init_game', { pgn: "", white: g.white, black: g.black });
        }
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');