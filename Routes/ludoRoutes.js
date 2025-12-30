const Router = require('express').Router()
const { 
    saveGameState, 
    getGameState, 
    getUserGames, 
    deleteGame,
    cleanupOldGames 
} = require('../controllers/ludoController')
const isAuth = require('../middlewares/isAuth')

// Save or update game state (requires authentication)
Router.post('/save', isAuth, saveGameState)

// Get game state by gameId (public, but can be restricted)
Router.get('/state', getGameState)

// Get all games for the authenticated user
Router.get('/my-games', isAuth, getUserGames)

// Delete a game (requires authentication - only host can delete)
Router.delete('/delete', isAuth, deleteGame)

// Cleanup old ended games (optional - can be restricted to admins)
Router.post('/cleanup', cleanupOldGames)

module.exports = Router

