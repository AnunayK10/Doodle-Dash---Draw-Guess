const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const path = require("node:path");
const { io } = require("socket.io-client");

const root = path.resolve(__dirname, "..");
const settings = {
  maxPlayers: 4,
  rounds: 2,
  drawTime: 15,
  wordCount: 3,
  hints: 1,
  wordMode: "normal",
};

function onceMatching(socket, event, predicate = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(value);
    };
    socket.on(event, listener);
  });
}

function connectSocket(url) {
  const socket = io(url, { transports: ["websocket"], reconnection: false });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const callback = (error, result) => {
      if (error) reject(error);
      else resolve(result);
    };
    if (payload === undefined) socket.timeout(4000).emit(event, callback);
    else socket.timeout(4000).emit(event, payload, callback);
  });
}

async function waitForHealth(url, process) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Backend exited with code ${process.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("Backend health endpoint did not become ready.");
}

async function readyAll(socket, playerCount) {
  const state = onceMatching(socket, "room:state", (room) =>
    room.players.length === playerCount && room.players.every((player) => player.ready));
  socket.emit("room:ready", true);
  await state;
}

async function startGame(host, guest, hostId) {
  await Promise.all([readyAll(host, 2), readyAll(guest, 2)]);
  const state = onceMatching(host, "room:state", (room) => room.phase === "choosing");
  const words = onceMatching(host, "room:word-options", (options) => options.length > 0);
  host.emit("room:start");
  const result = await state;
  assert.equal(result.drawerId, hostId);
  return { state: result, words: await words };
}

async function selectWord(drawer, receiver, options) {
  assert.ok(options.length >= 1 && options.length <= 5);
  const updated = onceMatching(drawer, "room:state", (room) => room.phase === "drawing");
  const receiverUpdated = onceMatching(receiver, "room:state", (room) => room.phase === "drawing");
  drawer.emit("game:choose-word", options[0]);
  const [drawerState, receiverState] = await Promise.all([updated, receiverUpdated]);
  assert.equal(drawerState.word, options[0]);
  assert.equal(receiverState.word, null);
  return { word: options[0], drawerState, receiverState };
}

