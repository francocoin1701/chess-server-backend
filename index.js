const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { ethers } = require('ethers');
const db = require('./db');
const gameManager = require('./gameManager');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket'] });

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

    socket.on('join_room', async ({ roomId, timeLimit }) => {
        if (!socket.wallet) return;
        socket.join(roomId);

        let g = gameManager.activeGames.get(roomId);
        if (!g) {
            // El primer jugador crea la sala con el tiempo elegido
            g = await gameManager.createGame(roomId, socket.wallet, timeLimit);
        } else {
            // El segundo jugador se une a la sala existente
            if (!g.white && g.black !== socket.wallet) g.white = socket.wallet;
            else if (!g.black && g.white !== socket.wallet) g.black = socket.wallet;

            if (g.white && g.black && g.status === 'waiting') {
                g.status = 'active';
                g.timers.w = gameManager.GRACE_TIME;
                g.lastMoveTimestamp = Date.now();

                g.interval = setInterval(() => {
                    const turn = g.chess.turn();
                    const now = Date.now();
                    const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
                    const timeLeft = g.timers[turn] - elapsed;

                    if (timeLeft <= 0) {
                        clearInterval(g.interval);
                        g.status = 'finished';
                        io.to(roomId).emit('game_over', { reason: g.moveCount < 2 ? "timeout_start" : "timeout", winner: turn === 'w' ? 'b' : 'w' });
                    } else {
                        io.to(roomId).emit('tick', { timers: g.timers, turn: turn, lastMoveTimestamp: g.lastMoveTimestamp });
                    }
                }, 1000);
            }
        }
        
        const myColor = g.white === socket.wallet ? 'w' : (g.black === socket.wallet ? 'b' : 'viewer');
        
        // Enviamos los timers REALES de la sala (g.timers) no los por defecto
        io.to(roomId).emit('init_game', { 
            pgn: g.chess.pgn(), 
            white: g.white, 
            black: g.black, 
            timers: g.timers, 
            status: g.status, 
            lastMoveTimestamp: g.lastMoveTimestamp 
        });
        socket.emit('player_color', myColor);
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const result = await gameManager.handleMove(roomId, moveData, socket.wallet);
        if (result.error) return socket.emit('error_msg', result.error);
        io.to(roomId).emit('update_game', { pgn: result.pgn, timers: result.timers, status: result.status, lastMoveTimestamp: result.lastMoveTimestamp });
    });

    socket.on('reset_game', (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        gameManager.activeGames.delete(roomId);
        io.to(roomId).emit('game_reset_complete');
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));