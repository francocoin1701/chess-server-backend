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

// Función para enviar el perfil actualizado a un usuario específico
async function syncUserProfile(wallet) {
    try {
        const res = await db.query(
            `SELECT wallet, nickname, photo_url, elo, wins, losses, draws, balance_earned 
             FROM users WHERE wallet = $1`, [wallet.toLowerCase()]
        );
        // Buscamos todos los sockets de esta wallet y les mandamos su nuevo perfil
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
            if (s.wallet === wallet.toLowerCase()) {
                s.emit('auth_success', res.rows[0]);
            }
        }
    } catch (e) { console.error("Error syncProfile:", e); }
}

async function recordResult(game, winnerColor, reason) {
    if (game.interval) clearInterval(game.interval);
    game.status = 'finished';
    const { white, black } = game;

    // 1. Actualizar colores para la próxima
    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', white]);
    await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', black]);

    // 2. Actualizar estadísticas según el resultado
    if (!winnerColor) {
        await db.query('UPDATE users SET draws = draws + 1 WHERE wallet IN ($1, $2)', [white, black]);
    } else {
        const winner = (winnerColor === 'w') ? white : black;
        const loser = (winnerColor === 'w') ? black : white;
        await db.query('UPDATE users SET wins = wins + 1 WHERE wallet = $1', [winner]);
        await db.query('UPDATE users SET losses = losses + 1 WHERE wallet = $1', [loser]);
    }

    // 3. ENVIAR PERFILES ACTUALIZADOS A AMBOS (Para que se vea en la tarjeta)
    await syncUserProfile(white);
    await syncUserProfile(black);
}

io.on('connection', (socket) => {
    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recovered = ethers.verifyMessage(message, signature);
            if (recovered.toLowerCase() === address.toLowerCase()) {
                const wallet = address.toLowerCase();
                const res = await db.query(`
                    INSERT INTO users (wallet) VALUES ($1) 
                    ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
                    RETURNING wallet, nickname, photo_url, elo, wins, losses, draws, balance_earned`, [wallet]);
                socket.wallet = wallet;
                socket.emit('auth_success', res.rows[0]);
            }
        } catch (e) { socket.emit('auth_error', "Error Auth"); }
    });

    socket.on('update_profile', async (data) => {
        if (!socket.wallet) return;
        const res = await db.query(`UPDATE users SET nickname = $1, photo_url = $2 WHERE wallet = $3 RETURNING *`, [data.nickname, data.photoUrl, socket.wallet]);
        socket.emit('auth_success', res.rows[0]);
    });

    socket.on('get_challenges', async () => {
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    socket.on('create_challenge', async (data) => {
        if (!socket.wallet) return;
        const roomId = `room_${Math.random().toString(36).substring(7)}`;
        if (await lobbyManager.createChallenge(socket.wallet, data.amount, data.timeLimit, roomId)) {
            await gameManager.createGame(roomId, socket.wallet, data.timeLimit);
            io.emit('list_challenges', await lobbyManager.getOpenChallenges());
            socket.emit('challenge_created', { roomId });
        }
    });

    socket.on('accept_challenge', async (roomId) => {
        if (!socket.wallet) return;
        const g = gameManager.activeGames.get(roomId);
        if (g && await lobbyManager.updateChallengeStatus(roomId, 'playing')) {
            const joiner = socket.wallet.toLowerCase();
            if (!g.white) g.white = joiner; else g.black = joiner;
            io.emit('challenge_accepted_global', { roomId, joiner });
            io.emit('list_challenges', await lobbyManager.getOpenChallenges());
        }
    });

    socket.on('join_room', async ({ roomId }) => {
        const g = gameManager.activeGames.get(roomId);
        if (!g || !socket.wallet) return;
        socket.join(roomId);

        if (g.white && g.black && g.status === 'waiting') {
            g.status = 'active';
            g.timers.w = gameManager.GRACE_TIME; 
            g.lastMoveTimestamp = Date.now();
            g.interval = setInterval(async () => {
                const turn = g.chess.turn();
                const timeLeft = g.timers[turn] - Math.floor((Date.now() - g.lastMoveTimestamp) / 1000);

                if (timeLeft <= 0) {
                    const winner = turn === 'w' ? 'b' : 'w';
                    await recordResult(g, winner, 'timeout');
                    io.to(roomId).emit('game_over', { reason: g.moveCount < 2 ? 'timeout_start' : 'timeout', winner });
                    lobbyManager.updateChallengeStatus(roomId, 'finished');
                } else {
                    io.to(roomId).emit('tick', { timers: g.timers, turn, lastMoveTimestamp: g.lastMoveTimestamp });
                }
            }, 1000);
        }
        socket.emit('player_color', g.white === socket.wallet ? 'w' : 'b');
        io.to(roomId).emit('init_game', { pgn: g.chess.pgn(), white: g.white, black: g.black, timers: g.timers, status: g.status, lastMoveTimestamp: g.lastMoveTimestamp });
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const result = await gameManager.handleMove(roomId, moveData, socket.wallet);
        if (result.error) return socket.emit('error_msg', result.error);
        
        if (result.status === 'finished') {
            await recordResult(gameManager.activeGames.get(roomId), result.winner, result.reason);
            lobbyManager.updateChallengeStatus(roomId, 'finished');
            io.to(roomId).emit('game_over', { reason: result.reason, winner: result.winner });
        }
        io.to(roomId).emit('update_game', { pgn: result.pgn, timers: result.timers, status: result.status, lastMoveTimestamp: result.lastMoveTimestamp });
    });

    socket.on('reset_game', (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        gameManager.activeGames.delete(roomId);
        lobbyManager.updateChallengeStatus(roomId, 'cancelled');
        io.to(roomId).emit('game_reset_complete');
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');