// Minimal Ludo game socket relay for online play and device migration

const games = new Map(); // gameId -> { createdAt: number, lastPlayers: object, onlinePlayers: Set<profileId>, offlinePlayers: Map<profileId, timestamp> }
const userInvites = new Map(); // profileId -> [{ gameId, by, name, avatar, slotIndex, playerCount, ts }]
const playerSockets = new Map(); // profileId -> Set<socketId> (track all sockets for a profile)

// Helper function to get next active player (skip inactive players)
function getNextActivePlayer(currentPlayerIndex) {
    // Simple implementation: go to next player, wrap around, skip inactive
    let nextIndex = (currentPlayerIndex + 1) % 4;
    let attempts = 0;
    
    while (attempts < 4) {
        // In a real implementation, you'd check if player at nextIndex is active
        // For now, just return the next player
        return nextIndex;
    }
    
    return currentPlayerIndex; // fallback
}

function ludoSocket(io, socket, profileId) {
    // Derive profileId from handshake if not provided
    const effectiveProfileId = profileId || socket?.handshake?.query?.profile || socket?.handshake?.query?.profileId;
    try { console.log('[LUDO][server] connected', { socketId: socket?.id, effectiveProfileId }); } catch (_e) {}
    try {
        socket.on('error', (err) => {
            try { console.error('[LUDO][server] socket error', { socketId: socket?.id, message: err?.message }); } catch (_e2) {}
        });
        socket.on('connect_error', (err) => {
            try { console.error('[LUDO][server] connect_error', { socketId: socket?.id, message: err?.message }); } catch (_e2) {}
        });
        socket.on('disconnect', (reason) => {
            try { console.log('[LUDO][server] disconnect', { socketId: socket?.id, reason }); } catch (_e2) {}
            // Track offline players
            if (effectiveProfileId) {
                const pid = String(effectiveProfileId);
                // Remove socket from player's socket set
                const sockets = playerSockets.get(pid);
                if (sockets) {
                    sockets.delete(socket.id);
                    // If no more sockets for this player, mark as offline in all their games
                    if (sockets.size === 0) {
                        playerSockets.delete(pid);
                        // Find all games this player is in and mark them offline
                        games.forEach((game, gameId) => {
                            if (game.onlinePlayers.has(pid)) {
                                game.onlinePlayers.delete(pid);
                                game.offlinePlayers.set(pid, Date.now());
                                // Notify other players in the game
                                io.to(`ludo_${gameId}`).emit('ludo:player:offline', { 
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
    // Join a per-user room so we can DM invites by profile id
    if (effectiveProfileId) {
        try { socket.join(`user_${effectiveProfileId}`); } catch (_e) {}
        try {
            const room = `user_${effectiveProfileId}`;
            const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
            console.log('[LUDO][server] joined user room', { room, size, socketId: socket?.id });
        } catch (_e) {}
        // Track socket for this player
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
                // Notify other players in the game
                io.to(`ludo_${gameId}`).emit('ludo:player:online', { 
                    profileId: pid, 
                    gameId,
                    timestamp: Date.now() 
                });
            }
        });
        // On connect, send any pending invites to this user
        const invites = userInvites.get(pid) || [];
        if (invites.length > 0) {
            socket.emit('ludo:invites', { invites });
        }
    }

    const joinRoom = (gameId) => {
        const room = `ludo_${gameId}`;
        socket.join(room);
        if (!games.has(gameId)) {
            games.set(gameId, { 
                createdAt: Date.now(),
                onlinePlayers: new Set(),
                offlinePlayers: new Map() // profileId -> timestamp when went offline
            });
        }
        // Mark player as online
        if (effectiveProfileId) {
            const game = games.get(gameId);
            if (game) {
                game.onlinePlayers.add(String(effectiveProfileId));
                game.offlinePlayers.delete(String(effectiveProfileId));
            }
        }
        return room;
    };

    socket.on('ludo:join', ({ gameId }) => {
        if (!gameId) return;
        try {
            const preRoom = `ludo_${gameId}`;
            const preSize = io?.sockets?.adapter?.rooms?.get?.(preRoom)?.size || 0;
            console.log('[LUDO][server] ludo:join', { socketId: socket?.id, gameId, effectiveProfileId, beforeRoomSize: preSize });
        } catch (_e) {}
        const room = joinRoom(gameId);
        try {
            const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
            io.to(room).emit('ludo:joined', { gameId, profileId, roomSize: size });
            console.log('[LUDO][server] ludo:joined emitted', { room, roomSize: size, forProfile: profileId });
        } catch (e) { console.error('[LUDO][server] ludo:joined emit error', e?.message); }
        // Send latest players snapshot (if any) only to the newly joined socket
        try {
            const g = games.get(gameId);
            if (g && g.lastPlayers) {
                socket.emit('ludo:players', { ...g.lastPlayers, serverTs: Date.now() });
            }
        } catch (_e) {}
    });

    socket.on('ludo:roll', (payload) => {
        const { gameId, by, currentPlayer } = payload || {};
        if (!gameId) return;
        
        // Validate that the player is rolling on their turn
        const game = games.get(gameId);
        if (game && game.lastPlayers && typeof game.lastPlayers.currentPlayer === 'number') {
            // Find the player index for this profileId
            const playerIndex = game.lastPlayers.players?.findIndex(p => 
                p.profileId && String(p.profileId) === String(by)
            );
            
            // Only allow roll if this player is the current player
            if (playerIndex !== game.lastPlayers.currentPlayer) {
                console.log('[LUDO][server] ❌ ludo:roll rejected - wrong player turn', { 
                    socketId: socket?.id, 
                    gameId, 
                    by, 
                    playerIndex, 
                    currentPlayer: game.lastPlayers.currentPlayer 
                });
                return;
            }
        }
        
        try { 
            console.log('[LUDO][server] ✅ ludo:roll validated', { 
                socketId: socket?.id, 
                gameId, 
                by: payload?.by, 
                value: payload?.value,
                currentPlayer: payload?.currentPlayer 
            }); 
        } catch (_e) {}
        
        io.to(`ludo_${gameId}`).emit('ludo:roll', { ...payload, serverTs: Date.now() });
    });

    socket.on('ludo:move', (payload) => {
        const { gameId, by, playerIndex, fromSteps, toSteps, rolled } = payload || {};
        if (!gameId) return;
        
        // Validate that player is moving on their turn
        const game = games.get(gameId);
        if (game && game.lastPlayers && typeof game.lastPlayers.currentPlayer === 'number') {
            // Find player index for this profileId
            const senderPlayerIndex = game.lastPlayers.players?.findIndex(p => 
                p.profileId && String(p.profileId) === String(by)
            );
            
            // Only allow move if this player is current player and matches playerIndex in payload
            if (senderPlayerIndex !== game.lastPlayers.currentPlayer || senderPlayerIndex !== playerIndex) {
                console.log('[LUDO][server] ❌ ludo:move rejected - wrong player turn', { 
                    socketId: socket?.id, 
                    gameId, 
                    by, 
                    senderPlayerIndex, 
                    payloadPlayerIndex: playerIndex,
                    currentPlayer: game.lastPlayers.currentPlayer 
                });
                return;
            }
        }
        
        try { 
            console.log('[LUDO][server] ✅ ludo:move validated', { 
                socketId: socket?.id, 
                gameId, 
                by: payload?.by, 
                playerIndex: payload?.playerIndex, 
                fromSteps: payload?.fromSteps,
                toSteps: payload?.toSteps, 
                rolled: payload?.rolled 
            }); 
        } catch (_e) {}
        
        // Check if this move should trigger a turn change
        let shouldAdvanceTurn = false;
        let nextPlayer = null;
        
        if (game && game.lastPlayers && game.lastPlayers.players) {
            const movingPlayer = game.lastPlayers.players[playerIndex];
            const movedOutOfHome = fromSteps === 0 && toSteps > 0;
            const rolledSix = rolled === 6;
            
            // Player loses turn if they make a regular move (not rolling 6)
            if (!rolledSix && movedOutOfHome) {
                shouldAdvanceTurn = true;
                nextPlayer = getNextActivePlayer(playerIndex);
                console.log('[LUDO][server] Turn will advance - regular move', {
                    playerIndex,
                    fromSteps,
                    toSteps,
                    rolled,
                    nextPlayer
                });
            } else if (rolledSix && movedOutOfHome) {
                // Player moved out with 6 - they keep their turn, but we should update state
                console.log('[LUDO][server] Player keeps turn - moved out with 6', {
                    playerIndex,
                    fromSteps,
                    toSteps,
                    rolled
                });
            }
            
            // Update the game state with new turn if needed
            if (shouldAdvanceTurn && nextPlayer !== null) {
                game.lastPlayers.currentPlayer = nextPlayer;
                console.log('[LUDO][server] Updated currentPlayer in game state', {
                    oldPlayer: playerIndex,
                    newPlayer: nextPlayer
                });
            }
        }
        
        io.to(`ludo_${gameId}`).emit('ludo:move', { ...payload, serverTs: Date.now() });
        
        // If turn changed, also broadcast updated game state
        if (shouldAdvanceTurn && game && game.lastPlayers) {
            setTimeout(() => {
                io.to(`ludo_${gameId}`).emit('ludo:players', { 
                    ...game.lastPlayers, 
                    serverTs: Date.now() 
                });
            }, 100); // Small delay to ensure move is processed first
        }
    });

    // Host sends an invite specifying target friend profile id
    socket.on('ludo:invite', (payload = {}) => {
        const { to } = payload;
        if (!to) { try { console.log('[LUDO][server] ludo:invite missing "to" field', { payload }); } catch (_e) {} return; }
        try { console.log('[LUDO][server] ludo:invite recv', { socketId: socket?.id, to, by: payload?.by, gameId: payload?.gameId, slotIndex: payload?.slotIndex, playerCount: payload?.playerCount }); } catch (_e) {}
        const invite = { ...payload, ts: Date.now() };
        const key = String(to);
        const list = userInvites.get(key) || [];
        // Deduplicate by gameId+by
        const exists = list.find(i => String(i.gameId) === String(invite.gameId) && String(i.by) === String(invite.by));
        if (!exists) list.push(invite);
        userInvites.set(key, list);
        // Notify target user: single invite + full list snapshot
        try {
            const room = `user_${to}`;
            const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
            console.log('[LUDO][server] ludo:invite emit', { room, invitesCount: list.length, targetSockets: size });
        } catch (_e) {}
        io.to(`user_${to}`).emit('ludo:invite', { ...invite, serverTs: Date.now() });
        io.to(`user_${to}`).emit('ludo:invites', { invites: list });
    });

    // Invitee accepted; notify the room that they joined a specific slot
    socket.on('ludo:accept', (payload = {}) => {
        const { gameId } = payload;
        if (!gameId) return;
        try {
            const room = `ludo_${gameId}`;
            const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
            console.log('[LUDO][server] ludo:accept', { socketId: socket?.id, effectiveProfileId, payload, room, roomSize: size });
        } catch (_e) {}
        const room = joinRoom(gameId);
        try {
            const emitted = { ...payload, serverTs: Date.now() };
            io.to(room).emit('ludo:accepted', emitted);
            const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
            console.log('[LUDO][server] ludo:accepted emitted', { room, roomSize: size, payload: emitted });
        } catch (e) { console.error('[LUDO][server] ludo:accepted emit error', e?.message); }
        // Remove this invite from the user's pending list
        const pid = String(effectiveProfileId || '');
        if (pid) {
            const list = userInvites.get(pid) || [];
            const filtered = list.filter(i => !(String(i.gameId) === String(payload.gameId) && (payload.from ? String(i.by) === String(payload.from) : true)));
            userInvites.set(pid, filtered);
            try { console.log('[LUDO][server] invites updated after accept', { pid, before: list.length, after: filtered.length }); } catch (_e) {}
            io.to(`user_${pid}`).emit('ludo:invites', { invites: filtered });
        }
    });

    // Broadcast players/state snapshot so all clients sync
    socket.on('ludo:players', (payload = {}) => {
        const { gameId } = payload;
        if (!gameId) return;
        // cache latest snapshot for late joiners
        const existing = games.get(gameId) || { 
            createdAt: Date.now(),
            onlinePlayers: new Set(),
            offlinePlayers: new Map()
        };
        // Enhance payload with online/offline status
        const enhancedPayload = { ...payload };
        if (Array.isArray(payload.players)) {
            enhancedPayload.players = payload.players.map(p => {
                const pid = String(p.profileId || '');
                const isOnline = pid && existing.onlinePlayers.has(pid);
                const isOffline = pid && existing.offlinePlayers.has(pid);
                return {
                    ...p,
                    isActive: isOnline || (!pid), // Bots (no profileId) are always active
                    isOffline: isOffline,
                    offlineSince: isOffline ? existing.offlinePlayers.get(pid) : undefined
                };
            });
        }
        games.set(gameId, { ...existing, lastPlayers: enhancedPayload });
        try { console.log('[LUDO][server] ludo:players snapshot', { gameId, players: Array.isArray(payload?.players) ? payload.players.length : 'n/a', selectedPlayerCount: payload?.selectedPlayerCount, currentPlayer: payload?.currentPlayer }); } catch (_e) {}
        io.to(`ludo_${gameId}`).emit('ludo:players', { ...enhancedPayload, serverTs: Date.now() });
    });

    // Client requests full pending invites list
    socket.on('ludo:invites:get', () => {
        const pid = String(effectiveProfileId || '');
        if (!pid) return;
        const invites = userInvites.get(pid) || [];
        try { console.log('[LUDO][server] ludo:invites:get', { pid, invitesCount: invites.length }); } catch (_e) {}
        socket.emit('ludo:invites', { invites });
    });

    // Client requests latest players snapshot for a specific game
    socket.on('ludo:players:get', (payload = {}) => {
        const { gameId } = payload || {};
        if (!gameId) return;
        try {
            const g = games.get(gameId);
            if (g && g.lastPlayers) {
                // Enhance with current online/offline status
                const enhanced = { ...g.lastPlayers };
                if (Array.isArray(enhanced.players)) {
                    enhanced.players = enhanced.players.map(p => {
                        const pid = String(p.profileId || '');
                        const isOnline = pid && g.onlinePlayers.has(pid);
                        const isOffline = pid && g.offlinePlayers.has(pid);
                        return {
                            ...p,
                            isActive: isOnline || (!pid),
                            isOffline: isOffline,
                            offlineSince: isOffline ? g.offlinePlayers.get(pid) : undefined
                        };
                    });
                }
                console.log('[LUDO][server] ludo:players:get -> emit snapshot', { gameId });
                socket.emit('ludo:players', { ...enhanced, serverTs: Date.now() });
            }
        } catch (_e) {}
    });

    // Host requests to replace offline player with bot
    socket.on('ludo:replace:bot', (payload = {}) => {
        const { gameId, playerIndex } = payload || {};
        if (!gameId || typeof playerIndex !== 'number') return;
        try {
            const g = games.get(gameId);
            if (g && g.lastPlayers && Array.isArray(g.lastPlayers.players)) {
                const player = g.lastPlayers.players[playerIndex];
                if (player && player.profileId) {
                    // Remove from offline tracking
                    const pid = String(player.profileId);
                    g.offlinePlayers.delete(pid);
                    g.onlinePlayers.delete(pid);
                    // Update player to bot (remove profileId)
                    g.lastPlayers.players[playerIndex] = {
                        ...player,
                        profileId: null,
                        isActive: true,
                        isOffline: false,
                        isBot: true
                    };
                    // Broadcast update
                    io.to(`ludo_${gameId}`).emit('ludo:players', { ...g.lastPlayers, serverTs: Date.now() });
                    console.log('[LUDO][server] ludo:replace:bot', { gameId, playerIndex });
                }
            }
        } catch (_e) {}
    });

    // Host requests to remove offline player
    socket.on('ludo:remove:player', (payload = {}) => {
        const { gameId, playerIndex } = payload || {};
        if (!gameId || typeof playerIndex !== 'number') return;
        try {
            const g = games.get(gameId);
            if (g && g.lastPlayers && Array.isArray(g.lastPlayers.players)) {
                const player = g.lastPlayers.players[playerIndex];
                if (player && player.profileId) {
                    // Remove from tracking
                    const pid = String(player.profileId);
                    g.offlinePlayers.delete(pid);
                    g.onlinePlayers.delete(pid);
                    // Clear the slot
                    g.lastPlayers.players[playerIndex] = {
                        ...player,
                        profileId: null,
                        name: `Player ${playerIndex + 1}`,
                        isActive: false
                    };
                    // Broadcast update
                    io.to(`ludo_${gameId}`).emit('ludo:players', { ...g.lastPlayers, serverTs: Date.now() });
                    console.log('[LUDO][server] ludo:remove:player', { gameId, playerIndex });
                }
            }
        } catch (_e) {}
    });

    // Client dismisses an invite without accepting
    socket.on('ludo:invites:dismiss', (payload = {}) => {
        const pid = String(effectiveProfileId || '');
        if (!pid) return;
        const { gameId, by } = payload;
        if (!gameId) return;
        const list = userInvites.get(pid) || [];
        const filtered = list.filter(i => !(String(i.gameId) === String(gameId) && (by ? String(i.by) === String(by) : true)));
        userInvites.set(pid, filtered);
        try { console.log('[LUDO][server] ludo:invites:dismiss', { pid, gameId, by, before: list.length, after: filtered.length }); } catch (_e) {}
        io.to(`user_${pid}`).emit('ludo:invites', { invites: filtered });
    });
}

module.exports = ludoSocket;


