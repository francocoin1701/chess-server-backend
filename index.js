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

lobbyManager.init(contract, ethers);

const partidasFinalizadasPorServidor = new Set();

async function broadcastLobbyUpdate() {
    console.log("[BROADCAST] Enviando actualización de lobby a todos los clientes...");
    const list = await lobbyManager.getOpenChallenges();
    io.emit('list_challenges', list);
}

// ---------------------------------------------------------
// PENDING PAYMENT — verificar si hay pagos pendientes para una wallet
// Retorna el registro de game_history con payment_status = 'pending'
// ---------------------------------------------------------
async function getPendingPayment(wallet) {
    try {
        const res = await db.query(`
            SELECT * FROM game_history 
            WHERE (white_wallet = $1 OR black_wallet = $1)
            AND payment_status = 'pending'
            ORDER BY played_at DESC
            LIMIT 1
        `, [wallet.toLowerCase()]);
        return res.rows[0] || null;
    } catch (e) {
        console.error("[PENDING] Error consultando pago pendiente:", e.message);
        return null;
    }
}

// ---------------------------------------------------------
// SINCRONIZACIÓN PERIÓDICA CON BLOCKCHAIN
// ---------------------------------------------------------
async function syncWithBlockchain() {
    console.log("[SYNC] Iniciando sincronización con blockchain...");
    try {
        const nextId = Number(await contract.nextId());
        console.log(`[SYNC] Total de partidas en contrato: ${nextId}`);

        for (let i = 0; i < nextId; i++) {
            try {
                const onChain = await contract.partidas(i);
                const estadoOnChain = Number(onChain.estado);
                const roomId = `room_${i}`;

                const dbRes = await db.query(
                    "SELECT * FROM challenges WHERE blockchain_id = $1", [i]
                );

                if (dbRes.rows.length === 0) {
                    if (estadoOnChain === 0 && onChain.creador !== ethers.ZeroAddress) {
                        console.log(`[SYNC] Partida ${i} abierta on-chain pero no en DB, insertando...`);
                        const amount = ethers.formatEther(onChain.montoApuesta);
                        const colorCreador = Number(onChain.colorCreador);
                        await lobbyManager.createChallenge(onChain.creador, amount, 10, roomId, i, colorCreador);
                    }
                    continue;
                }

                const rowDB = dbRes.rows[0];
                const statusDB = rowDB.status;
                const mapaEstados = { 0: 'open', 1: 'playing', 2: 'finished', 3: 'cancelled' };
                const statusEsperado = mapaEstados[estadoOnChain];

                if (statusDB !== statusEsperado) {
                    console.log(`[SYNC] Partida ${i}: DB='${statusDB}' contrato='${statusEsperado}', corrigiendo...`);
                    await lobbyManager.updateChallengeStatus(roomId, statusEsperado);

                    if ((estadoOnChain === 2 || estadoOnChain === 3) && activeGames.has(roomId)) {
                        console.log(`[SYNC] Eliminando juego fantasma de memoria: ${roomId}`);
                        const g = activeGames.get(roomId);
                        if (g && g.interval) clearInterval(g.interval);
                        activeGames.delete(roomId);
                    }
                }

                if (onChain.creador === ethers.ZeroAddress && statusDB === 'open') {
                    console.log(`[SYNC] Partida ${i} tiene ZeroAddress on-chain, eliminando de DB...`);
                    await lobbyManager.updateChallengeStatus(roomId, 'cancelled');
                }

            } catch (err) {
                console.error(`[SYNC] Error procesando partida ${i}:`, err.message);
            }
        }

        console.log("[SYNC] Sincronización completada.");
    } catch (e) {
        console.error("[SYNC] Error general en syncWithBlockchain:", e.message);
    }
}

