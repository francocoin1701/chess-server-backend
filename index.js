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

async function recordResult(game, winnerColor, reason) {
    if (game.interval) clearInterval(game.interval);
    game.status = 'finished';
    const { white, black } = game;
    try {
        const playersData = await db.query('SELECT wallet, elo FROM users WHERE wallet IN ($1, $2)', [white, black]);
        const eloW = playersData.rows.find(r => r.wallet === white).elo;
        const eloB = playersData.rows.find(r => r.wallet === black).elo;
        let scoreW = winnerColor === 'w' ? 1 : (winnerColor === 'b' ? 0 : 0.5);
        const K = 32;
        const expW = 1 / (1 + Math.pow(10, (eloB - eloW) / 400));
        const expB = 1 / (1 + Math.pow(10, (eloW - eloB) / 400));
        const newEloW = Math.round(eloW + K * (scoreW - expW));
        const newEloB = Math.round(eloB + K * ((1 - scoreW) - expB));

        await db.query('UPDATE users SET last_color=$1, elo=$2, wins=wins+$3, losses=losses+$4, draws=draws+$5 WHERE wallet=$6', ['w', newEloW, scoreW === 1 ? 1 : 0, scoreW === 0 ? 1 : 0, scoreW === 0.5 ? 1 : 0, white]);
        await db.query('UPDATE users SET last_color=$1, elo=$2, wins=wins+$3, losses=losses+$4, draws=draws+$5 WHERE wallet=$6', ['b', newEloB, scoreW === 0 ? 1 : 0, scoreW === 1 ? 1 : 0, scoreW === 0.5 ? 1 : 0, black]);
        syncUserProfile(white); syncUserProfile(black);
    } catch (e) { console.error("Error al grabar resultado:", e); }
}

async function syncUserProfile(wallet) {
    try {
        const res = await db.query(`SELECT * FROM users WHERE wallet = $1`, [wallet.toLowerCase()]);
        const sockets = await io.fetchSockets();
        for (const s of sockets) { if (s.wallet === wallet.toLowerCase()) s.emit('auth_success', res.rows[0]); }
    } catch (e) {}
}

async function broadcastLobbyUpdate() {
    const list = await lobbyManager.getOpenChallenges();
    io.emit('list_challenges', list);
}

io.on('connection', (socket) => {
    console.log('🔗 Conexión establecida:', socket.id);

    // --- RE-AUTENTICACIÓN (EL MOTOR CONTRA EL LIMBO) ---
    socket.on('reauth', async (wallet) => {
        if (!wallet) return;
        const cleanWallet = wallet.toLowerCase();
        socket.wallet = cleanWallet; // VINCULACIÓN INMEDIATA
        console.log(`♻️ Re-vinculado: ${cleanWallet}`);
        const res = await db.query(`SELECT * FROM users WHERE wallet = $1`, [cleanWallet]);
        if (res.rows.length > 0) {
            socket.emit('auth_success', res.rows[0]);
        }
    });

    socket.on('auth_web3', async ({ address, signature, message }) => {
        try {
            const recovered = ethers.verifyMessage(message, signature);
            if (recovered.toLowerCase() === address.toLowerCase()) {
                const wallet = address.toLowerCase();
                const res = await db.query(`INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet RETURNING *`, [wallet]);
                socket.wallet = wallet; 
                socket.emit('auth_success', res.rows[0]);
            }
        } catch (e) { socket.emit('auth_error', "Falla en firma"); }
    });

    socket.on('get_challenges', async () => {
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
        const live = await db.query("SELECT c.*, u1.nickname as white_nick, u2.nickname as black_nick FROM challenges c JOIN users u1 ON c.creator_wallet = u1.wallet LEFT JOIN users u2 ON u2.room_id = u2.wallet WHERE c.status = 'playing' LIMIT 10");
        socket.emit('list_live_games', live.rows);
    });

    socket.on('create_challenge', async (data) => {
        console.log("Intentando crear apuesta para wallet:", socket.wallet);
        if (!socket.wallet) return socket.emit('error_msg', "Sesión perdida. Recarga la página.");
        
        const roomId = `room_${Math.random().toString(36).substring(7)}`;
        const challenge = await lobbyManager.createChallenge(socket.wallet, data.amount, data.timeLimit, roomId);
        
        if (challenge) {
            await gameManager.createGame(roomId, socket.wallet, data.timeLimit);
            console.log("✅ Apuesta creada:", roomId);
            broadcastLobbyUpdate();
            socket.emit('challenge_created', { roomId });
        } else {
            socket.emit('error_msg', "No se pudo guardar la apuesta en DB");
        }
    });

    socket.on('accept_challenge', async (roomId) => {
        if (!socket.wallet) return socket.emit('error_msg', "Sesión perdida.");
        const g = gameManager.activeGames.get(roomId);
        if (g && await lobbyManager.updateChallengeStatus(roomId, 'playing')) {
            const joiner = socket.wallet.toLowerCase();
            if (!g.white) g.white = joiner; else g.black = joiner;
            io.emit('challenge_accepted_global', { roomId, joiner });
            broadcastLobbyUpdate();
        }
    });

    socket.on('join_room', async ({ roomId }) => {
        const g = gameManager.activeGames.get(roomId);
        if (!g) return;
        socket.join(roomId);
        if (g.white && g.black && g.status === 'waiting') {
            g.status = 'active'; g.timers.w = gameManager.GRACE_TIME; g.lastMoveTimestamp = Date.now();
            g.interval = setInterval(async () => {
                const turn = g.chess.turn();
                const timeLeft = g.timers[turn] - Math.floor((Date.now() - g.lastMoveTimestamp) / 1000);
                if (timeLeft <= 0) {
                    const winner = turn === 'w' ? 'b' : 'w';
                    await recordResult(g, winner, 'timeout');
                    io.to(roomId).emit('game_over', { reason: g.moveCount < 2 ? 'timeout_start' : 'timeout', winner });
                    await lobbyManager.updateChallengeStatus(roomId, 'finished');
                } else {
                    io.to(roomId).emit('tick', { timers: g.timers, turn, lastMoveTimestamp: g.lastMoveTimestamp });
                }
            }, 1000);
        }
        socket.emit('player_color', (socket.wallet === g.white) ? 'w' : (socket.wallet === g.black ? 'b' : 'viewer'));
        io.to(roomId).emit('init_game', { pgn: g.chess.pgn(), white: g.white, black: g.black, timers: g.timers, status: g.status, lastMoveTimestamp: g.lastMoveTimestamp });
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const result = await gameManager.handleMove(roomId, moveData, socket.wallet);
        if (result.error) return socket.emit('error_msg', result.error);
        if (result.status === 'finished') {
            await recordResult(gameManager.activeGames.get(roomId), result.winner, result.reason);
            await lobbyManager.updateChallengeStatus(roomId, 'finished');
            io.to(roomId).emit('game_over', { reason: result.reason, winner: result.winner });
        }
        io.to(roomId).emit('update_game', { pgn: result.pgn, timers: result.timers, status: result.status, lastMoveTimestamp: result.lastMoveTimestamp });
    });

    socket.on('reset_game', async (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (g) {
            if (g.interval) clearInterval(g.interval);
            gameManager.activeGames.delete(roomId);
        }
        if (roomId) await lobbyManager.updateChallengeStatus(roomId, 'cancelled');
        broadcastLobbyUpdate();
        socket.emit('game_reset_complete');
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');