require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { ethers } = require('ethers');
const db = require('./db');
const { activeGames, createGame, handleMove, startTimer } = require('./gameManager');
const lobbyManager = require('./lobbyManager');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket'] });

const provider = new ethers.JsonRpcProvider("https://eth-sepolia.g.alchemy.com/v2/ly6oQWP6UwzpBkxiChpcQuPMc2WQIlZk");

const CONTRACT_ADDRESS = "0xa809761C3c878e982136b9f41519326193df1DF3";

const ABI = [
    "function partidas(uint256) view returns (address creador, address oponente, uint256 montoApuesta, uint8 estado, string pgnOficial, uint8 colorCreador, uint8 resultado)",
    "function getPartidaActiva(address) view returns (bool activa, uint256 id)",
    "function nextId() view returns (uint256)",
    "function triggerAgent(uint256, string, uint8) external",
    "event RetoCreado(uint256 indexed id, address creador, uint256 monto)",
    "event RetoAceptado(uint256 indexed id, address oponente)",
    "event PartidaFinalizada(uint256 indexed id, address winner, uint8 resultado)",
    "event PartidaCancelada(uint256 indexed id)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function broadcastLobbyUpdate() {
    console.log("[BROADCAST] Enviando actualización de lobby a todos los clientes...");
    const list = await lobbyManager.getOpenChallenges();
    io.emit('list_challenges', list);
}

// ---------------------------------------------------------
// RECEPTOR DE EVENTOS DE BLOCKCHAIN (CORE)
// ---------------------------------------------------------
function initContractListeners() {
    console.log("🎮 Inicializando listeners de eventos del contrato...");

    contract.on("RetoCreado", async (id, creador, monto) => {
        const blockchainId = Number(id);
        const amount = ethers.formatEther(monto);
        const roomId = `room_${blockchainId}`;
        
        console.log(`📡 [EVENTO: RetoCreado] ID:${blockchainId}, Creador:${creador}`);

        try {
            const onChain = await contract.partidas(blockchainId);
            const colorCreador = Number(onChain.colorCreador);

            await lobbyManager.createChallenge(
                creador,
                amount,
                10,
                roomId,
                blockchainId,
                colorCreador
            );

            const whiteWallet = colorCreador === 0 ? creador.toLowerCase() : null;
            const blackWallet = colorCreador === 1 ? creador.toLowerCase() : null;

            if (!activeGames.get(roomId)) {
                await createGame(roomId, whiteWallet, blackWallet, 10, blockchainId, amount);
            }

            io.emit('challenge_created', {
                roomId,
                blockchainId,
                colorCreador,
                creator_wallet: creador
            });

            await broadcastLobbyUpdate();
        } catch (e) {
            console.error("Error procesando RetoCreado:", e.message);
        }
    });

    contract.on("RetoAceptado", async (id, oponente) => {
        const blockchainId = Number(id);
        const roomId = `room_${blockchainId}`;
        console.log(`📡 [EVENTO: RetoAceptado] ID:${blockchainId}, Oponente:${oponente}`);

        await lobbyManager.updateChallengeStatus(roomId, 'playing');
        
        let g = activeGames.get(roomId);
        if (g) {
            const onChain = await contract.partidas(blockchainId);
            const colorCreador = Number(onChain.colorCreador);
            if (colorCreador === 0) g.black = oponente.toLowerCase();
            else g.white = oponente.toLowerCase();
        } else {
            // Recrear juego en memoria si no existe
            const onChain = await contract.partidas(blockchainId);
            const colorCreador = Number(onChain.colorCreador);
            const amount = ethers.formatEther(onChain.montoApuesta);
            const white = colorCreador === 0 ? onChain.creador.toLowerCase() : oponente.toLowerCase();
            const black = colorCreador === 1 ? onChain.creador.toLowerCase() : oponente.toLowerCase();
            await createGame(roomId, white, black, 10, blockchainId, amount);
        }

        io.emit('challenge_accepted_global', {
            roomId,
            joiner: oponente.toLowerCase()
        });

        await broadcastLobbyUpdate();
    });

    contract.on("PartidaFinalizada", async (id, winner, resultado) => {
        const blockchainId = Number(id);
        const roomId = `room_${blockchainId}`;
        console.log(`📡 [EVENTO: PartidaFinalizada] ID:${blockchainId}, Winner:${winner}`);

        await lobbyManager.updateChallengeStatus(roomId, 'finished');
        await broadcastLobbyUpdate();
        
        // Enviar a frontend para que muestre pantalla de resultado
        io.to(roomId).emit('game_over', {
            winner,
            reason: resultado === 1 ? 'checkmate' : (resultado === 2 ? 'timeout' : 'draw')
        });
        activeGames.delete(roomId);
    });

    contract.on("PartidaCancelada", async (id) => {
        const blockchainId = Number(id);
        const roomId = `room_${blockchainId}`;
        console.log(`📡 [EVENTO: PartidaCancelada] ID:${blockchainId}`);
        await lobbyManager.updateChallengeStatus(roomId, 'cancelled');
        activeGames.delete(roomId);
        await broadcastLobbyUpdate();
    });
}

initContractListeners();

