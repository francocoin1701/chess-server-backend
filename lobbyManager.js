// lobbyManager.js
const db = require('./db');

/**
 * Crea una nueva apuesta en la base de datos
 */
const createChallenge = async (wallet, amount, timeLimit, roomId) => {
    try {
        const res = await db.query(
            `INSERT INTO challenges (creator_wallet, bet_amount, time_limit, room_id, status) 
             VALUES ($1, $2, $3, $4, 'open') RETURNING *`,
            [wallet, amount, timeLimit, roomId]
        );
        return res.rows[0];
    } catch (e) {
        console.error("Error al crear desafío:", e.message);
        return null;
    }
};

/**
 * Obtiene todas las apuestas abiertas.
 * SENTIDO COMÚN: Usamos JOIN para traer el nickname y el ELO del creador 
 * desde la tabla 'users' sin tener que guardarlos dos veces.
 */
const getOpenChallenges = async () => {
    try {
        const res = await db.query(`
            SELECT 
                c.id, 
                c.creator_wallet, 
                c.bet_amount, 
                c.time_limit, 
                c.room_id, 
                u.nickname, 
                u.elo 
            FROM challenges c
            JOIN users u ON c.creator_wallet = u.wallet
            WHERE c.status = 'open'
            ORDER BY c.created_at DESC
        `);
        return res.rows;
    } catch (e) {
        console.error("Error al obtener desafíos:", e.message);
        return [];
    }
};

/**
 * Actualiza el estado de una apuesta (ej: de 'open' a 'playing')
 */
const updateChallengeStatus = async (roomId, newStatus) => {
    try {
        await db.query(
            "UPDATE challenges SET status = $1 WHERE room_id = $2",
            [newStatus, roomId]
        );
        return true;
    } catch (e) {
        console.error("Error al actualizar estado:", e.message);
        return false;
    }
};

module.exports = {
    createChallenge,
    getOpenChallenges,
    updateChallengeStatus
};