// ---------------------------------------------------------
// RECEPTOR DE EVENTOS DE BLOCKCHAIN
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
            await lobbyManager.createChallenge(creador, amount, 10, roomId, blockchainId, colorCreador);

            const whiteWallet = colorCreador === 0 ? creador.toLowerCase() : null;
            const blackWallet = colorCreador === 1 ? creador.toLowerCase() : null;

            if (!activeGames.get(roomId)) {
                await createGame(roomId, whiteWallet, blackWallet, 10, blockchainId, amount);
            }

            io.emit('challenge_created', { roomId, blockchainId, colorCreador, creator_wallet: creador });
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
            const onChain = await contract.partidas(blockchainId);
            const colorCreador = Number(onChain.colorCreador);
            const amount = ethers.formatEther(onChain.montoApuesta);
            const white = colorCreador === 0 ? onChain.creador.toLowerCase() : oponente.toLowerCase();
            const black = colorCreador === 1 ? onChain.creador.toLowerCase() : oponente.toLowerCase();
            await createGame(roomId, white, black, 10, blockchainId, amount);
        }

        io.emit('challenge_accepted_global', { roomId, joiner: oponente.toLowerCase() });
        await broadcastLobbyUpdate();
    });

    contract.on("PartidaFinalizada", async (id, winner, resultado) => {
        const blockchainId = Number(id);
        const roomId = `room_${blockchainId}`;
        console.log(`📡 [EVENTO: PartidaFinalizada] ID:${blockchainId}, Winner:${winner}`);

        await lobbyManager.updateChallengeStatus(roomId, 'finished');

        // Marcar como pagado en game_history — el oráculo resolvió exitosamente
        try {
            await db.query(`
                UPDATE game_history 
                SET payment_status = 'paid' 
                WHERE blockchain_id = $1
            `, [blockchainId]);
            console.log(`[PAGO] Partida ${blockchainId} marcada como pagada`);
        } catch (e) {
            console.error("[PAGO] Error marcando partida como pagada:", e.message);
        }

        await broadcastLobbyUpdate();

        if (partidasFinalizadasPorServidor.has(roomId)) {
            console.log(`[EVENTO: PartidaFinalizada] game_over ya emitido para ${roomId}, omitiendo duplicado`);
            partidasFinalizadasPorServidor.delete(roomId);
        } else {
            io.to(roomId).emit('game_over', {
                winner,
                reason: Number(resultado) === 1 ? 'checkmate' : (Number(resultado) === 2 ? 'timeout' : 'draw')
            });
        }

        const g = activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        activeGames.delete(roomId);
    });

    contract.on("PartidaCancelada", async (id) => {
        const blockchainId = Number(id);
        const roomId = `room_${blockchainId}`;
        console.log(`📡 [EVENTO: PartidaCancelada] ID:${blockchainId}`);
        await lobbyManager.updateChallengeStatus(roomId, 'cancelled');

        const g = activeGames.get(roomId);
        if (g && g.interval) clearInterval(g.interval);
        activeGames.delete(roomId);

        await broadcastLobbyUpdate();
    });
}

initContractListeners();

syncWithBlockchain().then(() => {
    console.log("[SYNC] Sync inicial completada.");
});
setInterval(syncWithBlockchain, 5 * 60 * 1000);

