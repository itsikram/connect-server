const Router = require('express').Router();
const {
    getAllNotes,
    getNote,
    createNote,
    updateNote,
    deleteNote
} = require('../controllers/notesController');
const isAuth = require('../middlewares/isAuth');

Router.get('/', isAuth, getAllNotes);
Router.get('/:id', isAuth, getNote);
Router.post('/', isAuth, createNote);
Router.put('/:id', isAuth, updateNote);
Router.delete('/:id', isAuth, deleteNote);

module.exports = Router;