async function finalizarPartida(roomId, result, io) {
    await lobbyManager.updateChallengeStatus(roomId, 'finished');

    const game = activeGames.get(roomId);
    if (!game) return;

    try {
        await db.query(`
            INSERT INTO game_history (
                room_id, white_wallet, black_wallet,
                winner_wallet, bet_amount, pgn, blockchain_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [
            roomId, game.white, game.black,
            result.winner, game.betAmount,
            result.pgn, game.blockchainId
        ]);
    } catch (err) {
        console.error("Error guardando historial:", err);
    }

    const walletGanador = result.winner || game.white;
    const socketsEnSala = await io.in(roomId).fetchSockets();

    for (const s of socketsEnSala) {
        if (s.wallet === walletGanador) {
            s.emit('trigger_agent_ready', {
                blockchainId: game.blockchainId,
                pgn: result.pgn,
                actionType: 2,
                reason: result.reason || 'checkmate'
            });
            break;
        }
    }

    activeGames.delete(roomId);
    io.to(roomId).emit('game_over', result);
}

async function intentarActivarPartida(roomId) {
    const g = activeGames.get(roomId);
    if (!g) return;
    if (g.status !== 'waiting') return;
    if (!g.white || !g.black) return;

    g.status = 'active';
    g.lastMoveTimestamp = Date.now();
    console.log(`Partida ${roomId} activada`);

    const socketsEnSala = await io.in(roomId).fetchSockets();
    for (const s of socketsEnSala) {
        let color = 'viewer';
        if (s.wallet === g.white) color = 'w';
        else if (s.wallet === g.black) color = 'b';
        s.emit('player_color', color);
        s.emit('update_game', {
            pgn: g.chess.pgn(),
            timers: g.timers,
            turn: g.chess.turn()
        });
    }

    if (!g.interval) startTimer(roomId, io);
}

io.on('connection', (socket) => {

    socket.on('reauth', async (wallet) => {
        console.log(`[SOCKET_REAUTH] Recibido reauth de wallet: ${wallet}`);
        if (!wallet) return;
        socket.wallet = wallet.toLowerCase();
        await db.query(
            "INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING",
            [socket.wallet]
        );
        const res = await db.query("SELECT * FROM users WHERE wallet = $1", [socket.wallet]);
        socket.emit('auth_success', res.rows[0]);
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    socket.on('auth_web3', async ({ address, signature, message }) => {
        const recovered = ethers.verifyMessage(message, signature);

        if (recovered.toLowerCase() === address.toLowerCase()) {
            const wallet = address.toLowerCase();

            await db.query(
                "INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING",
                [wallet]
            );

            const res = await db.query("SELECT * FROM users WHERE wallet = $1", [wallet]);
            socket.wallet = wallet;
            socket.emit('auth_success', res.rows[0]);
            socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
        }
    });

    socket.on('get_challenges', async () => {
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    socket.on('create_challenge', async (data) => {
        // Ahora es opcional, ya que el event listener lo hará
        // Pero lo dejamos como 'fast path'
        console.log("[SOCKET_CREATE] Fast path creation requested");
        // El listener detectará el evento en segundos.
    });

    socket.on('accept_challenge', async (blockchainId) => {
        console.log("[SOCKET_ACCEPT] Fast path acceptance requested");
        // El listener detectará el evento en segundos.
    });

    socket.on('join_room', async ({ roomId }) => {
        console.log(`[SOCKET_JOIN] roomId: ${roomId}, wallet: ${socket.wallet}`);
        if (!socket.wallet) return;

        try {
            const blockchainId = Number(roomId.replace("room_", ""));
            const p = await contract.partidas(blockchainId);

            let white = null;
            let black = null;
            let colorCreador = Number(p.colorCreador);
            let creadorWallet = p.creador !== ethers.ZeroAddress ? p.creador.toLowerCase() : null;
            let oponenteWallet = p.oponente !== ethers.ZeroAddress ? p.oponente.toLowerCase() : null;

            if (!creadorWallet) {
                const res = await db.query("SELECT creator_wallet, color_creador FROM challenges WHERE room_id = $1", [roomId]);
                if (res.rows.length > 0) {
                    creadorWallet = res.rows[0].creator_wallet.toLowerCase();
                    colorCreador = Number(res.rows[0].color_creador);
                }
            }

            if (colorCreador === 0) {
                white = creadorWallet;
                black = oponenteWallet;
            } else {
                black = creadorWallet;
                white = oponenteWallet;
            }

            if (!activeGames.get(roomId)) {
                await createGame(
                    roomId,
                    white,
                    black,
                    10,
                    blockchainId,
                    ethers.formatEther(p.montoApuesta)
                );
            } else {
                const g = activeGames.get(roomId);
                if (white) g.white = white;
                if (black) g.black = black;
            }

            const g = activeGames.get(roomId);
            socket.join(roomId);

            let color = 'viewer';
            if (socket.wallet === g.white) color = 'w';
            else if (socket.wallet === g.black) color = 'b';

            socket.emit('player_color', color);
            socket.emit('update_game', {
                pgn: g.chess.pgn(),
                timers: g.timers,
                turn: g.chess.turn()
            });

            await intentarActivarPartida(roomId);

        } catch (e) {
            console.error("Error en join_room:", e);
        }
    });

    socket.on('move', async ({ roomId, moveData }) => {
        const result = await handleMove(roomId, moveData, socket.wallet);
        if (result.error) return socket.emit('error_msg', result.error);
        io.to(roomId).emit('update_game', result);
        if (result.status === 'finished') {
            await finalizarPartida(roomId, result, io);
        }
    });
});

server.listen(process.env.PORT || 10000, '0.0.0.0');