// Every route that changes data or exposes private data must have a login
// check in its middleware chain. These tests read the Express routers
// directly, so they need no database or running server.
const assert = require("node:assert/strict");
const test = require("node:test");

const isAuth = require("../middlewares/isAuth");
const isAdminAuth = require("../middlewares/isAdminAuth");
const isAdminRole = require("../middlewares/isAdminRole");
const canCreateAdmin = require("../middlewares/canCreateAdmin");

const routesOf = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        method: method.toUpperCase(),
        path: layer.route.path,
        handlers: layer.route.stack.map((entry) => entry.handle),
      })),
    );

const findRoute = (router, method, path) => {
  const route = routesOf(router).find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} should exist`);
  return route;
};

const hasAny = (route, guards) => route.handlers.some((handler) => guards.includes(handler));

test("every admin API route requires an admin login, except the login and recovery flow", () => {
  const adminRoutes = require("./adminRoutes");
  const publicRoutes = new Set([
    "POST /login",
    "POST /forgot-password",
    "POST /reset-password/:token",
    "POST /delete", // deletes the caller's own admin account; needs its email and password
    "GET /gdrive/callback", // Google redirects here; a signed state authenticates it
  ]);
  const guards = [isAdminAuth, isAdminRole, canCreateAdmin];

  const routes = routesOf(adminRoutes);
  assert.ok(routes.length > 50, "admin routes should load");
  const unguarded = routes
    .filter((route) => !publicRoutes.has(`${route.method} ${route.path}`))
    .filter((route) => !hasAny(route, guards))
    .map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(unguarded, []);
});

test("account-changing admin routes need the admin role, not just any admin login", () => {
  const adminRoutes = require("./adminRoutes");
  for (const [method, path] of [
    ["PUT", "/profile/:id"],
    ["DELETE", "/profile/:id"],
    ["POST", "/profile/:id/set-password"],
  ]) {
    assert.ok(hasAny(findRoute(adminRoutes, method, path), [isAdminRole]), `${method} ${path}`);
  }
  assert.ok(hasAny(findRoute(adminRoutes, "POST", "/signup"), [canCreateAdmin]), "POST /signup");
});

test("app-wide settings and paid phone calls are admin only", () => {
  const connectRoutes = require("./connectRoutes");
  assert.ok(hasAny(findRoute(connectRoutes, "PUT", "/"), [isAdminRole]), "PUT /api/connect");
  assert.ok(hasAny(findRoute(connectRoutes, "GET", "/phone-call"), [isAdminRole]), "GET /api/connect/phone-call");
  assert.ok(!hasAny(findRoute(connectRoutes, "GET", "/"), [isAdminRole]), "reading the app config stays public");
});

test("call tokens and admin uploads need a login", () => {
  assert.ok(hasAny(findRoute(require("./agoraRoutes"), "POST", "/token"), [isAuth]), "POST /api/agora/token");
  assert.ok(hasAny(findRoute(require("./uploadRoute"), "POST", "/admin"), [isAdminAuth]), "POST /api/upload/admin");
});

test("profile and cover photo uploads check the login before reading the file", () => {
  const profileRoutes = require("./profileRoutes");
  for (const path of ["/update/coverPic", "/update/profilePic"]) {
    const route = findRoute(profileRoutes, "POST", path);
    assert.equal(route.handlers[0], isAuth, `${path} should start with isAuth`);
  }
});

test("the client-claimed coin reward endpoint stays switched off", () => {
  const walletRoutes = require("./walletRoutes");
  assert.equal(
    routesOf(walletRoutes).some((route) => route.path === "/action-reward"),
    false,
  );
});
