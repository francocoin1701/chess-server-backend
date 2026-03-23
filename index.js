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
        origin: "*", // Permitir que cualquier frontend se conecte
        methods: ["GET", "POST"]
    }
});

// Guardaremos las partidas en memoria
// Estructura: { "id_partida": { game: ChessInstance, players: [] } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    // Cuando un jugador se une a una sala (ID de la partida)
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                game: new Chess(),
                players: []
            };
        }
        
        // Enviar el estado actual del juego al jugador que entra
        socket.emit('init_game', rooms[roomId].game.pgn());
        console.log(`Usuario ${socket.id} entró a la sala: ${roomId}`);
    });

    // Cuando un jugador hace un movimiento
    socket.on('move', ({ roomId, move }) => {
        const room = rooms[roomId];
        if (!room) return;

        try {
            // Validar y aplicar el movimiento en el servidor
            const result = room.game.move(move);
            
            if (result) {
                // Si el movimiento es legal, avisar a TODOS en la sala
                io.to(roomId).emit('update_game', {
                    pgn: room.game.pgn(),
                    move: result
                });
            }
        } catch (e) {
            console.log("Movimiento ilegal intentado");
        }
    });

    socket.on('disconnect', () => {
        console.log('Usuario desconectado');
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de Ajedrez Real-Time corriendo en puerto ${PORT}`);
});