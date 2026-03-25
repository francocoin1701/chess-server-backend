const { Chess } = require('chess.js');
const db = require('./db');

const activeGames = new Map();
const GRACE_TIME = 10; 

const createGame = async (roomId, creatorWallet, initialMinutes = 10) => {
    const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [creatorWallet]);
    const lastColor = res.rows[0]?.last_color;
    const assignedColor = lastColor === 'w' ? 'b' : 'w';

    const timeInSeconds = initialMinutes * 60;

    const gameData = {
        chess: new Chess(),
        white: assignedColor === 'w' ? creatorWallet : null,
        black: assignedColor === 'b' ? creatorWallet : null,
        timers: { w: timeInSeconds, b: timeInSeconds },
        baseTime: timeInSeconds, // Guardamos el tiempo original de la sala
        lastMoveTimestamp: Date.now(),
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
        if (g.chess.move(moveData)) {
            const now = Date.now();
            const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
            
            g.timers[turn] = Math.max(0, g.timers[turn] - elapsed);
            g.lastMoveTimestamp = now;
            g.moveCount++;

            // Lógica de 10s iniciales
            if (g.moveCount === 1) { 
                g.timers.w = g.baseTime; 
                g.timers.b = GRACE_TIME; 
            } else if (g.moveCount === 2) { 
                g.timers.b = g.baseTime; 
            }

            if (g.chess.isGameOver()) {
                g.status = 'finished';
                if (g.interval) clearInterval(g.interval);
                await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['w', g.white]);
                await db.query('UPDATE users SET last_color = $1 WHERE wallet = $2', ['b', g.black]);
            }
            return { success: true, pgn: g.chess.pgn(), timers: g.timers, status: g.status, lastMoveTimestamp: g.lastMoveTimestamp };
        }
    } catch (e) { return { error: "Ilegal" }; }
};

module.exports = { activeGames, createGame, handleMove, GRACE_TIME };