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
                lastMoveTimestamp: Date.now(),
                status: 'waiting',
                interval: null
            });
        } else {
            const g = activeGames.get(roomId);
            if (!g.white && g.black !== socket.wallet) g.white = socket.wallet;
            else if (!g.black && g.white !== socket.wallet) g.black = socket.wallet;

            // CUANDO SE UNE EL SEGUNDO: ACTIVAR EL VIGILANTE DEL SERVIDOR
            if (g.white && g.black && g.status === 'waiting') {
                g.status = 'active';
                g.timers.w = START_GRACE_TIME; 
                g.lastMoveTimestamp = Date.now();
                
                // EL VIGILANTE: Revisa cada segundo si alguien perdió por tiempo
                g.interval = setInterval(() => {
                    const turn = g.chess.turn();
                    const now = Date.now();
                    const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
                    const timeLeft = g.timers[turn] - elapsed;

                    if (timeLeft <= 0) {
                        clearInterval(g.interval);
                        g.status = 'finished';
                        io.to(roomId).emit('game_over', { 
                            reason: g.moveCount < 2 ? "timeout_start" : "timeout", 
                            winner: turn === 'w' ? 'b' : 'w' 
                        });
                    }
                }, 1000);
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
                const now = Date.now();
                const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
                
                // Descontar tiempo real
                g.timers[turn] -= elapsed;
                g.lastMoveTimestamp = now;
                g.moveCount++;

                // Lógica de los 10s de gracia
                if (g.moveCount === 1) {
                    g.timers.w = GAME_TIME; // Blanco ya movió, recupera sus 10m
                    g.timers.b = START_GRACE_TIME; // Negro tiene 10s para responder
                } else if (g.moveCount === 2) {
                    g.timers.b = GAME_TIME; // Negro ya movió, recupera sus 10m
                }

                if (g.chess.isGameOver()) {
                    clearInterval(g.interval);
                    g.status = 'finished';
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', g.white]);
                    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', g.black]);
                    io.to(roomId).emit('update_game', { pgn: g.chess.pgn(), timers: g.timers, status: 'finished' });
                } else {
                    io.to(roomId).emit('update_game', { pgn: g.chess.pgn(), timers: g.timers, status: 'active' });
                }
            }
        } catch (e) { socket.emit('error_msg', "Ilegal"); }
    });

    socket.on('reset_game', (roomId) => {
        const g = activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        activeGames.delete(roomId);
        io.to(roomId).emit('game_reset_complete');
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');