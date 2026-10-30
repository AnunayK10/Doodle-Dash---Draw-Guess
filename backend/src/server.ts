import { randomInt } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import { Room, createPlayer } from "./Room";
import type { ClientToServerEvents, RoomSettings, ServerToClientEvents } from "./types";

const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: process.env.CLIENT_URL ?? true },
});
const rooms = new Map<string, Room>();
const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", rooms: rooms.size });
});

app.get("/api/rooms", (_request, response) => {
  response.json([...rooms.values()].filter((room) => !room.isPrivate && room.phase === "lobby").map((room) => room.publicSummary()));
});

const clientDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(clientDist));
app.get("*", (_request, response, next) => {
  response.sendFile(path.join(clientDist, "index.html"), (error) => {
    if (error) next();
  });
});

function createRoomId(): string {
  let id = "";
  do {
    id = Array.from({ length: 6 }, () => roomAlphabet[randomInt(roomAlphabet.length)]).join("");
  } while (rooms.has(id));
  return id;
}

function validSettings(settings: RoomSettings): boolean {
  return typeof settings === "object" && settings !== null
    && Number.isInteger(settings.maxPlayers) && settings.maxPlayers >= 2 && settings.maxPlayers <= 12
    && Number.isInteger(settings.rounds) && settings.rounds >= 2 && settings.rounds <= 20
    && Number.isInteger(settings.drawTime) && settings.drawTime >= 15 && settings.drawTime <= 240
    && Number.isInteger(settings.wordCount) && settings.wordCount >= 1 && settings.wordCount <= 5
    && Number.isInteger(settings.hints) && settings.hints >= 0 && settings.hints <= 5
    && ["normal", "hidden", "combination"].includes(settings.wordMode);
}

function detachPlayer(socketId: string): void {
  const room = [...rooms.values()].find((candidate) => candidate.players.has(socketId));
  if (!room) return;
  io.sockets.sockets.get(socketId)?.leave(room.id);
  const removeRoom = room.removePlayer(socketId);
  if (removeRoom) rooms.delete(room.id);
}

io.on("connection", (socket) => {
  socket.on("room:create", (input, ack) => {
    if (!input || typeof input !== "object") return ack({ ok: false, error: "Room details are required." });
    const name = typeof input?.name === "string" ? input.name.trim().slice(0, 18) : "";
    if (!name) return ack({ ok: false, error: "Enter a player name." });
    if (!input.settings || !validSettings(input.settings)) return ack({ ok: false, error: "Room settings are invalid." });
    detachPlayer(socket.id);
    const roomId = createRoomId();
    const room = new Room(roomId, createPlayer(socket.id, name, 0), input.settings, Boolean(input.isPrivate), io);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit("room:state", room.snapshotFor(socket.id));
    ack({ ok: true, roomId });
  });

  socket.on("room:join", (input, ack) => {
    if (!input || typeof input !== "object") return ack({ ok: false, error: "Room details are required." });
    const roomId = typeof input?.roomId === "string" ? input.roomId.trim().toUpperCase() : "";
    const name = typeof input?.name === "string" ? input.name.trim().slice(0, 18) : "";
    const room = rooms.get(roomId);
    if (!name) return ack({ ok: false, error: "Enter a player name." });
    if (!room) return ack({ ok: false, error: "Room not found. Check the code and try again." });
    if (room.players.has(socket.id)) return ack({ ok: true, roomId });
    if (room.phase !== "lobby") return ack({ ok: false, error: "That game has already started." });
    if (room.players.size >= room.settings.maxPlayers) return ack({ ok: false, error: "That room is full." });
    detachPlayer(socket.id);
    socket.join(roomId);
    room.addPlayer(createPlayer(socket.id, name, room.players.size));
    ack({ ok: true, roomId });
  });

  socket.on("room:leave", () => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (room) {
      socket.leave(room.id);
      if (room.removePlayer(socket.id)) rooms.delete(room.id);
    }
  });

  socket.on("room:list", (ack) => {
    ack([...rooms.values()].filter((room) => !room.isPrivate && room.phase === "lobby").map((room) => room.publicSummary()));
  });

  const withRoom = (action: (room: Room) => void) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (room) action(room);
  };

  socket.on("room:ready", (ready) => withRoom((room) => room.setReady(socket.id, Boolean(ready))));
  socket.on("room:start", () => withRoom((room) => room.start(socket.id)));
  socket.on("game:choose-word", (word) => {
    if (typeof word === "string") withRoom((room) => room.chooseWord(socket.id, word));
  });
  socket.on("draw:start", (stroke) => withRoom((room) => room.startStroke(socket.id, stroke)));
  socket.on("draw:point", (payload) => {
    if (payload?.strokeId && payload.point) withRoom((room) => room.addStrokePoint(socket.id, payload.strokeId, payload.point));
  });
  socket.on("draw:end", (strokeId) => {
    if (typeof strokeId === "string") withRoom((room) => room.endStroke(socket.id, strokeId));
  });
  socket.on("draw:undo", () => withRoom((room) => room.undo(socket.id)));
  socket.on("draw:clear", () => withRoom((room) => room.clearCanvas(socket.id)));
  socket.on("chat:send", (text) => {
    if (typeof text === "string") withRoom((room) => room.guess(socket.id, text));
  });
  socket.on("disconnect", () => detachPlayer(socket.id));
});

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Doodle Dash server listening on port ${port}`);
});
