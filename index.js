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
const GAME_TIME = 600; 
const START_GRACE_TIME = 10;

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
            const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [socket.wallet]);
            const assigned = (res.rows[0]?.last_color === 'w') ? 'b' : 'w';

            activeGames.set(roomId, {
                chess: new Chess(),
                white: assigned === 'w' ? socket.wallet : null,
                black: assigned === 'b' ? socket.wallet : null,
                timers: { w: GAME_TIME, b: GAME_TIME },
                moveCount: 0,
                lastMoveTimestamp: null,
                status: 'waiting'
            });
        } else {
            const g = activeGames.get(roomId);
            if (!g.white && g.black !== socket.wallet) g.white = socket.wallet;
            else if (!g.black && g.white !== socket.wallet) g.black = socket.wallet;

            if (g.white && g.black && g.status === 'waiting') {
                g.status = 'active';
                g.lastMoveTimestamp = Date.now();
                g.timers.w = START_GRACE_TIME; 
            }
        }

        const g = activeGames.get(roomId);
        const myColor = g.white === socket.wallet ? 'w' : (g.black === socket.wallet ? 'b' : 'viewer');

        io.to(roomId).emit('init_game', {
            pgn: g.chess.pgn(),
            white: g.white,
            black: g.black,
            timers: g.timers,
            status: g.status
        });
        socket.emit('player_color', myColor);
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const g = activeGames.get(roomId);
        if (!g || !socket.wallet || g.status !== 'active') return;

        const turn = g.chess.turn();
        if (socket.wallet !== (turn === 'w' ? g.white : g.black)) return;

        try {
            if (g.chess.move(moveData)) {
                g.moveCount++;
                const now = Date.now();
                
                // Cálculo de tiempo
                const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
                g.timers[turn] -= elapsed;
                g.lastMoveTimestamp = now;

                // Si hay mate o tablas, paramos todo
                if (g.chess.isGameOver()) {
                    g.status = 'finished';
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', g.white]);
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', g.black]);
                } else {
                    // Si no es el fin, ajustamos tiempos para la jugada siguiente
                    if (g.moveCount === 1) { g.timers.b = START_GRACE_TIME; g.timers.w = GAME_TIME; }
                    else if (g.moveCount === 2) { g.timers.b = GAME_TIME; }
                }

                if (g.timers[turn] <= 0 && g.status !== 'finished') {
                    g.status = 'finished';
                    io.to(roomId).emit('game_over', { reason: g.moveCount < 2 ? "timeout_start" : "timeout", winner: turn === 'w' ? 'b' : 'w' });
                } else {
                    io.to(roomId).emit('update_game', { pgn: g.chess.pgn(), timers: g.timers, status: g.status });
                }
            }
        } catch (e) { socket.emit('error_msg', "Ilegal"); }
    });

    socket.on('reset_game', (roomId) => {
        activeGames.delete(roomId);
        io.to(roomId).emit('game_reset_complete');
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');