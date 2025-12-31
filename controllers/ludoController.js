const LudoGame = require('../models/LudoGame')
const mongoose = require('mongoose')

// Save or update game state
exports.saveGameState = async (req, res, next) => {
    try {
        const { gameId, players, currentPlayer, diceValue, gameStarted, gameEnded, winners, selectedPlayerCount } = req.body
        
        // Validate required fields
        if (!gameId) {
            return res.status(400).json({ 
                success: false, 
                message: 'Game ID is required' 
            })
        }

        // Get host profile from auth middleware
        const hostId = req.profile?._id
        if (!hostId) {
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication required' 
            })
        }

        // Validate players array
        if (!Array.isArray(players) || players.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Players array is required' 
            })
        }

        // Check if game exists
        const existingGame = await LudoGame.findOne({ gameId })

        if (existingGame) {
            // Update existing game - only host can update
            if (String(existingGame.host) !== String(hostId)) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Only the host can update the game state' 
                })
            }

            // Update game state
            existingGame.players = players
            existingGame.currentPlayer = currentPlayer || existingGame.currentPlayer
            existingGame.diceValue = diceValue !== undefined ? diceValue : existingGame.diceValue
            existingGame.gameStarted = gameStarted !== undefined ? gameStarted : existingGame.gameStarted
            existingGame.gameEnded = gameEnded !== undefined ? gameEnded : existingGame.gameEnded
            existingGame.winners = winners || existingGame.winners
            existingGame.selectedPlayerCount = selectedPlayerCount || existingGame.selectedPlayerCount
            existingGame.lastUpdated = new Date()

            const updatedGame = await existingGame.save()

            return res.status(200).json({
                success: true,
                message: 'Game state updated successfully',
                game: updatedGame
            })
        } else {
            // Create new game
            const newGame = new LudoGame({
                gameId,
                host: hostId,
                players,
                currentPlayer: currentPlayer || 0,
                diceValue: diceValue || 0,
                gameStarted: gameStarted || false,
                gameEnded: gameEnded || false,
                winners: winners || [],
                selectedPlayerCount: selectedPlayerCount || 4,
                lastUpdated: new Date()
            })

            const savedGame = await newGame.save()

            return res.status(201).json({
                success: true,
                message: 'Game state saved successfully',
                game: savedGame
            })
        }
    } catch (error) {
        console.error('Error saving game state:', error)
        if (error.code === 11000) {
            // Duplicate key error (gameId already exists)
            return res.status(409).json({
                success: false,
                message: 'Game with this ID already exists'
            })
        }
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        })
    }
}

// Get game state by gameId
exports.getGameState = async (req, res, next) => {
    try {
        const { gameId } = req.query

        if (!gameId) {
            return res.status(400).json({
                success: false,
                message: 'Game ID is required'
            })
        }

        const game = await LudoGame.findOne({ gameId })
            .populate('host', 'fullName profilePic coverPic')
            .populate('players.profileId', 'fullName profilePic coverPic')

            console.log('gameId getGameState',gameId, game)
        if (!game) {
            return res.status(404).json({
                success: false,
                message: 'Game not found'
            })
        }

        return res.status(200).json({
            success: true,
            game
        })
    } catch (error) {
        console.error('Error getting game state:', error)
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        })
    }
}

// Get all games for a user (as host or player)
exports.getUserGames = async (req, res, next) => {
    try {
        const profileId = req.profile?._id

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            })
        }

        // Find games where user is host or player
        const games = await LudoGame.find({
            $or: [
                { host: profileId },
                { 'players.profileId': profileId }
            ],
            gameEnded: false // Only return active games
        })
            .populate('host', 'fullName profilePic coverPic')
            .populate('players.profileId', 'fullName profilePic coverPic')
            .sort({ lastUpdated: -1 })
            .limit(50)

        return res.status(200).json({
            success: true,
            count: games.length,
            games
        })
    } catch (error) {
        console.error('Error getting user games:', error)
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        })
    }
}

// Delete game (only host can delete)
exports.deleteGame = async (req, res, next) => {
    try {
        const { gameId } = req.body || req.query
        const profileId = req.profile?._id

        if (!gameId) {
            return res.status(400).json({
                success: false,
                message: 'Game ID is required'
            })
        }

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            })
        }

        const game = await LudoGame.findOne({ gameId })

        if (!game) {
            return res.status(404).json({
                success: false,
                message: 'Game not found'
            })
        }

        // Only host can delete
        if (String(game.host) !== String(profileId)) {
            return res.status(403).json({
                success: false,
                message: 'Only the host can delete the game'
            })
        }

        await LudoGame.deleteOne({ gameId })

        return res.status(200).json({
            success: true,
            message: 'Game deleted successfully'
        })
    } catch (error) {
        console.error('Error deleting game:', error)
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        })
    }
}

// Clean up old ended games (optional maintenance endpoint)
exports.cleanupOldGames = async (req, res, next) => {
    try {
        // Only allow admins or run as scheduled job
        // For now, we'll just return a message
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

        const result = await LudoGame.deleteMany({
            gameEnded: true,
            lastUpdated: { $lt: thirtyDaysAgo }
        })

        return res.status(200).json({
            success: true,
            message: `Cleaned up ${result.deletedCount} old games`,
            deletedCount: result.deletedCount
        })
    } catch (error) {
        console.error('Error cleaning up games:', error)
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        })
    }
}

