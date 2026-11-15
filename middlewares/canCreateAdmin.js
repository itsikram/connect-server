const isAdminAuth = require("./isAdminAuth");
const { prisma } = require("../utils/db");

/**
 * Who may create an admin account: a logged-in superAdmin, or anyone while
 * the database has no admin at all (so a fresh install can make its first
 * one). Sets req.bootstrapAdmin for that first account.
 */
const createCanCreateAdmin =
  ({ authenticate = isAdminAuth, countAdmins = () => prisma.admin.count() } = {}) =>
  async (req, res, next) => {
    let existing;
    try {
      existing = await countAdmins();
    } catch (error) {
      return next(error);
    }
    if (existing === 0) {
      req.bootstrapAdmin = true;
      return next();
    }
    return authenticate(req, res, () => {
      if (req.admin?.role !== "superAdmin") {
        return res.status(403).json({ message: "Only a super admin can create admin accounts" });
      }
      return next();
    });
  };

module.exports = createCanCreateAdmin();
module.exports.createCanCreateAdmin = createCanCreateAdmin;
