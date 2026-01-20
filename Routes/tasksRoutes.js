const Router = require('express').Router();
const {
    getAllTasks,
    createTask,
    updateTask,
    deleteTask,
    deleteCompletedTasks
} = require('../controllers/tasksController');
const isAuth = require('../middlewares/isAuth');

Router.get('/', isAuth, getAllTasks);
Router.post('/', isAuth, createTask);
Router.put('/:id', isAuth, updateTask);
Router.delete('/:id', isAuth, deleteTask);
Router.delete('/completed/all', isAuth, deleteCompletedTasks);

module.exports = Router;
