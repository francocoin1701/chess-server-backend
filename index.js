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
                await db.query(`INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet`, [address.toLowerCase()]);
                socket.wallet = address.toLowerCase();
                socket.emit('auth_success', { wallet: socket.wallet });
            }
        } catch (e) { socket.emit('auth_error', "Error Auth"); }
    });

    socket.on('get_challenges', async () => {
        const list = await lobbyManager.getOpenChallenges();
        socket.emit('list_challenges', list);
    });

    socket.on('create_challenge', async ({ amount, timeLimit }) => {
        if (!socket.wallet) return;
        const roomId = `room_${Math.random().toString(36).substring(7)}`;
        const challenge = await lobbyManager.createChallenge(socket.wallet, amount, timeLimit, roomId);
        if (challenge) {
            // El creador ya inicializa el juego en memoria
            await gameManager.createGame(roomId, socket.wallet, timeLimit);
            const updatedList = await lobbyManager.getOpenChallenges();
            io.emit('list_challenges', updatedList);
            socket.emit('challenge_created', { roomId, timeLimit });
        }
    });

    socket.on('accept_challenge', async (roomId) => {
        if (!socket.wallet) return;
        
        const g = gameManager.activeGames.get(roomId);
        if (!g) return socket.emit('error_msg', "La sala ya no existe");

        const success = await lobbyManager.updateChallengeStatus(roomId, 'playing');
        if (success) {
            // ASIGNACIÓN DE COLOR AL SEGUNDO JUGADOR
            if (!g.white) g.white = socket.wallet;
            else g.black = socket.wallet;

            // Avisamos globalmente que esa apuesta se aceptó
            io.emit('challenge_accepted_global', { roomId, joiner: socket.wallet });
            
            const updatedList = await lobbyManager.getOpenChallenges();
            io.emit('list_challenges', updatedList);
        }
    });

    socket.on('join_room', async ({ roomId }) => {
        if (!socket.wallet) return;
        const g = gameManager.activeGames.get(roomId);
        if (!g) return;

        socket.join(roomId);

        // Si ya están los dos, activamos el reloj
        if (g.white && g.black && g.status === 'waiting') {
            g.status = 'active';
            g.timers.w = gameManager.GRACE_TIME;
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
                    io.to(roomId).emit('game_over', { reason: g.moveCount < 2 ? "timeout_start" : "timeout", winner: turn === 'w' ? 'b' : 'w' });
                    lobbyManager.updateChallengeStatus(roomId, 'finished');
                } else {
                    io.to(roomId).emit('tick', { timers: g.timers, turn: turn, lastMoveTimestamp: g.lastMoveTimestamp });
                }
            }, 1000);
        }

        const myColor = g.white === socket.wallet ? 'w' : (g.black === socket.wallet ? 'b' : 'viewer');
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
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor Corregido en puerto ${PORT}`));