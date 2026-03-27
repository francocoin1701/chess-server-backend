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

// --- LÓGICA DE ELO OFICIAL ---
function getNewRatings(ratingA, ratingB, scoreA) {
    const K = 32;
    const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
    const expectedB = 1 / (1 + Math.pow(10, (ratingA - ratingB) / 400));
    const scoreB = 1 - scoreA;
    return {
        newA: Math.round(ratingA + K * (scoreA - expectedA)),
        newB: Math.round(ratingB + K * (scoreB - expectedB))
    };
}

// Sincronizar perfil con todos los clientes del usuario
async function syncUserProfile(wallet) {
    try {
        const res = await db.query(`SELECT * FROM users WHERE wallet = $1`, [wallet.toLowerCase()]);
        const sockets = await io.fetchSockets();
        sockets.forEach(s => {
            if (s.wallet === wallet.toLowerCase()) s.emit('auth_success', res.rows[0]);
        });
    } catch (e) { console.error("Error syncProfile:", e); }
}

// --- FUNCIÓN MAESTRA DE GUARDADO (INFRANQUEABLE) ---
async function recordResult(game, winnerColor, reason, roomId) {
    if (game.interval) clearInterval(game.interval);
    game.status = 'finished';
    
    const { white, black, chess, betAmount } = game;

    try {
        // 1. Obtener Elos actuales
        const playersData = await db.query('SELECT wallet, elo FROM users WHERE wallet IN ($1, $2)', [white, black]);
        const eloWhite = playersData.rows.find(r => r.wallet === white).elo;
        const eloBlack = playersData.rows.find(r => r.wallet === black).elo;

        // 2. Calcular resultado matemático
        let scoreWhite = winnerColor === 'w' ? 1 : (winnerColor === 'b' ? 0 : 0.5);
        const { newA: newEloW, newB: newEloB } = getNewRatings(eloWhite, eloBlack, scoreWhite);

        // 3. 🔥 INSERTAR EN HISTORIAL (Lo que faltaba)
        const winnerWallet = winnerColor === 'w' ? white : (winnerColor === 'b' ? black : null);
        await db.query(`
            INSERT INTO game_history (room_id, white_wallet, black_wallet, winner_wallet, bet_amount, pgn, end_reason)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [roomId, white, black, winnerWallet, betAmount || '0', chess.pgn(), reason]
        );

        // 4. Actualizar perfiles de usuario
        if (scoreWhite === 1) {
            await db.query('UPDATE users SET last_color=$1, elo=$2, wins=wins+1 WHERE wallet=$3', ['w', newEloW, white]);
            await db.query('UPDATE users SET last_color=$1, elo=$2, losses=losses+1 WHERE wallet=$3', ['b', newEloB, black]);
        } else if (scoreWhite === 0) {
            await db.query('UPDATE users SET last_color=$1, elo=$2, wins=wins+1 WHERE wallet=$3', ['b', newEloB, black]);
            await db.query('UPDATE users SET last_color=$1, elo=$2, losses=losses+1 WHERE wallet=$3', ['w', newEloW, white]);
        } else {
            await db.query('UPDATE users SET last_color=$1, elo=$2, draws=draws+1 WHERE wallet=$3', ['w', newEloW, white]);
            await db.query('UPDATE users SET last_color=$1, elo=$2, draws=draws+1 WHERE wallet=$3', ['b', newEloB, black]);
        }

        console.log(`🏁 Partida #${roomId} registrada con éxito.`);
        await syncUserProfile(white);
        await syncUserProfile(black);

    } catch (err) {
        console.error("❌ Error en recordResult:", err.message);
    }
}

io.on('connection', (socket) => {
    
    socket.on('reauth', async (wallet) => {
        if (!wallet) return;
        socket.wallet = wallet.toLowerCase();
        const res = await db.query(`SELECT * FROM users WHERE wallet = $1`, [socket.wallet]);
        if (res.rows.length > 0) socket.emit('auth_success', res.rows[0]);
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
        const live = await db.query(`SELECT c.room_id, u.nickname as white_nick FROM challenges c JOIN users u ON c.creator_wallet = u.wallet WHERE c.status = 'playing' LIMIT 10`);
        socket.emit('list_live_games', live.rows);
    });

    socket.on('create_challenge', async (data) => {
        if (!socket.wallet) return;
        const roomId = `room_${Math.random().toString(36).substring(7)}`;
        if (await lobbyManager.createChallenge(socket.wallet, data.amount, data.timeLimit, roomId)) {
            const game = await gameManager.createGame(roomId, socket.wallet, data.timeLimit);
            game.betAmount = data.amount; // Guardamos el monto en RAM para el final
            const list = await lobbyManager.getOpenChallenges();
            io.emit('list_challenges', list);
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
            const list = await lobbyManager.getOpenChallenges();
            io.emit('list_challenges', list);
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
                    await recordResult(g, winner, 'timeout', roomId);
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
            const gameObj = gameManager.activeGames.get(roomId);
            await recordResult(gameObj, result.winner, result.reason, roomId);
            await lobbyManager.updateChallengeStatus(roomId, 'finished');
            io.to(roomId).emit('game_over', { reason: result.reason, winner: result.winner });
        }
        io.to(roomId).emit('update_game', { pgn: result.pgn, timers: result.timers, status: result.status, lastMoveTimestamp: result.lastMoveTimestamp });
    });

    socket.on('reset_game', async (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (g) { if (g.interval) clearInterval(g.interval); gameManager.activeGames.delete(roomId); }
        if (roomId) await lobbyManager.updateChallengeStatus(roomId, 'cancelled');
        const list = await lobbyManager.getOpenChallenges();
        io.emit('list_challenges', list);
        socket.emit('game_reset_complete');
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');