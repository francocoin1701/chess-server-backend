require('dotenv').config();
const { ethers } = require('ethers');
const Groq = require('groq-sdk');

const WS_RPCS = [
    process.env.RPC_WS_URL,
    "wss://ethereum-sepolia-rpc.publicnode.com",
    "wss://sepolia.drpc.org",
    "wss://eth-sepolia.g.alchemy.com/v2/MdGxUleaoe-dJfp4Qutqo"
].filter(Boolean);

let wsIndex = 0;
let provider = null;
let signer = null;
let contract = null;
let wsReconectando = false;

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x50EbFdC22D4D4719Fb09228a6f1e6F7D1a481Bd5";

const ABI = [
    "event ActionRequested(uint256 indexed id, string pgn, uint8 actionType)",
    "function partidas(uint256) view returns (address creador, address oponente, uint256 montoApuesta, uint8 estado, string pgnOficial, uint8 colorCreador, uint8 resultado)",
    "function submitReport(bytes) external"
];

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const RESULT = { MATE: 1, TIMEOUT: 2, EMPATE: 3 };
const procesadas = new Set();

function crearConexion() {
    const url = WS_RPCS[wsIndex % WS_RPCS.length];
    console.log(`Conectando via WebSocket: ${url}`);

    provider = new ethers.WebSocketProvider(url);
    signer = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    // cuando el websocket se cierra reconectar automaticamente
    provider.websocket.on('close', () => {
        if (wsReconectando) return;
        wsReconectando = true;
        console.log("WebSocket cerrado — reconectando en 5s...");
        setTimeout(() => {
            wsIndex++;
            wsReconectando = false;
            crearConexion();
        }, 5000);
    });

    provider.websocket.on('error', (err) => {
        console.error("WebSocket error:", err.message);
    });

    // escuchar el evento directamente — sin polling
    contract.on('ActionRequested', async (id, pgn, actionType, event) => {
        console.log(`\nEvento detectado en bloque ${event.log.blockNumber}`);
        console.log(`ID: ${id} | ActionType: ${actionType}`);
        await procesarPartida(Number(id), pgn);
    });

    console.log("WebSocket conectado — escuchando ActionRequested...");
}

async function analizarPGN(pgn) {
    const timeoutMatch = pgn.match(/timeout:\s*(0x[a-fA-F0-9]{40})\s*wins/i);
    if (timeoutMatch) {
        console.log("Timeout detectado en PGN");
        return { winnerAddr: timeoutMatch[1], tipo: RESULT.TIMEOUT };
    }

    console.log("Enviando a Groq...");
    const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{
            role: "user",
            content: `Analyze this chess PGN and respond ONLY with valid JSON, nothing else:
{"winner":"White"|"Black"|"Draw"}

PGN:
${pgn}`
        }],
        temperature: 0,
        max_tokens: 50
    });

    const text = response.choices[0].message.content.trim();
    console.log("Respuesta IA:", text);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Respuesta IA invalida: " + text);
    const json = JSON.parse(match[0]);
    return { winner: json.winner, tipo: json.winner === 'Draw' ? RESULT.EMPATE : RESULT.MATE };
}

async function procesarPartida(id, pgn) {
    const key = `${id}-${pgn.slice(0, 20)}`;
    if (procesadas.has(key)) {
        console.log(`Partida #${id} ya procesada — saltando`);
        return;
    }
    procesadas.add(key);

    console.log(`\n=============================`);
    console.log(`Procesando partida #${id}`);

    try {
        const partida = await contract.partidas(id);

        if (Number(partida.estado) !== 1) {
            console.log(`Partida #${id} no esta INICIADA — ignorando`);
            procesadas.delete(key);
            return;
        }

        // paso 1: guardar PGN si no existe
        if (!partida.pgnOficial || partida.pgnOficial.length === 0) {
            console.log("Guardando PGN en cadena...");
            const encPgn = ethers.AbiCoder.defaultAbiCoder().encode(
                ['uint256', 'string'], [BigInt(id), pgn]
            );
            const reportPgn = ethers.concat([
                new Uint8Array([0x04]),
                ethers.getBytes(encPgn)
            ]);
            const tx1 = await contract.submitReport(reportPgn);
            await tx1.wait();
            console.log(`PGN guardado. Tx: ${tx1.hash}`);
        } else {
            console.log("PGN ya guardado en cadena");
        }

        // paso 2: analizar con IA
        const { winner, winnerAddr: winnerDirecto, tipo } = await analizarPGN(pgn);

        // paso 3: determinar ganador
        let winnerAddr = ethers.ZeroAddress;
        if (tipo === RESULT.TIMEOUT && winnerDirecto) {
            winnerAddr = winnerDirecto;
        } else if (winner === 'White') {
            winnerAddr = Number(partida.colorCreador) === 0
                ? partida.creador
                : partida.oponente;
        } else if (winner === 'Black') {
            winnerAddr = Number(partida.colorCreador) === 0
                ? partida.oponente
                : partida.creador;
        }

        console.log(`Ganador: ${winnerAddr} | Tipo: ${tipo}`);

        // paso 4: liquidar
        const encPay = ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256', 'address', 'uint8'], [BigInt(id), winnerAddr, tipo]
        );
        const reportPay = ethers.concat([
            new Uint8Array([0x02]),
            ethers.getBytes(encPay)
        ]);
        console.log("Liquidando...");
        const tx2 = await contract.submitReport(reportPay);
        await tx2.wait();
        console.log(`Partida #${id} liquidada. Tx: ${tx2.hash}`);

    } catch (err) {
        console.error(`Error en partida #${id}:`, err.message);
        procesadas.delete(key);
    }
}

async function iniciar() {
    console.log("=============================");
    console.log("Oracle iniciado — modo WebSocket");
    console.log(`Contrato: ${CONTRACT_ADDRESS}`);
    console.log(`Oracle wallet: ${new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY).address}`);
    console.log(`WSS disponibles: ${WS_RPCS.length}`);
    console.log("=============================");

    crearConexion();

    // keepalive — ping cada 30s para mantener la conexion viva
    setInterval(() => {
        if (provider && provider.websocket.readyState === 1) {
            provider.getBlockNumber()
                .then(b => console.log(`Keepalive — bloque: ${b}`))
                .catch(() => {});
        }
    }, 30000);
}

iniciar();