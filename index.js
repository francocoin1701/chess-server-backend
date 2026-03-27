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

// 1. CONFIGURACIÓN BLOCKCHAIN (LECTOR)
const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const CONTRACT_ADDRESS = "0x3264C2a0542695f1bd4Ce4d83865449c53695710";
const ABI = ["function partidas(uint256) view returns (address c, address o, uint256 m, uint8 e, address g)"];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function syncUserProfile(wallet) {
    try {
        const res = await db.query(`SELECT * FROM users WHERE wallet = $1`, [wallet.toLowerCase()]);
        if (res.rows.length > 0) {
            const sockets = await io.fetchSockets();
            sockets.forEach(s => { if (s.wallet === wallet.toLowerCase()) s.emit('auth_success', res.rows[0]); });
        }
    } catch (e) { console.error("Error syncProfile:", e); }
}

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
        
        // --- AQUÍ LLAMARÍAMOS AL RELAY HTTP PARA LIQUIDAR EN BLOCKCHAIN ---
        console.log(`🏁 Partida #${game.blockchainId} terminada. PGN listo para IA.`);
        
        await syncUserProfile(white);
        await syncUserProfile(black);
    } catch (e) { console.error("Error recordResult:", e); }
}

async function broadcastLobbyUpdate() {
    try {
        const list = await lobbyManager.getOpenChallenges();
        io.emit('list_challenges', list);
    } catch (e) { console.error("Error broadcast:", e); }
}

io.on('connection', (socket) => {
    socket.on('reauth', async (wallet) => {
        if (!wallet) return;
        const cleanWallet = wallet.toLowerCase();
        socket.wallet = cleanWallet;
        const res = await db.query(`SELECT * FROM users WHERE wallet = $1`, [cleanWallet]);
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
        } catch (e) { socket.emit('auth_error', "Error firma"); }
    });

    socket.on('get_challenges', async () => {
        broadcastLobbyUpdate();
    });

    // 2. CREACIÓN SEGURA (VERIFICADA EN CADENA)
    socket.on('create_challenge', async (data) => {
        if (!socket.wallet) return socket.emit('error_msg', "Sesión no iniciada");
        
        const { amount, timeLimit, blockchainId } = data;

        try {
            // Verificamos en el contrato
            const onChain = await contract.partidas(blockchainId);
            if (onChain.c.toLowerCase() !== socket.wallet) {
                return socket.emit('error_msg', "No eres el creador en el contrato");
            }

            const roomId = `room_${Math.random().toString(36).substring(7)}`;
            if (await lobbyManager.createChallenge(socket.wallet, amount, timeLimit, roomId, blockchainId)) {
                await gameManager.createGame(roomId, socket.wallet, timeLimit, blockchainId);
                broadcastLobbyUpdate();
                socket.emit('challenge_created', { roomId });
            }
        } catch (e) { socket.emit('error_msg', "Error al verificar pago on-chain"); }
    });

    // 3. ACEPTACIÓN SEGURA (VERIFICADA EN CADENA)
    socket.on('accept_challenge', async (roomId) => {
        if (!socket.wallet) return;
        const g = gameManager.activeGames.get(roomId);
        if (!g) return;

        try {
            const onChain = await contract.partidas(g.blockchainId);
            if (onChain.o.toLowerCase() !== socket.wallet) {
                return socket.emit('error_msg', "Primero debes pagar la apuesta en el contrato");
            }

            if (await lobbyManager.updateChallengeStatus(roomId, 'playing')) {
                const joiner = socket.wallet.toLowerCase();
                if (!g.white) g.white = joiner; else g.black = joiner;
                io.emit('challenge_accepted_global', { roomId, joiner });
                broadcastLobbyUpdate();
            }
        } catch (e) { socket.emit('error_msg', "Error al validar oponente"); }
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
            const gameObj = gameManager.activeGames.get(roomId);
            await recordResult(gameObj, result.winner, result.reason);
            await lobbyManager.updateChallengeStatus(roomId, 'finished');
            io.to(roomId).emit('game_over', { reason: result.reason, winner: result.winner });
        }
        io.to(roomId).emit('update_game', { pgn: result.pgn, timers: result.timers, status: result.status, lastMoveTimestamp: result.lastMoveTimestamp });
    });

    socket.on('reset_game', async (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        gameManager.activeGames.delete(roomId);
        if (roomId) await lobbyManager.updateChallengeStatus(roomId, 'cancelled');
        broadcastLobbyUpdate();
        socket.emit('game_reset_complete');
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');