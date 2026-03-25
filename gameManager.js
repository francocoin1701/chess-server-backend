const { Chess } = require('chess.js');
const db = require('./db');

const activeGames = new Map();
const GRACE_TIME = 10; 

// AHORA RECIBE initialMinutes DESDE EL LOBBY
const createGame = async (roomId, creatorWallet, initialMinutes) => {
    const mins = (initialMinutes && initialMinutes > 0) ? initialMinutes : 10;
    const timeInSeconds = mins * 60;

    const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [creatorWallet.toLowerCase()]);
    const lastColor = res.rows[0]?.last_color;
    const assignedColor = lastColor === 'w' ? 'b' : 'w';

    const gameData = {
        chess: new Chess(),
        white: assignedColor === 'w' ? creatorWallet.toLowerCase() : null,
        black: assignedColor === 'b' ? creatorWallet.toLowerCase() : null,
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
    const authorizedWallet = turn === 'w' ? g.white : g.black;
    
    // Comparación estricta en minúsculas
    if (wallet.toLowerCase() !== authorizedWallet.toLowerCase()) return { error: "No es tu turno" };

    try {
        if (g.chess.move(moveData)) {
            const now = Date.now();
            const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
            
            g.timers[turn] = Math.max(0, g.timers[turn] - elapsed);
            g.lastMoveTimestamp = now;
            g.moveCount++;

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