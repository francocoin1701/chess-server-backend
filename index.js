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

const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

const CONTRACT_ADDRESS = "0xa809761C3c878e982136b9f41519326193df1DF3";

const ABI = [
    "function partidas(uint256) view returns (address creador, address oponente, uint256 montoApuesta, uint8 estado, string pgnOficial, uint8 colorCreador, uint8 resultado)",
    "function getPartidaActiva(address) view returns (bool activa, uint256 id)",
    "function nextId() view returns (uint256)",
    "function triggerAgent(uint256, string, uint8) external"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function broadcastLobbyUpdate() {
    const list = await lobbyManager.getOpenChallenges();
    io.emit('list_challenges', list);
}

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

    // notificar a todos en la sala
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
        // Crear usuario si no existe (importante en servidor local con DB vacía)
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
        if (!socket.wallet) return;

        let colorCreador = 0;

        try {
            const onChain = await contract.partidas(data.blockchainId);

            if (onChain.creador.toLowerCase() !== socket.wallet)
                return socket.emit('error_msg', "Wallet no coincide con contrato");

            if (Number(onChain.estado) !== 0)
                return socket.emit('error_msg', "Partida no ABIERTA en cadena");

            colorCreador = Number(onChain.colorCreador);

        } catch (e) {
            return socket.emit('error_msg', "Error leyendo contrato");
        }

        try {
            const roomId = `room_${data.blockchainId}`;

            await lobbyManager.createChallenge(
                socket.wallet,
                data.amount,
                data.timeLimit,
                roomId,
                data.blockchainId,
                colorCreador
            );

            const whiteWallet = colorCreador === 0 ? socket.wallet : null;
            const blackWallet = colorCreador === 1 ? socket.wallet : null;

            await createGame(
                roomId,
                whiteWallet,
                blackWallet,
                data.timeLimit,
                data.blockchainId,
                data.amount
            );

            await broadcastLobbyUpdate();

            socket.emit('challenge_created', {
                roomId,
                blockchainId: data.blockchainId,
                colorCreador
            });

        } catch (e) {
            console.error(e);
            socket.emit('error_msg', "Error creando reto");
        }
    });

    socket.on('accept_challenge', async (blockchainId) => {
        console.log(`[SOCKET_ACCEPT] Solicitud recibida. wallet actual: ${socket.wallet}`);
        if (!socket.wallet) return;

        const roomId = `room_${blockchainId}`;
        console.log(`[ACCEPT_CHALLENGE] Inicio para blockchainId: ${blockchainId}. socket.wallet = ${socket.wallet}`);
        let g = activeGames.get(roomId);
        if (!g) {
            console.log(`[ACCEPT_CHALLENGE] g no existe, recreando juego temporal...`);
            await createGame(roomId, null, null, 10, blockchainId, 0);
            g = activeGames.get(roomId);
        }


        try {
            const onChain = await contract.partidas(blockchainId);

            // Bypass de caché estricto: si el nodo está atrasado, oponente será ZeroAddress.
            // Confiamos optimísticamente en el socket, el contrato rechazará fraudes de PGN más adelante.
            if (onChain.oponente !== ethers.ZeroAddress && onChain.oponente.toLowerCase() !== socket.wallet)
                return socket.emit('error_msg', "No has pagado en contrato / Ya tiene oponente");

            const colorCreador = Number(onChain.colorCreador);
            const colorOponente = colorCreador === 0 ? 1 : 0;

            if (colorOponente === 0) g.white = socket.wallet;
            else g.black = socket.wallet;

        } catch (e) {
            return socket.emit('error_msg', "Error leyendo contrato");
        }

        await lobbyManager.updateChallengeStatus(roomId, 'playing');

        // emitir globalmente para que el frontend del oponente haga join_room
        io.emit('challenge_accepted_global', {
            roomId,
            joiner: socket.wallet
        });

        await broadcastLobbyUpdate();
    });

    socket.on('join_room', async ({ roomId }) => {
        console.log(`[SOCKET_JOIN] roomId: ${roomId}, wallet: ${socket.wallet}`);
        if (!socket.wallet) {
            console.log(`[SOCKET_JOIN] RECHAZADO: socket.wallet es undefined o nulo`);
            return;
        }

        try {
            const blockchainId = Number(roomId.replace("room_", ""));
            const p = await contract.partidas(blockchainId);

            let white = null;
            let black = null;
            let colorCreador = Number(p.colorCreador);
            let creadorWallet = p.creador !== ethers.ZeroAddress ? p.creador.toLowerCase() : null;
            let oponenteWallet = p.oponente !== ethers.ZeroAddress ? p.oponente.toLowerCase() : null;

            console.log(`[JOIN_ROOM] blockchainId: ${blockchainId}`);
            console.log(`[JOIN_ROOM] p.creador = ${p.creador}, creadorWallet = ${creadorWallet}`);

            // Si el nodo de la blockchain devuelve ZeroAddress por caché, buscar en la DB local
            if (!creadorWallet) {
                console.log(`[JOIN_ROOM] Nodo cacheado devolvió ZeroAddress. Buscando en Postgres...`);
                const res = await db.query("SELECT creator_wallet, color_creador FROM challenges WHERE room_id = $1", [roomId]);
                if (res.rows.length > 0) {
                    creadorWallet = res.rows[0].creator_wallet.toLowerCase();
                    colorCreador = Number(res.rows[0].color_creador);
                    console.log(`[JOIN_ROOM] DB encontró. creadorWallet = ${creadorWallet}, colorCreador = ${colorCreador}`);
                } else {
                    console.log(`[JOIN_ROOM] DB FALLÓ DE ENCONTRAR LA PARTIDA!`);
                }
            }

            if (colorCreador === 0) {
                white = creadorWallet;
                black = oponenteWallet;
            } else {
                black = creadorWallet;
                white = oponenteWallet;
            }
            console.log(`[JOIN_ROOM] Status resultante pre-createGame: white=${white}, black=${black}`);

            // crear juego en memoria si no existe
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
                // si ya existe actualizar wallets desde cadena
                // por si el oponente acabo de aceptar
                const g = activeGames.get(roomId);
                if (white) g.white = white;
                if (black) g.black = black;
            }

            const g = activeGames.get(roomId);

            if (g) {
                console.log(`[JOIN_ROOM] Evaluando Asignación Optimista: g.white=${g.white}, g.black=${g.black}, entrante=${socket.wallet}`);
                if (g.white && !g.black && socket.wallet !== g.white) {
                    g.black = socket.wallet;
                    console.log(`[JOIN_ROOM] Fallback asertivo: Se asignó BLACK al entrante`);
                }
                if (g.black && !g.white && socket.wallet !== g.black) {
                    g.white = socket.wallet;
                    console.log(`[JOIN_ROOM] Fallback asertivo: Se asignó WHITE al entrante`);
                }
            }

            // unir socket a la sala
            socket.join(roomId);

            // asignar color a este socket
            let color = 'viewer';
            if (socket.wallet === g.white) color = 'w';
            else if (socket.wallet === g.black) color = 'b';

            socket.emit('player_color', color);

            // enviar estado actual del juego
            socket.emit('update_game', {
                pgn: g.chess.pgn(),
                timers: g.timers,
                turn: g.chess.turn()
            });

            // intentar activar la partida si ya estan los dos
            await intentarActivarPartida(roomId);

        } catch (e) {
            console.error("Error en join_room:", e);
            socket.emit('error_msg', "Error reconstruyendo partida");
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