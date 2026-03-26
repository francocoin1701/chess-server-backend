const db = require('./db');

/**
 * Crea una nueva apuesta en la base de datos vinculada al ID de la Blockchain
 */
const createChallenge = async (wallet, amount, timeLimit, roomId, blockchainId) => {
    try {
        const res = await db.query(
            `INSERT INTO challenges (creator_wallet, bet_amount, time_limit, room_id, status, blockchain_id) 
             VALUES ($1, $2, $3, $4, 'open', $5) RETURNING *`,
            [wallet.toLowerCase(), amount.toString(), timeLimit, roomId, blockchainId]
        );
        return res.rows[0];
    } catch (e) {
        console.error("Error al crear desafío en DB:", e.message);
        return null;
    }
};

/**
 * Obtiene todas las apuestas abiertas.
 */
const getOpenChallenges = async () => {
    try {
        const res = await db.query(`
            SELECT 
                c.id, 
                c.blockchain_id, 
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
 * Actualiza el estado de una apuesta
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