async function finalizarPartida(roomId, result, io) {
    await lobbyManager.updateChallengeStatus(roomId, 'finished');

    const game = activeGames.get(roomId);
    if (!game) return;

    // Determinar actionType según razón
    // 1 = checkmate, 2 = timeout, 3 = draw
    const actionType = result.reason === 'checkmate' ? 1 : result.reason === 'timeout' ? 2 : 3;

    try {
        // Guardar con payment_status='pending' y action_type
        // Si el pago falla, el frontend puede reintentarlo desde el lobby
        await db.query(`
            INSERT INTO game_history (
                room_id, white_wallet, black_wallet,
                winner_wallet, bet_amount, pgn, blockchain_id,
                payment_status, action_type
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT DO NOTHING
        `, [
            roomId, game.white, game.black,
            result.winner, game.betAmount,
            result.pgn, game.blockchainId,
            'pending', actionType
        ]);
        console.log(`[HISTORIAL] Partida ${roomId} guardada con payment_status=pending`);
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
                actionType,
                reason: result.reason || 'checkmate'
            });
            break;
        }
    }

    partidasFinalizadasPorServidor.add(roomId);

    if (game.interval) clearInterval(game.interval);
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

        // Verificar si tiene pago pendiente y notificar al frontend
        const pending = await getPendingPayment(socket.wallet);
        if (pending) {
            console.log(`[PENDING] Wallet ${socket.wallet} tiene pago pendiente:`, pending.blockchain_id);
            socket.emit('pending_payment', {
                blockchainId: pending.blockchain_id,
                pgn: pending.pgn,
                actionType: pending.action_type,
                winnerWallet: pending.winner_wallet,
                whiteWallet: pending.white_wallet,
                blackWallet: pending.black_wallet,
                betAmount: pending.bet_amount
            });
        }
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

            // Verificar si tiene pago pendiente
            const pending = await getPendingPayment(wallet);
            if (pending) {
                console.log(`[PENDING] Wallet ${wallet} tiene pago pendiente:`, pending.blockchain_id);
                socket.emit('pending_payment', {
                    blockchainId: pending.blockchain_id,
                    pgn: pending.pgn,
                    actionType: pending.action_type,
                    winnerWallet: pending.winner_wallet,
                    whiteWallet: pending.white_wallet,
                    blackWallet: pending.black_wallet,
                    betAmount: pending.bet_amount
                });
            }
        }
    });

    socket.on('get_challenges', async () => {
        socket.emit('list_challenges', await lobbyManager.getOpenChallenges());
    });

    // El frontend avisa que el pago fue enviado exitosamente
    // El servidor lo marca como paid en DB sin esperar el evento on-chain
    socket.on('payment_sent', async ({ blockchainId }) => {
        console.log(`[PENDING] Wallet ${socket.wallet} reporta pago enviado para partida ${blockchainId}`);
        try {
            await db.query(`
                UPDATE game_history 
                SET payment_status = 'paid'
                WHERE blockchain_id = $1
            `, [blockchainId]);
            socket.emit('payment_confirmed', { blockchainId });
        } catch (e) {
            console.error("[PENDING] Error marcando pago:", e.message);
        }
    });
    socket.on('check_pending_payment', async ({ blockchainId }) => {
        try {
            const onChain = await contract.partidas(blockchainId);
            const estado = Number(onChain.estado);
            if (estado === 2) {
                // Confirmado on-chain → actualizar DB y notificar
                await db.query(
                    "UPDATE game_history SET payment_status = 'paid' WHERE blockchain_id = $1",
                    [blockchainId]
                );
                socket.emit('payment_confirmed', { blockchainId });
            }
            // Si no es 2, no hacer nada — banner permanece
        } catch (e) {
            console.error("[CHECK_PENDING]", e.message);
        }
    });

    socket.on('create_challenge', async (data) => {
        console.log("[SOCKET_CREATE] Creación rápida solicitada desde Frontend:", data.blockchainId);
        const roomId = `room_${data.blockchainId}`;
        try {
            await lobbyManager.createChallenge(
                data.creador || socket.wallet,
                data.amount,
                data.timeLimit || 10,
                roomId,
                data.blockchainId,
                data.colorCreador
            );
            await broadcastLobbyUpdate();
        } catch (e) {
            console.error("Error guardando reto en DB:", e);
        }
    });

    socket.on('accept_challenge', async (blockchainId) => {
        console.log("[SOCKET_ACCEPT] Aceptación rápida solicitada desde Frontend:", blockchainId);
        const roomId = `room_${blockchainId}`;
        await lobbyManager.updateChallengeStatus(roomId, 'playing');
        await broadcastLobbyUpdate();
    });

    socket.on('join_room', async ({ roomId }) => {
        console.log(`[SOCKET_JOIN] roomId: ${roomId}, wallet: ${socket.wallet}`);
        if (!socket.wallet) return;

        try {
            const blockchainId = Number(roomId.replace("room_", ""));

            // NUEVO: Verificar si esta partida tiene pago pendiente en DB
            // Si lo tiene, no mandar al tablero sino emitir pending_payment
            const pendingRes = await db.query(`
                SELECT * FROM game_history 
                WHERE blockchain_id = $1 AND payment_status = 'pending'
                LIMIT 1
            `, [blockchainId]);

            if (pendingRes.rows.length > 0) {
                const pending = pendingRes.rows[0];
                const esJugador =
                    socket.wallet === pending.white_wallet.toLowerCase() ||
                    socket.wallet === pending.black_wallet.toLowerCase();

                if (esJugador) {
                    console.log(`[PENDING] join_room bloqueado por pago pendiente en partida ${blockchainId}`);
                    socket.emit('pending_payment', {
                        blockchainId: pending.blockchain_id,
                        pgn: pending.pgn,
                        actionType: pending.action_type,
                        winnerWallet: pending.winner_wallet,
                        whiteWallet: pending.white_wallet,
                        blackWallet: pending.black_wallet,
                        betAmount: pending.bet_amount
                    });
                    return;
                }
            }

            let onChainPartida;
            try {
                onChainPartida = await contract.partidas(blockchainId);
            } catch (err) {
                console.error(`[JOIN_ROOM] Error consultando contrato para ${roomId}:`, err.message);
                return socket.emit('error_msg', 'Error verificando partida en blockchain');
            }

            if (!onChainPartida.creador || onChainPartida.creador === ethers.ZeroAddress) {
                console.warn(`[JOIN_ROOM] ${roomId} no existe on-chain, bloqueando entrada`);
                await lobbyManager.updateChallengeStatus(roomId, 'cancelled');
                return socket.emit('error_msg', 'Esta partida no existe en blockchain');
            }

            const estadoOnChain = Number(onChainPartida.estado);

            if (estadoOnChain === 2 || estadoOnChain === 3) {
                console.warn(`[JOIN_ROOM] ${roomId} ya no está activa on-chain (estado: ${estadoOnChain})`);
                const nuevoEstado = estadoOnChain === 3 ? 'cancelled' : 'finished';
                await lobbyManager.updateChallengeStatus(roomId, nuevoEstado);

                if (activeGames.has(roomId)) {
                    const g = activeGames.get(roomId);
                    if (g && g.interval) clearInterval(g.interval);
                    activeGames.delete(roomId);
                }

                return socket.emit('error_msg', 'Esta partida ya finalizó o fue cancelada');
            }

            const p = onChainPartida;
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
                await createGame(roomId, white, black, 10, blockchainId, ethers.formatEther(p.montoApuesta));
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

    socket.on('leave_room', ({ roomId }) => {
        if (!roomId) return;
        socket.leave(roomId);
        console.log(`[SOCKET_LEAVE] wallet: ${socket.wallet} salió de ${roomId}`);
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