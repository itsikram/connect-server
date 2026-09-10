const isAdminAuth = require("./isAdminAuth");

const ADMIN_ROLES = new Set(["admin", "superAdmin"]);

const createAdminRoleMiddleware =
  ({ authenticate = isAdminAuth } = {}) =>
  (req, res, next) =>
    authenticate(req, res, () => {
      if (!req.admin || !ADMIN_ROLES.has(req.admin.role)) {
        return res.status(403).json({
          message: "Administrator role required",
        });
      }
      return next();
    });

module.exports = createAdminRoleMiddleware();
module.exports.createAdminRoleMiddleware = createAdminRoleMiddleware;
module.exports.ADMIN_ROLES = ADMIN_ROLES;
