const db = require('./db');

const createChallenge = async (wallet, amount, timeLimit, roomId, blockchainId, colorCreador) => {
    try {
        const res = await db.query(
            `INSERT INTO challenges (creator_wallet, bet_amount, time_limit, room_id, status, blockchain_id, color_creador) 
             VALUES ($1, $2, $3, $4, 'open', $5, $6) RETURNING *`,
            [wallet.toLowerCase(), amount.toString(), timeLimit, roomId, blockchainId, colorCreador]
        );
        return res.rows[0];
    } catch (e) {
        console.error("Error al crear desafío en DB:", e.message);
        return null;
    }
};

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
                c.color_creador,
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