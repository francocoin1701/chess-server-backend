const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { ethers } = require('ethers');

const db = require('./db');
const gameManager = require('./gameManager');
const lobbyManager = require('./lobbyManager');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket'] });

io.on('connection', (socket) => {
    
    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recovered = ethers.verifyMessage(message, signature);
            if (recovered.toLowerCase() === address.toLowerCase()) {
                const wallet = address.toLowerCase();
                await db.query(`INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet`, [wallet]);
                socket.wallet = wallet;
                socket.emit('auth_success', { wallet });
            }
        } catch (e) { socket.emit('auth_error', "Error Auth"); }
    });

    socket.on('get_challenges', async () => {
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    socket.on('create_challenge', async ({ amount, timeLimit }) => {
        if (!socket.wallet) return;
        const roomId = `room_${Math.random().toString(36).substring(7)}`;
        const challenge = await lobbyManager.createChallenge(socket.wallet, amount, timeLimit, roomId);
        if (challenge) {
            await gameManager.createGame(roomId, socket.wallet, timeLimit);
            io.emit('list_challenges', await lobbyManager.getOpenChallenges());
            socket.emit('challenge_created', { roomId });
        }
    });

    socket.on('accept_challenge', async (roomId) => {
        if (!socket.wallet) return;
        const g = gameManager.activeGames.get(roomId);
        if (!g) return socket.emit('error_msg', "La apuesta ya no existe");

        const success = await lobbyManager.updateChallengeStatus(roomId, 'playing');
        if (success) {
            const joiner = socket.wallet.toLowerCase();
            if (!g.white) g.white = joiner;
            else g.black = joiner;
            io.emit('challenge_accepted_global', { roomId, joiner });
            io.emit('list_challenges', await lobbyManager.getOpenChallenges());
        }
    });

    socket.on('join_room', async ({ roomId }) => {
        const wallet = socket.wallet?.toLowerCase();
        if (!wallet) return;
        const g = gameManager.activeGames.get(roomId);
        if (!g) return;

        socket.join(roomId);

        // ACTIVACIÓN DEL RELOJ DE GRACIA (10s) AL ENTRAR EL SEGUNDO JUGADOR
        if (g.white && g.black && g.status === 'waiting') {
            g.status = 'active';
            g.timers.w = gameManager.GRACE_TIME; // El blanco solo tiene 10s para su primera jugada
            g.lastMoveTimestamp = Date.now();

            if (g.interval) clearInterval(g.interval);
            g.interval = setInterval(() => {
                const turn = g.chess.turn();
                const now = Date.now();
                const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
                const timeLeft = g.timers[turn] - elapsed;

                if (timeLeft <= 0) {
                    clearInterval(g.interval);
                    g.status = 'finished';
                    // Emitimos si fue cancelación por inicio o tiempo normal
                    io.to(roomId).emit('game_over', { 
                        reason: g.moveCount < 2 ? "timeout_start" : "timeout", 
                        winner: turn === 'w' ? 'b' : 'w' 
                    });
                    lobbyManager.updateChallengeStatus(roomId, 'finished');
                } else {
                    io.to(roomId).emit('tick', { timers: g.timers, turn, lastMoveTimestamp: g.lastMoveTimestamp });
                }
            }, 1000);
        }

        const myColor = (g.white === wallet) ? 'w' : (g.black === wallet ? 'b' : 'viewer');
        socket.emit('player_color', myColor);
        io.to(roomId).emit('init_game', { 
            pgn: g.chess.pgn(), white: g.white, black: g.black, 
            timers: g.timers, status: g.status, lastMoveTimestamp: g.lastMoveTimestamp 
        });
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const result = await gameManager.handleMove(roomId, moveData, socket.wallet);
        if (result.error) return socket.emit('error_msg', result.error);
        io.to(roomId).emit('update_game', { pgn: result.pgn, timers: result.timers, status: result.status, lastMoveTimestamp: result.lastMoveTimestamp });
        if (result.status === 'finished') lobbyManager.updateChallengeStatus(roomId, 'finished');
    });

    socket.on('reset_game', (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        gameManager.activeGames.delete(roomId);
        lobbyManager.updateChallengeStatus(roomId, 'cancelled');
        io.to(roomId).emit('game_reset_complete');
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0');