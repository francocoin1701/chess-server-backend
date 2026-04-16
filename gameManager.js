const { Chess } = require('chess.js');

const activeGames = new Map();
const GRACE_TIME = 10;

const createGame = async (roomId, whiteWallet, blackWallet, initialMinutes, blockchainId, betAmount = "0") => {
    const mins = (initialMinutes && initialMinutes > 0) ? initialMinutes : 10;
    const timeInSeconds = mins * 60;

    const gameData = {
        roomId,
        chess: new Chess(),
        white: whiteWallet ? whiteWallet.toLowerCase() : null,
        black: blackWallet ? blackWallet.toLowerCase() : null,
        timers: { w: timeInSeconds, b: timeInSeconds },
        baseTime: timeInSeconds,
        lastMoveTimestamp: Date.now(),
        status: 'waiting',
        moveCount: 0,
        blockchainId,
        betAmount,
        interval: null
    };

    activeGames.set(roomId, gameData);
    return gameData;
};

const handleMove = async (roomId, moveData, wallet) => {
    const g = activeGames.get(roomId);
    if (!g || g.status !== 'active') return { error: "Juego no activo" };

    const turn = g.chess.turn();
    const authorized = turn === 'w' ? g.white : g.black;

    if (!authorized) return { error: "Esperando oponente" };
    if (wallet.toLowerCase() !== authorized.toLowerCase()) return { error: "No es tu turno" };

    try {
        const moved = g.chess.move(moveData);
        if (!moved) return { error: "Movimiento ilegal" };

        const now = Date.now();
        const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);

        // descontar tiempo al que acaba de mover
        if (g.moveCount === 0) {
            g.timers.w = g.baseTime;
            g.timers.b = GRACE_TIME;
        } else if (g.moveCount === 1) {
            g.timers.w -= elapsed;
            g.timers.b = g.baseTime;
        } else {
            g.timers[turn] -= elapsed;
        }

        g.timers[turn] = Math.max(0, g.timers[turn]);
        g.lastMoveTimestamp = now;
        g.moveCount++;

        // verificar timeout despues de descontar
        if (g.timers[turn] <= 0) {
            g.status = 'finished';
            const winner = turn === 'w' ? g.black : g.white;
            return {
                status: 'finished',
                pgn: g.chess.pgn(),
                timers: g.timers,
                winner,
                resultado: 2, // TIMEOUT
                reason: 'timeout'
            };
        }

        // verificar fin de juego por chess engine
        if (g.chess.isGameOver()) {
            g.status = 'finished';
            let winner = null;
            let resultado = 3; // EMPATE por defecto

            if (g.chess.isCheckmate()) {
                resultado = 1; // MATE
                winner = turn === 'w' ? g.white : g.black;
            }

            return {
                status: 'finished',
                pgn: g.chess.pgn(),
                timers: g.timers,
                winner,
                resultado,
                reason: g.chess.isCheckmate() ? 'checkmate' : 'draw'
            };
        }

        return {
            success: true,
            pgn: g.chess.pgn(),
            timers: g.timers,
            status: g.status,
            turn: g.chess.turn(),
            lastMoveTimestamp: now
        };

    } catch (e) {
        return { error: "Movimiento ilegal" };
    }
};

const startTimer = (roomId, io) => {
    const g = activeGames.get(roomId);
    if (!g || g.interval) return;

    g.interval = setInterval(async () => {
        const game = activeGames.get(roomId);
        if (!game || game.status !== 'active') {
            clearInterval(g.interval);
            return;
        }

        const now = Date.now();
        const elapsed = Math.floor((now - game.lastMoveTimestamp) / 1000);
        const turn = game.chess.turn();
        const timeLeft = Math.max(0, game.timers[turn] - elapsed);

        // emitir timers actualizados a la sala — servidor es fuente de verdad
        const currentTimers = {
            w: turn === 'w' ? timeLeft : game.timers.w,
            b: turn === 'b' ? timeLeft : game.timers.b
        };

        io.to(roomId).emit('timer_update', { timers: currentTimers });

        // timeout detectado
        if (timeLeft <= 0) {
            clearInterval(game.interval);
            game.interval = null;
            game.status = 'finished';

            const winner = turn === 'w' ? game.black : game.white;
            const loser = turn === 'w' ? game.white : game.black;

            const pgnConTimeout = game.chess.pgn() +
                ` { timeout: ${winner} wins }`;

            const result = {
                status: 'finished',
                pgn: pgnConTimeout,
                timers: currentTimers,
                winner,
                loser,
                resultado: 2, // TIMEOUT
                reason: 'timeout'
            };

            io.to(roomId).emit('game_over', result);

            // solo al ganador
            const socketsEnSala = await io.in(roomId).fetchSockets();
            for (const s of socketsEnSala) {
                if (s.wallet === winner) {
                    s.emit('trigger_agent_ready', {
                        blockchainId: game.blockchainId,
                        pgn: pgnConTimeout,
                        actionType: 2,
                        reason: 'timeout',
                        winner,
                        loser
                    });
                    break;
                }
            }

            activeGames.delete(roomId);
        }

    }, 1000);
};

module.exports = { activeGames, createGame, handleMove, startTimer, GRACE_TIME };