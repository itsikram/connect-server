// Test fixture: one API server with only the Ludo sockets, wired like
// index.js (peer socket adapter + internal relay routes). cluster.test.js runs
// two of these as separate processes to play a game across servers.
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { attachPeerAdapter, attachPeerRelayRoute } = require("../../../utils/peerSocketAdapter");
const ludoSocket = require("../../ludoSocket");

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
attachPeerAdapter(io);
io.on("connection", (socket) => ludoSocket(io, socket, socket.handshake.query?.profile));
attachPeerRelayRoute(app, io);
ludoSocket.attachRelayRoute(app, io);
server.listen(Number(process.env.PORT), () => {
  process.stdout.write("READY\n");
});
