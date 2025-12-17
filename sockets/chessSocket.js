// Chess game socket handler for online multiplayer

const games = new Map(); // gameId -> { createdAt: number, fen: string, whitePlayer: profileId, blackPlayer: profileId, onlinePlayers: Set<profileId>, offlinePlayers: Map<profileId, timestamp>, lastMove: object }
const userInvites = new Map(); // profileId -> [{ gameId, by, name, avatar, ts }]
const playerSockets = new Map(); // profileId -> Set<socketId>

function chessSocket(io, socket, profileId) {
    const effectiveProfileId = profileId || socket?.handshake?.query?.profile || socket?.handshake?.query?.profileId;
    
    try {
        console.log('[CHESS][server] connected', { socketId: socket?.id, effectiveProfileId });
    } catch (_e) {}

    try {
        socket.on('error', (err) => {
            try { console.error('[CHESS][server] socket error', { socketId: socket?.id, message: err?.message }); } catch (_e2) {}
        });
        
        socket.on('connect_error', (err) => {
            try { console.error('[CHESS][server] connect_error', { socketId: socket?.id, message: err?.message }); } catch (_e2) {}
        });
        
        socket.on('disconnect', (reason) => {
            try { console.log('[CHESS][server] disconnect', { socketId: socket?.id, reason }); } catch (_e2) {}
            
            if (effectiveProfileId) {
                const pid = String(effectiveProfileId);
                const sockets = playerSockets.get(pid);
                if (sockets) {
                    sockets.delete(socket.id);
                    if (sockets.size === 0) {
                        playerSockets.delete(pid);
                        games.forEach((game, gameId) => {
                            if (game.onlinePlayers.has(pid)) {
                                game.onlinePlayers.delete(pid);
                                game.offlinePlayers.set(pid, Date.now());
                                io.to(`chess_${gameId}`).emit('chess:player:offline', { 
                                    profileId: pid, 
                                    gameId,
                                    timestamp: Date.now() 
                                });
                            }
                        });
                    }
                }
            }
        });
    } catch (_e) {}

    // Join per-user room for invites
    if (effectiveProfileId) {
        try { socket.join(`user_${effectiveProfileId}`); } catch (_e) {}
        
        const pid = String(effectiveProfileId);
        if (!playerSockets.has(pid)) {
            playerSockets.set(pid, new Set());
        }
        playerSockets.get(pid).add(socket.id);
        
        // Mark player as online in any games they're in
        games.forEach((game, gameId) => {
            if (game.offlinePlayers.has(pid)) {
                game.offlinePlayers.delete(pid);
                game.onlinePlayers.add(pid);
                io.to(`chess_${gameId}`).emit('chess:player:online', { 
                    profileId: pid, 
                    gameId,
                    timestamp: Date.now() 
                });
            }
        });
        
        // Send pending invites on connect
        const invites = userInvites.get(pid) || [];
        if (invites.length > 0) {
            socket.emit('chess:invites', { invites });
        }
    }

    const joinRoom = (gameId) => {
        const room = `chess_${gameId}`;
        socket.join(room);
        
        if (!games.has(gameId)) {
            games.set(gameId, { 
                createdAt: Date.now(),
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // starting position
                whitePlayer: null,
                blackPlayer: null,
                onlinePlayers: new Set(),
                offlinePlayers: new Map(),
                lastMove: null
            });
        }
        
        if (effectiveProfileId) {
            const game = games.get(gameId);
            if (game) {
                game.onlinePlayers.add(String(effectiveProfileId));
                game.offlinePlayers.delete(String(effectiveProfileId));
            }
        }
        
        return room;
    };

    // Join a game room
    socket.on('chess:join', ({ gameId }) => {
        if (!gameId) return;
        try {
            console.log('[CHESS][server] chess:join', { socketId: socket?.id, gameId, effectiveProfileId });
        } catch (_e) {}
        
        const room = joinRoom(gameId);
        const game = games.get(gameId);
        const roomSize = io?.sockets?.adapter?.rooms?.get(room)?.size || 0;
        
        // Auto-assign player colors if not already assigned
        if (game && effectiveProfileId) {
            const pid = String(effectiveProfileId);
            // If no white player, assign this player as white
            if (!game.whitePlayer) {
                game.whitePlayer = pid;
            }
            // If white player exists and is not this player, and no black player, assign as black
            else if (game.whitePlayer !== pid && !game.blackPlayer) {
                game.blackPlayer = pid;
            }
            // If player is already assigned, keep their assignment
        }
        
        io.to(room).emit('chess:joined', { gameId, profileId: effectiveProfileId, roomSize });
        
        // Send current game state to all players in room (including newly joined)
        if (game) {
            io.to(room).emit('chess:state', {
                gameId,
                fen: game.fen,
                whitePlayer: game.whitePlayer,
                blackPlayer: game.blackPlayer,
                lastMove: game.lastMove,
                serverTs: Date.now()
            });
        }
    });

    // Create a new game
    socket.on('chess:create', ({ gameId }) => {
        if (!gameId) return;
        try {
            console.log('[CHESS][server] chess:create', { socketId: socket?.id, gameId, effectiveProfileId });
        } catch (_e) {}
        
        const room = joinRoom(gameId);
        const game = games.get(gameId);
        if (game && !game.whitePlayer) {
            game.whitePlayer = String(effectiveProfileId);
            io.to(room).emit('chess:state', {
                gameId,
                fen: game.fen,
                whitePlayer: game.whitePlayer,
                blackPlayer: game.blackPlayer,
                serverTs: Date.now()
            });
        }
    });

    // Make a move
    socket.on('chess:move', (payload) => {
        const { gameId, move } = payload || {};
        if (!gameId || !move) return;
        
        try {
            console.log('[CHESS][server] chess:move', { socketId: socket?.id, gameId, move, by: effectiveProfileId });
        } catch (_e) {}
        
        const game = games.get(gameId);
        if (!game) return;
        
        // Validate it's the player's turn (basic validation)
        // In a production app, you'd validate the move server-side with chess.js
        game.fen = move.fen;
        game.lastMove = {
            from: move.from,
            to: move.to,
            promotion: move.promotion,
            timestamp: Date.now()
        };
        
        io.to(`chess_${gameId}`).emit('chess:move', { ...payload, serverTs: Date.now() });
    });

    // Update game state (for resync)
    socket.on('chess:state', (payload) => {
        const { gameId, fen, whitePlayer, blackPlayer } = payload || {};
        if (!gameId) return;
        
        const game = games.get(gameId);
        if (!game) {
            joinRoom(gameId);
        }
        
        const updatedGame = games.get(gameId);
        if (updatedGame) {
            if (fen) updatedGame.fen = fen;
            if (whitePlayer) updatedGame.whitePlayer = String(whitePlayer);
            if (blackPlayer) updatedGame.blackPlayer = String(blackPlayer);
            
            io.to(`chess_${gameId}`).emit('chess:state', {
                gameId,
                fen: updatedGame.fen,
                whitePlayer: updatedGame.whitePlayer,
                blackPlayer: updatedGame.blackPlayer,
                lastMove: updatedGame.lastMove,
                serverTs: Date.now()
            });
        }
    });

    // Assign player color
    socket.on('chess:assign', (payload) => {
        const { gameId, profileId: assignProfileId, color } = payload || {};
        if (!gameId || !assignProfileId || !color) return;
        
        const game = games.get(gameId);
        if (!game) return;
        
        if (color === 'white') {
            game.whitePlayer = String(assignProfileId);
        } else if (color === 'black') {
            game.blackPlayer = String(assignProfileId);
        }
        
        io.to(`chess_${gameId}`).emit('chess:state', {
            gameId,
            fen: game.fen,
            whitePlayer: game.whitePlayer,
            blackPlayer: game.blackPlayer,
            serverTs: Date.now()
        });
    });

    // Send invite
    socket.on('chess:invite', (payload = {}) => {
        const { to, gameId } = payload;
        if (!to || !gameId) {
            try { console.log('[CHESS][server] chess:invite missing required fields', { payload }); } catch (_e) {}
            return;
        }
        
        try {
            console.log('[CHESS][server] chess:invite recv', { socketId: socket?.id, to, by: payload?.by, gameId });
        } catch (_e) {}
        
        const invite = { ...payload, ts: Date.now() };
        const key = String(to);
        const list = userInvites.get(key) || [];
        const exists = list.find(i => String(i.gameId) === String(invite.gameId) && String(i.by) === String(invite.by));
        if (!exists) list.push(invite);
        userInvites.set(key, list);
        
        io.to(`user_${to}`).emit('chess:invite', { ...invite, serverTs: Date.now() });
        io.to(`user_${to}`).emit('chess:invites', { invites: list });
    });

    // Accept invite
    socket.on('chess:accept', (payload = {}) => {
        const { gameId, from } = payload;
        if (!gameId) return;
        
        try {
            console.log('[CHESS][server] chess:accept', { socketId: socket?.id, effectiveProfileId, payload });
        } catch (_e) {}
        
        const room = joinRoom(gameId);
        const game = games.get(gameId);
        
        // Assign black player if white is already set
        if (game && game.whitePlayer && !game.blackPlayer) {
            game.blackPlayer = String(effectiveProfileId);
        }
        
        io.to(room).emit('chess:accepted', { ...payload, profileId: effectiveProfileId, serverTs: Date.now() });
        io.to(room).emit('chess:state', {
            gameId,
            fen: game?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            whitePlayer: game?.whitePlayer,
            blackPlayer: game?.blackPlayer,
            serverTs: Date.now()
        });
        
        // Remove invite from list
        const pid = String(effectiveProfileId || '');
        if (pid) {
            const list = userInvites.get(pid) || [];
            const filtered = list.filter(i => !(String(i.gameId) === String(gameId) && (from ? String(i.by) === String(from) : true)));
            userInvites.set(pid, filtered);
            io.to(`user_${pid}`).emit('chess:invites', { invites: filtered });
        }
    });

    // Get invites
    socket.on('chess:invites:get', () => {
        const pid = String(effectiveProfileId || '');
        if (!pid) return;
        const invites = userInvites.get(pid) || [];
        try { console.log('[CHESS][server] chess:invites:get', { pid, invitesCount: invites.length }); } catch (_e) {}
        socket.emit('chess:invites', { invites });
    });

    // Dismiss invite
    socket.on('chess:invites:dismiss', (payload = {}) => {
        const pid = String(effectiveProfileId || '');
        if (!pid) return;
        const { gameId, by } = payload;
        if (!gameId) return;
        
        const list = userInvites.get(pid) || [];
        const filtered = list.filter(i => !(String(i.gameId) === String(gameId) && (by ? String(i.by) === String(by) : true)));
        userInvites.set(pid, filtered);
        try { console.log('[CHESS][server] chess:invites:dismiss', { pid, gameId, by, before: list.length, after: filtered.length }); } catch (_e) {}
        io.to(`user_${pid}`).emit('chess:invites', { invites: filtered });
    });

    // Reset game
    socket.on('chess:reset', (payload = {}) => {
        const { gameId } = payload;
        if (!gameId) return;
        
        const game = games.get(gameId);
        if (!game) return;
        
        game.fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        game.lastMove = null;
        
        io.to(`chess_${gameId}`).emit('chess:reset', { gameId, serverTs: Date.now() });
        io.to(`chess_${gameId}`).emit('chess:state', {
            gameId,
            fen: game.fen,
            whitePlayer: game.whitePlayer,
            blackPlayer: game.blackPlayer,
            lastMove: null,
            serverTs: Date.now()
        });
    });

    // Game over
    socket.on('chess:gameover', (payload = {}) => {
        const { gameId, result } = payload;
        if (!gameId) return;
        
        io.to(`chess_${gameId}`).emit('chess:gameover', { ...payload, serverTs: Date.now() });
    });
}

module.exports = chessSocket;

