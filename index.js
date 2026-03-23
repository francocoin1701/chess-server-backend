const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Permite que cualquier frontend se conecte
        methods: ["GET", "POST"]
    }
});

let game = new Chess();

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    // Enviar estado actual al conectar
    socket.emit('init_game', game.pgn());

    socket.on('move', (moveData) => {
        try {
            const result = game.move(moveData);
            if (result) {
                // Emitir a todos los demás el movimiento y el PGN actualizado
                io.emit('update_game', {
                    pgn: game.pgn(),
                    move: result
                });
                console.log(`Movimiento legal: ${result.san}`);
                
                if (game.isGameOver()) {
                    console.log("¡PARTIDA FINALIZADA!");
                    console.log("PGN FINAL:", game.pgn());
                }
            }
        } catch (e) {
            console.log("Intento de movimiento ilegal");
        }
    });

    socket.on('reset_game', () => {
        game = new Chess();
        io.emit('init_game', "");
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de Ajedrez vivo en puerto ${PORT}`);
});