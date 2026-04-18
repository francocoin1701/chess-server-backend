const db = require('./db');

// Se inyecta desde server.js para evitar dependencia circular
let contract = null;
let ethers = null;

const init = (contractInstance, ethersInstance) => {
    contract = contractInstance;
    ethers = ethersInstance;
};

const createChallenge = async (wallet, amount, timeLimit, roomId, blockchainId, colorCreador) => {
    try {
        const res = await db.query(
            `INSERT INTO challenges (creator_wallet, bet_amount, time_limit, room_id, status, blockchain_id, color_creador) 
             VALUES ($1, $2, $3, $4, 'open', $5, $6) 
             ON CONFLICT (blockchain_id) 
             DO UPDATE SET 
                status = 'open',
                time_limit = COALESCE(NULLIF(EXCLUDED.time_limit, 10), challenges.time_limit)
             RETURNING *`,[wallet.toLowerCase(), amount.toString(), timeLimit, roomId, blockchainId, colorCreador]
        );
        return res.rows[0];
    } catch (e) {
        console.error("Error al crear desafío en DB:", e.message);
        return null;
    }
};

// CAPA 2: Filtra contra contrato antes de entregar al frontend
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

        // Si no tenemos contrato inyectado, devolver sin filtrar
        if (!contract || !ethers) {
            console.warn("[LOBBY] Contrato no inyectado, devolviendo sin filtrar on-chain");
            return res.rows;
        }

        const verificados =[];

        for (const row of res.rows) {
            try {
                const onChain = await contract.partidas(row.blockchain_id);
                const estado = Number(onChain.estado);
                const creador = onChain.creador;

                // Si el creador es ZeroAddress la partida no existe on-chain — basura
                if (!creador || creador === ethers.ZeroAddress) {
                    console.log(`[LOBBY_FILTER] blockchain_id ${row.blockchain_id} no existe on-chain, limpiando DB`);
                    await updateChallengeStatus(row.room_id, 'cancelled');
                    continue;
                }

                // APLICANDO LA CORRECCIÓN DE ESTADOS:
                if (estado === 0) {
                    // Sigue abierta on-chain → es real, la mostramos en el lobby
                    verificados.push(row);
                } else if (estado === 1) {
                    // En juego → no la mostramos en el lobby.
                    // Si está en este bucle es porque la DB aún creía que estaba 'open'.
                    // Aprovechamos y corregimos la DB para que no la vuelva a buscar.
                    console.log(`[LOBBY_FILTER] blockchain_id ${row.blockchain_id} ya está en juego on-chain, actualizando DB a 'playing'`);
                    await updateChallengeStatus(row.room_id, 'playing');
                } else if (estado === 2) {
                    // Finalizada
                    console.log(`[LOBBY_FILTER] blockchain_id ${row.blockchain_id} finalizada on-chain, actualizando DB a 'finished'`);
                    await updateChallengeStatus(row.room_id, 'finished');
                } else if (estado === 3) {
                    // Cancelada
                    console.log(`[LOBBY_FILTER] blockchain_id ${row.blockchain_id} cancelada on-chain, actualizando DB a 'cancelled'`);
                    await updateChallengeStatus(row.room_id, 'cancelled');
                }
            } catch (err) {
                console.error(`[LOBBY_FILTER] Error verificando blockchain_id ${row.blockchain_id}:`, err.message);
                // En caso de error de red RPC, incluir el registro para no vaciar el lobby por un fallo de conexión
                verificados.push(row);
            }
        }

        return verificados;
    } catch (e) {
        console.error("Error al obtener desafíos:", e.message);
        return[];
    }
};

const updateChallengeStatus = async (roomId, newStatus) => {
    try {
        await db.query(
            "UPDATE challenges SET status = $1 WHERE room_id = $2",[newStatus, roomId]
        );
        return true;
    } catch (e) {
        console.error("Error al actualizar estado:", e.message);
        return false;
    }
};

module.exports = {
    init,
    createChallenge,
    getOpenChallenges,
    updateChallengeStatus
};