async function run() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

  const backend = spawn(process.execPath, [path.join(root, "backend", "dist", "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let backendLogs = "";
  backend.stdout.on("data", (chunk) => { backendLogs += chunk.toString(); });
  backend.stderr.on("data", (chunk) => { backendLogs += chunk.toString(); });
  const clients = [];

  try {
    const url = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(url, backend);
    assert.equal(health.status, "ok");
    const frontend = await fetch(url);
    assert.equal(frontend.status, 200);
    assert.match(await frontend.text(), /Doodle Dash/);
    const missingApi = await fetch(`${url}/api/rooms`);
    assert.deepEqual(await missingApi.json(), []);

    const host = await connectSocket(url);
    const guest = await connectSocket(url);
    const observer = await connectSocket(url);
    const invitee = await connectSocket(url);
    clients.push(host, guest, observer, invitee);

    assert.equal((await emitAck(host, "room:create", { name: " ", settings, isPrivate: false })).ok, false);
    assert.equal((await emitAck(host, "room:create", {
      name: "Host", settings: { ...settings, rounds: 21 }, isPrivate: false,
    })).ok, false);
    assert.equal((await emitAck(guest, "room:join", { roomId: "MISSING", name: "Guest" })).ok, false);

    const publicSettings = { ...settings, maxPlayers: 2 };
    const created = await emitAck(host, "room:create", { name: "Host", settings: publicSettings, isPrivate: false });
    assert.equal(created.ok, true);
    assert.match(created.roomId, /^[A-HJ-NP-Z2-9]{6}$/);
    const publicRooms = await (await fetch(`${url}/api/rooms`)).json();
    assert.ok(publicRooms.some((room) => room.roomId === created.roomId));
    const hostLobby = onceMatching(host, "room:state", (room) => room.players.length === 2);
    const guestLobby = onceMatching(guest, "room:state", (room) => room.players.length === 2);
    assert.equal((await emitAck(guest, "room:join", { roomId: created.roomId, name: "Guest" })).ok, true);
    await Promise.all([hostLobby, guestLobby]);
    assert.equal((await emitAck(observer, "room:join", { roomId: created.roomId, name: "Room full" })).ok, false);
    const publicSnapshots = await emitAck(host, "room:list");
    assert.ok(publicSnapshots.some((room) => room.roomId === created.roomId));

    const privateRoom = await emitAck(observer, "room:create", { name: "Private host", settings, isPrivate: true });
    assert.equal(privateRoom.ok, true);
    assert.equal((await emitAck(host, "room:list")).some((room) => room.roomId === privateRoom.roomId), false);
    assert.equal((await emitAck(invitee, "room:join", { roomId: privateRoom.roomId, name: "Invitee" })).ok, true);
    observer.emit("room:leave");
    invitee.emit("room:leave");

    const hostOnlyError = onceMatching(guest, "room:error", (message) => message.includes("Only the host"));
    guest.emit("room:start");
    assert.match(await hostOnlyError, /Only the host can start/);

    const game = await startGame(host, guest, host.id);
    const activeRoom = game.state;
    assert.equal(activeRoom.phase, "choosing");
    assert.equal(activeRoom.totalTurns, 4);
    let word = await selectWord(host, guest, game.words);
    assert.equal(word.receiverState.wordHint.startsWith("_"), true);
    assert.equal(word.receiverState.wordHint.replace(/ /g, "").length, word.word.replace(/[^a-z0-9]/gi, "").length);
    assert.equal(word.drawerState.timeLeft <= settings.drawTime, true);

    const invalidStrokeEvents = [];
    guest.on("draw:started", (stroke) => invalidStrokeEvents.push(stroke));
    guest.emit("draw:start", { id: "unauthorized", points: [{ x: 0.1, y: 0.1 }], color: "#20242c", size: 5, tool: "pen" });
    host.emit("draw:start", { id: "invalid-point", points: [{ x: 1.5, y: 0.1 }], color: "#20242c", size: 5, tool: "pen" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(invalidStrokeEvents.length, 0);

    const strokeStart = onceMatching(guest, "draw:started", (stroke) => stroke.id === "stroke-one");
    host.emit("draw:start", { id: "stroke-one", points: [{ x: 0.1, y: 0.2 }], color: "#20242c", size: 5, tool: "pen" });
    assert.equal((await strokeStart).points[0].x, 0.1);
    const pointAdded = onceMatching(guest, "draw:point-added", (payload) => payload.strokeId === "stroke-one");
    host.emit("draw:point", { strokeId: "stroke-one", point: { x: 0.5, y: 0.6 } });
    assert.deepEqual((await pointAdded).point, { x: 0.5, y: 0.6 });
    const strokeEnded = onceMatching(guest, "draw:ended", (id) => id === "stroke-one");
    host.emit("draw:end", "stroke-one");
    assert.equal(await strokeEnded, "stroke-one");

    const undoState = onceMatching(host, "room:state", (state) => state.strokes.length === 0);
    const undone = onceMatching(guest, "draw:undone", (id) => id === "stroke-one");
    host.emit("draw:undo");
    await Promise.all([undoState, undone]);
    const secondStroke = onceMatching(guest, "draw:started", (stroke) => stroke.id === "stroke-two");
    host.emit("draw:start", { id: "stroke-two", points: [{ x: 0.3, y: 0.4 }], color: "#f15b3c", size: 7, tool: "eraser" });
    await secondStroke;
    const clearState = onceMatching(host, "room:state", (state) => state.strokes.length === 0);
    const cleared = onceMatching(guest, "draw:cleared");
    host.emit("draw:clear");
    await Promise.all([clearState, cleared]);

    const chatMessage = onceMatching(guest, "room:state", (state) => state.messages.some((message) => message.text === "nice sketch"));
    guest.emit("chat:send", "  nice sketch  ");
    assert.ok((await chatMessage).messages.some((message) => message.text === "nice sketch"));

    const revealed = onceMatching(guest, "room:state", (state) => state.phase === "drawing" && !state.wordHint.startsWith("_"));
    const hintState = await revealed;
    assert.ok(hintState.wordHint.length > 0, "Timed hint should reveal a letter.");
    assert.equal(hintState.word, null, "Guessers must not receive the secret word.");

    const correctGuess = onceMatching(host, "game:guess-result", (result) => result.playerId === guest.id && result.correct);
    guest.emit("chat:send", `${word.word.toLocaleUpperCase()}!!`);
    const guessResult = await correctGuess;
    assert.ok(guessResult.points > 0);
    const firstRoundEnd = await onceMatching(guest, "room:state", (state) => state.phase === "round-ended");
    assert.equal(firstRoundEnd.lastWord, word.word);
    assert.ok(firstRoundEnd.players.find((player) => player.id === guest.id).score >= 100);
    assert.ok(firstRoundEnd.players.find((player) => player.id === host.id).score >= 100);

    const secondWords = onceMatching(guest, "room:word-options", (options) => options.length > 0);
    const nextDrawerState = await onceMatching(guest, "room:state", (state) => state.phase === "choosing" && state.drawerId === guest.id);
    assert.equal(nextDrawerState.turnNumber, 2);
    word = await selectWord(guest, host, await secondWords);
    const secondCorrect = onceMatching(guest, "game:guess-result", (result) => result.playerId === host.id && result.correct);
    host.emit("chat:send", word.word);
    assert.ok((await secondCorrect).points > 0);
    await onceMatching(host, "room:state", (state) => state.phase === "round-ended");

    const thirdWords = onceMatching(host, "room:word-options", (options) => options.length > 0);
    await onceMatching(host, "room:state", (state) => state.phase === "choosing" && state.drawerId === host.id);
    word = await selectWord(host, guest, await thirdWords);
    const thirdCorrect = onceMatching(host, "game:guess-result", (result) => result.playerId === guest.id && result.correct);
    guest.emit("chat:send", word.word);
    assert.ok((await thirdCorrect).points > 0);
    await onceMatching(host, "room:state", (state) => state.phase === "round-ended");

    const fourthWords = onceMatching(guest, "room:word-options", (options) => options.length > 0);
    await onceMatching(guest, "room:state", (state) => state.phase === "choosing" && state.drawerId === guest.id);
    word = await selectWord(guest, host, await fourthWords);
    const fourthCorrect = onceMatching(guest, "game:guess-result", (result) => result.playerId === host.id && result.correct);
    host.emit("chat:send", word.word);
    assert.ok((await fourthCorrect).points > 0);
    const finalState = await onceMatching(host, "room:state", (state) => state.phase === "finished");
    assert.equal(finalState.turnNumber, finalState.totalTurns);
    assert.ok(finalState.winnerId);
    assert.equal(finalState.players.some((player) => player.id === finalState.winnerId), true);

    const combinationRoom = await emitAck(observer, "room:create", {
      name: "Combination host",
      settings: { ...settings, wordMode: "combination" },
      isPrivate: true,
    });
    assert.equal(combinationRoom.ok, true);
    assert.equal((await emitAck(invitee, "room:join", { roomId: combinationRoom.roomId, name: "Combination guest" })).ok, true);
    const combinationGame = await startGame(observer, invitee, observer.id);
    assert.ok(combinationGame.words.every((option) => option.includes(" ")));
    await selectWord(observer, invitee, combinationGame.words);
    observer.emit("room:leave");
    invitee.emit("room:leave");

    const timeoutRoom = await emitAck(observer, "room:create", {
      name: "Timer host",
      settings: { ...settings, rounds: 2, drawTime: 15, hints: 0, wordMode: "hidden" },
      isPrivate: true,
    });
    assert.equal(timeoutRoom.ok, true);
    const timeoutGuest = await connectSocket(url);
    clients.push(timeoutGuest);
    assert.equal((await emitAck(timeoutGuest, "room:join", { roomId: timeoutRoom.roomId, name: "Timer guest" })).ok, true);
    const timeoutGame = await startGame(observer, timeoutGuest, observer.id);
    const timerWord = await selectWord(observer, timeoutGuest, timeoutGame.words);
    assert.equal(timerWord.receiverState.wordHint, "");
    assert.equal(timerWord.receiverState.word, null);
    assert.ok(timerWord.drawerState.timeLeft <= 15);
    const timedOutState = await onceMatching(timeoutGuest, "room:state", (state) => state.phase === "round-ended", 20000);
    assert.equal(timedOutState.lastWord, timerWord.word);
    assert.equal(timedOutState.timeLeft, 0);

    observer.emit("room:leave");
    timeoutGuest.emit("room:leave");
    host.emit("room:leave");
    guest.emit("room:leave");
    const emptyRooms = await (await fetch(`${url}/api/rooms`)).json();
    assert.deepEqual(emptyRooms, []);

    console.log("PASS HTTP health, static frontend, public-room API, room validation, and invitation flow");
    console.log("PASS player limits, private-room visibility, code joining, lobby readiness, and host-only game start");
    console.log("PASS secret-word isolation, hints, drawing permissions, stroke sync, undo, clear, and chat");
    console.log("PASS hidden and combination word modes");
    console.log("PASS normalized correct guesses, scoring, drawer rotation, all-round game completion, and winner");
    console.log("PASS countdown timeout, round-end reveal, cleanup, and empty-room API state");
  } finally {
    for (const client of clients) client.disconnect();
    if (backend.exitCode === null) {
      backend.kill("SIGTERM");
      await new Promise((resolve) => backend.once("exit", resolve));
    }
    if (backendLogs && backend.exitCode !== null && backend.exitCode !== 0) {
      console.error(`Backend output:\n${backendLogs}`);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
