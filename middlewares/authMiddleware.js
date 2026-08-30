const jwt = require('jsonwebtoken');
const User = require('../models/User');

const SECRET_KEY = process.env.JWT_SECRET_KEY;

const verifyToken = async (req, res, next) => {
  try {
    let token = req.headers.authorization;

    // Check if token exists
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication token is required',
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.user_id || decoded.id;

    // Get user from database
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found',
      });
    }

    // Attach user info to request
    req.user = {
      id: user._id,
      userId: user._id,
      email: user.email,
    };

    next();
  } catch (error) {
    if (
      error.name === 'JsonWebTokenError' ||
      error.name === 'TokenExpiredError'
    ) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
      });
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Authentication failed',
    });
  }
};

module.exports = verifyToken;
