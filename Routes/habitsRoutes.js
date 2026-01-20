const Router = require('express').Router();
const {
    getAllHabits,
    getHabit,
    createHabit,
    updateHabit,
    deleteHabit
} = require('../controllers/habitsController');
const isAuth = require('../middlewares/isAuth');

Router.get('/', isAuth, getAllHabits);
Router.get('/:id', isAuth, getHabit);
Router.post('/', isAuth, createHabit);
Router.put('/:id', isAuth, updateHabit);
Router.delete('/:id', isAuth, deleteHabit);

module.exports = Router;
