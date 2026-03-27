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

const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const CONTRACT_ADDRESS = "0x3264C2a0542695f1bd4Ce4d83865449c53695710";
const ABI = ["function partidas(uint256) view returns (address c, address o, uint256 m, uint8 e, address g)"];
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function broadcastLobbyUpdate() {
    const list = await lobbyManager.getOpenChallenges();
    io.emit('list_challenges', list);
}

io.on('connection', (socket) => {
    
    socket.on('reauth', async (wallet) => {
        socket.wallet = wallet.toLowerCase();
        const res = await db.query("SELECT * FROM users WHERE wallet = $1", [socket.wallet]);
        if (res.rows[0]) socket.emit('auth_success', res.rows[0]);
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    socket.on('auth_web3', async ({ address, signature, message }) => {
        const recovered = ethers.verifyMessage(message, signature);
        if (recovered.toLowerCase() === address.toLowerCase()) {
            const wallet = address.toLowerCase();
            await db.query("INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING", [wallet]);
            const res = await db.query("SELECT * FROM users WHERE wallet = $1", [wallet]);
            socket.wallet = wallet;
            socket.emit('auth_success', res.rows[0]);
        }
    });

    socket.on('get_challenges', async () => {
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    socket.on('create_challenge', async (data) => {
        if (!socket.wallet) return;
        try {
            const onChain = await contract.partidas(data.blockchainId);
            if (onChain.c.toLowerCase() !== socket.wallet) return socket.emit('error_msg', "No eres el creador");

            const roomId = `room_${Math.random().toString(36).substring(7)}`;
            await lobbyManager.createChallenge(socket.wallet, data.amount, data.timeLimit, roomId, data.blockchainId);
            await gameManager.createGame(roomId, socket.wallet, data.timeLimit, data.blockchainId);
            
            await broadcastLobbyUpdate(); // Esto hace que aparezca para todos
            socket.emit('challenge_created', { roomId, blockchainId: data.blockchainId });
        } catch (e) { socket.emit('error_msg', "Error validando pago"); }
    });

    socket.on('accept_challenge', async (roomId) => {
        const g = gameManager.activeGames.get(roomId);
        if (!g || !socket.wallet) return;
        try {
            const onChain = await contract.partidas(g.blockchainId);
            if (onChain.o.toLowerCase() !== socket.wallet) return socket.emit('error_msg', "No has pagado en el contrato");

            await lobbyManager.updateChallengeStatus(roomId, 'playing');
            g.black = socket.wallet;
            io.emit('challenge_accepted_global', { roomId, joiner: socket.wallet });
            await broadcastLobbyUpdate();
        } catch (e) { socket.emit('error_msg', "Error al aceptar"); }
    });

    socket.on('join_room', ({ roomId }) => {
        const g = gameManager.activeGames.get(roomId);
        if (!g) return;
        socket.join(roomId);
        if (g.white && g.black && g.status === 'waiting') {
            g.status = 'active';
            g.lastMoveTimestamp = Date.now();
            // Lógica de timers aquí...
        }
        socket.emit('player_color', socket.wallet === g.white ? 'w' : (socket.wallet === g.black ? 'b' : 'viewer'));
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const result = await gameManager.handleMove(roomId, moveData, socket.wallet);
        if (result.error) return socket.emit('error_msg', result.error);
        if (result.status === 'finished') {
            await lobbyManager.updateChallengeStatus(roomId, 'finished');
            io.to(roomId).emit('game_over', result);
        }
        io.to(roomId).emit('update_game', result);
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');