const Router = require('express').Router();
const { getPortfolio, updatePortfolio, resetPortfolio } = require('../controllers/portfolioController');
const isAdminAuth = require('../middlewares/isAdminAuth');

// Public — used by the web portfolio
Router.get('/', getPortfolio);

// Admin-only mutations
Router.put('/', isAdminAuth, updatePortfolio);
Router.post('/reset', isAdminAuth, resetPortfolio);

module.exports = Router;
