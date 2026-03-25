// gameManager.js
const { Chess } = require('chess.js');
const db = require('./db');

const activeGames = new Map();
const GAME_TIME = 600; // 10 minutos
const GRACE_TIME = 10; // 10 segundos iniciales

const createGame = async (roomId, creatorWallet) => {
    // Consultar último color para alternar
    const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [creatorWallet]);
    const lastColor = res.rows[0]?.last_color;
    const assignedColor = lastColor === 'w' ? 'b' : 'w';

    const gameData = {
        chess: new Chess(),
        white: assignedColor === 'w' ? creatorWallet : null,
        black: assignedColor === 'b' ? creatorWallet : null,
        timers: { w: GAME_TIME, b: GAME_TIME },
        lastMoveTimestamp: null,
        status: 'waiting',
        moveCount: 0,
        interval: null
    };
    activeGames.set(roomId, gameData);
    return gameData;
};

const handleMove = async (roomId, moveData, wallet) => {
    const g = activeGames.get(roomId);
    if (!g || g.status !== 'active') return { error: "Juego no activo" };

    const turn = g.chess.turn();
    const authorizedWallet = turn === 'w' ? g.white : g.black;

    if (wallet !== authorizedWallet) return { error: "No es tu turno" };

    try {
        const move = g.chess.move(moveData);
        if (move) {
            const now = Date.now();
            
            // Cálculo de tiempo consumido (La verdad del servidor)
            if (g.lastMoveTimestamp) {
                const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
                g.timers[turn] -= elapsed;
            }
            
            g.lastMoveTimestamp = now;
            g.moveCount++;

            // Lógica de gracia de 10 segundos
            if (g.moveCount === 1) {
                g.timers.w = GAME_TIME;
                g.timers.b = GRACE_TIME;
            } else if (g.moveCount === 2) {
                g.timers.b = GAME_TIME;
            }

            // Verificar fin de juego
            if (g.chess.isGameOver()) {
                g.status = 'finished';
                if (g.interval) clearInterval(g.interval);
                // Guardar historial de colores
                await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', g.white]);
                await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', g.black]);
            }

            return { success: true, pgn: g.chess.pgn(), timers: g.timers, status: g.status };
        }
    } catch (e) { return { error: "Movimiento ilegal" }; }
};

module.exports = { activeGames, createGame, handleMove, GRACE_TIME };