const { Chess } = require('chess.js');
const db = require('./db');

const activeGames = new Map();

const createGame = async (roomId, creatorWallet, initialMinutes) => {
    // 1. Normalizar wallet
    const wallet = creatorWallet.toLowerCase();
    
    // 2. Traer historial del creador
    const res = await db.query('SELECT last_color FROM users WHERE wallet = $1', [wallet]);
    const lastColor = res.rows[0]?.last_color;
    
    // 3. Lógica de alternancia: Si jugó con Blancas, ahora le tocan Negras ('b')
    const creatorColor = (lastColor === 'w') ? 'b' : 'w';

    // 4. Configurar tiempos (10 min por defecto si falla el dato)
    const mins = (initialMinutes && initialMinutes > 0) ? initialMinutes : 10;
    const seconds = mins * 60;

    const gameData = {
        chess: new Chess(),
        // Asignación inmediata del creador
        white: creatorColor === 'w' ? wallet : null,
        black: creatorColor === 'b' ? wallet : null,
        timers: { w: seconds, b: seconds },
        baseTime: seconds,
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

    // Comparación blindada en minúsculas
    if (wallet.toLowerCase() !== authorized.toLowerCase()) return { error: "No es tu turno" };

    try {
        if (g.chess.move(moveData)) {
            const now = Date.now();
            const elapsed = Math.floor((now - g.lastMoveTimestamp) / 1000);
            g.timers[turn] = Math.max(0, g.timers[turn] - elapsed);
            g.lastMoveTimestamp = now;
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

module.exports = { activeGames, createGame, handleMove };