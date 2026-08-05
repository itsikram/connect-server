const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

const SECRET_KEY = process.env.JWT_SECRET_KEY;

/**
 * Admin JWT auth. Accepts raw token or "Bearer <token>".
 * Expects payload { admin_id, role }.
 */
const isAdminAuth = async (req, res, next) => {
  try {
    let token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ message: 'Authentication token is required' });
    }

    if (token.startsWith('Bearer ')) {
      token = token.slice(7).trim();
    }

    const decoded = jwt.verify(token, SECRET_KEY);
    if (!decoded?.admin_id) {
      return res.status(401).json({ message: 'Admin authentication required' });
    }

    const admin = await Admin.findById(decoded.admin_id).select('-password');
    if (!admin) {
      return res.status(401).json({ message: 'Admin account not found' });
    }

    req.admin = admin;
    req.adminToken = decoded;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    next(error);
  }
};

module.exports = isAdminAuth;
