const assert = require("node:assert/strict");
const test = require("node:test");
const { createAdminRoleMiddleware } = require("./isAdminRole");

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test("rejects a non-admin account on all payment admin routes", async () => {
  const middleware = createAdminRoleMiddleware({
    authenticate: async (req, _res, next) => {
      req.admin = { _id: "moderator-1", role: "moderator" };
      next();
    },
  });

  for (const path of [
    "/api/admin/payments?status=pending",
    "/api/admin/payments/transaction-1/approve",
    "/api/admin/payments/transaction-1/reject",
  ]) {
    const response = createResponse();
    const request = { path, admin: undefined };
    let nextCalled = false;

    await middleware(request, response, () => {
      nextCalled = true;
    });

    assert.equal(response.statusCode, 403, path);
    assert.equal(response.body.message, "Administrator role required", path);
    assert.equal(nextCalled, false, path);
  }
});
