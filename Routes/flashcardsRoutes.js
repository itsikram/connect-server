const Router = require('express').Router();
const {
    getAllDecks,
    getDeck,
    createDeck,
    updateDeck,
    deleteDeck
} = require('../controllers/flashcardsController');
const isAuth = require('../middlewares/isAuth');

Router.get('/', isAuth, getAllDecks);
Router.get('/:id', isAuth, getDeck);
Router.post('/', isAuth, createDeck);
Router.put('/:id', isAuth, updateDeck);
Router.delete('/:id', isAuth, deleteDeck);

module.exports = Router;
