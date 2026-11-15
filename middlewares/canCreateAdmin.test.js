const assert = require("node:assert/strict");
const test = require("node:test");
const { createCanCreateAdmin } = require("./canCreateAdmin");

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

const run = async (middleware, req = {}) => {
  const res = createResponse();
  let nextCalled = false;
  let nextError;
  await middleware(req, res, (error) => {
    nextCalled = true;
    nextError = error;
  });
  return { req, res, nextCalled, nextError };
};

const signedInAs = (role) => async (req, _res, next) => {
  req.admin = { _id: `${role}-1`, role };
  next();
};

test("the first admin on an empty database can sign up and becomes the bootstrap admin", async () => {
  const middleware = createCanCreateAdmin({
    countAdmins: async () => 0,
    authenticate: () => assert.fail("no login is needed for the first admin"),
  });
  const { req, nextCalled } = await run(middleware);
  assert.equal(nextCalled, true);
  assert.equal(req.bootstrapAdmin, true);
});

test("once an admin exists, only a signed-in superAdmin can create admins", async () => {
  for (const role of ["admin", "moderator", "viewer"]) {
    const middleware = createCanCreateAdmin({ countAdmins: async () => 1, authenticate: signedInAs(role) });
    const { res, nextCalled, req } = await run(middleware);
    assert.equal(nextCalled, false, role);
    assert.equal(res.statusCode, 403, role);
    assert.equal(req.bootstrapAdmin, undefined, role);
  }

  const middleware = createCanCreateAdmin({ countAdmins: async () => 3, authenticate: signedInAs("superAdmin") });
  const { nextCalled, req } = await run(middleware);
  assert.equal(nextCalled, true);
  assert.equal(req.bootstrapAdmin, undefined);
});

test("an anonymous caller is stopped by the admin login check", async () => {
  const middleware = createCanCreateAdmin({
    countAdmins: async () => 1,
    authenticate: async (_req, res) => res.status(401).json({ message: "Authentication token is required" }),
  });
  const { res, nextCalled } = await run(middleware);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("a database error is passed on instead of letting the signup through", async () => {
  const failure = new Error("database unavailable");
  const middleware = createCanCreateAdmin({
    countAdmins: async () => {
      throw failure;
    },
    authenticate: () => assert.fail("must not continue"),
  });
  const { nextCalled, nextError, req } = await run(middleware);
  assert.equal(nextCalled, true);
  assert.equal(nextError, failure);
  assert.equal(req.bootstrapAdmin, undefined);
});
