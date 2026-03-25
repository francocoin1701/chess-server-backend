const { Chess } = require('chess.js');
const db = require('./db');

const activeGames = new Map();
const GRACE_TIME = 10; // 10 segundos de gracia inicial

const createGame = async (roomId, creatorWallet, initialMinutes) => {
    const wallet = creatorWallet.toLowerCase();
    const mins = (initialMinutes && initialMinutes > 0) ? initialMinutes : 10;
    const timeInSeconds = mins * 60;

    const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [wallet]);
    const lastColor = res.rows[0]?.last_color;
    const assignedColor = lastColor === 'w' ? 'b' : 'w';

    const gameData = {
        chess: new Chess(),
        white: assignedColor === 'w' ? wallet : null,
        black: assignedColor === 'b' ? wallet : null,
        timers: { w: timeInSeconds, b: timeInSeconds },
        baseTime: timeInSeconds, 
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
    const authorized = turn === 'w' ? g.white : g.black;

    if (wallet.toLowerCase() !== authorized.toLowerCase()) return { error: "No es tu turno" };

    try {
        if (g.chess.move(moveData)) {
            const now = Date.now();
            const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
            
            g.timers[turn] = Math.max(0, g.timers[turn] - elapsed);
            g.lastMoveTimestamp = now;

            // LÓGICA DE PRESENCIA (10 SEGUNDOS)
            if (g.moveCount === 0) { 
                // Blanco movió: recupera su tiempo base y le damos 10s al Negro
                g.timers.w = g.baseTime; 
                g.timers.b = GRACE_TIME; 
            } else if (g.moveCount === 1) { 
                // Negro movió: recupera su tiempo base
                g.timers.b = g.baseTime; 
            }
            
            g.moveCount++;

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