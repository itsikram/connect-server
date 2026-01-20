const Router = require('express').Router();
const {
    getAllEvents,
    getEventsByDate,
    createEvent,
    updateEvent,
    deleteEvent
} = require('../controllers/calendarController');
const isAuth = require('../middlewares/isAuth');

Router.get('/', isAuth, getAllEvents);
Router.get('/date', isAuth, getEventsByDate);
Router.post('/', isAuth, createEvent);
Router.put('/:id', isAuth, updateEvent);
Router.delete('/:id', isAuth, deleteEvent);

module.exports = Router;
