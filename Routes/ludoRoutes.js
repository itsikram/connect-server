const Router = require("express").Router();
const {
  saveGameState,
  getGameState,
  getUserGames,
  leaveGame,
  deleteGame,
  cleanupOldGames,
} = require("../controllers/ludoController");
const isAuth = require("../middlewares/isAuth");

// Save or update game state (requires authentication)
Router.post("/save", isAuth, saveGameState);

// Get game state by gameId (public, but can be restricted)
Router.get("/state", getGameState);

// Get all games for the authenticated user
Router.get("/my-games", isAuth, getUserGames);

// Leave a game and remove the authenticated user's persisted match data
Router.post("/leave", isAuth, leaveGame);

// Delete a game (requires authentication - only host can delete)
Router.delete("/delete", isAuth, deleteGame);

// Cleanup old ended games (optional - can be restricted to admins)
Router.post("/cleanup", cleanupOldGames);

module.exports = Router;
