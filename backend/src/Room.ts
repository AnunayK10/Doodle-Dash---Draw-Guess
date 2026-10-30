import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import { chooseWords, getHint } from "./words";
import type {
  ChatMessage,
  Player,
  Point,
  PublicRoom,
  RoomSettings,
  RoomSnapshot,
  ServerToClientEvents,
  ClientToServerEvents,
  Stroke,
} from "./types";

const playerColors = ["#f97316", "#14b8a6", "#8b5cf6", "#ec4899", "#3b82f6", "#84cc16", "#f43f5e", "#eab308"];

export class Room {
  readonly id: string;
  readonly isPrivate: boolean;
  readonly settings: RoomSettings;
  readonly players = new Map<string, Player>();
  readonly strokes: Stroke[] = [];
  readonly messages: ChatMessage[] = [];
  hostId: string;
  phase: "lobby" | "choosing" | "drawing" | "round-ended" | "finished" = "lobby";
  drawerId: string | null = null;
  lastWord: string | null = null;
  winnerId: string | null = null;
  private readonly io: Server<ClientToServerEvents, ServerToClientEvents>;
  private turnOrder: string[] = [];
  private turnIndex = 0;
  private wordOptions: string[] = [];
  private activeWord: string | null = null;
  private revealedLetters = 0;
  private guessedPlayers = new Set<string>();
  private turnDeadline = 0;
  private timer: NodeJS.Timeout | undefined;
  private transitionTimer: NodeJS.Timeout | undefined;

  constructor(
    id: string,
    host: Player,
    settings: RoomSettings,
    isPrivate: boolean,
    io: Server<ClientToServerEvents, ServerToClientEvents>,
  ) {
    this.id = id;
    this.hostId = host.id;
    this.settings = settings;
    this.isPrivate = isPrivate;
    this.io = io;
    this.players.set(host.id, host);
  }

  addPlayer(player: Player): void {
    this.players.set(player.id, player);
    this.broadcastState();
  }

  setReady(playerId: string, ready: boolean): void {
    if (this.phase !== "lobby") return;
    const player = this.players.get(playerId);
    if (!player) return;
    player.ready = ready;
    this.broadcastState();
  }

  start(playerId: string): void {
    if (playerId !== this.hostId) return this.error(playerId, "Only the host can start the game.");
    if (this.phase !== "lobby") return;
    if (this.players.size < 2) return this.error(playerId, "At least two players are needed to start.");
    if ([...this.players.values()].some((player) => !player.ready)) {
      return this.error(playerId, "Everyone needs to be ready before the game starts.");
    }

    this.turnOrder = [...this.players.keys()];
    this.turnIndex = 0;
    for (const player of this.players.values()) {
      player.score = 0;
      player.guessed = false;
    }
    this.beginTurn();
  }

  chooseWord(playerId: string, word: string): void {
    if (this.phase !== "choosing" || playerId !== this.drawerId || !this.wordOptions.includes(word)) return;
    this.activeWord = word;
    this.lastWord = null;
    this.revealedLetters = 0;
    this.guessedPlayers.clear();
    this.strokes.length = 0;
    for (const player of this.players.values()) player.guessed = false;
    this.phase = "drawing";
    this.turnDeadline = Date.now() + this.settings.drawTime * 1000;
    this.addSystemMessage("The drawing has started. Make your best guess!");
    this.broadcastState();
    this.startTimer();
  }

  guess(playerId: string, text: string): void {
    const player = this.players.get(playerId);
    if (!player || !text.trim() || text.length > 180) return;
    if (this.phase === "drawing" && this.activeWord && playerId !== this.drawerId && !this.guessedPlayers.has(playerId)) {
      if (this.normalizeGuess(text) === this.normalizeGuess(this.activeWord)) {
        const remainingRatio = Math.max(0, (this.turnDeadline - Date.now()) / (this.settings.drawTime * 1000));
        const multiplier = Math.max(0.4, 1 - this.guessedPlayers.size * 0.15);
        const points = Math.max(100, Math.round(1000 * remainingRatio * multiplier));
        player.score += points;
        player.guessed = true;
        this.guessedPlayers.add(playerId);
        const drawer = this.drawerId ? this.players.get(this.drawerId) : undefined;
        if (drawer) drawer.score += 100;
        this.addMessage(player, "guessed the word!", "correct");
        this.io.to(this.id).emit("game:guess-result", { playerId, correct: true, points });
        this.broadcastState();
        const guessers = [...this.players.keys()].filter((id) => id !== this.drawerId);
        if (guessers.length > 0 && guessers.every((id) => this.guessedPlayers.has(id))) {
          this.endTurn();
        }
        return;
      }
    }

    if (this.phase === "drawing") {
      this.addMessage(player, text.trim(), "chat");
      this.io.to(this.id).emit("game:guess-result", { playerId, correct: false, points: 0 });
    } else {
      this.addMessage(player, text.trim(), "chat");
    }
    this.broadcastState();
  }

  sendChat(playerId: string, text: string): void {
    const player = this.players.get(playerId);
    const message = text.trim();
    if (!player || !message || message.length > 180) return;
    this.addMessage(player, message, "chat");
    this.broadcastState();
  }

  startStroke(playerId: string, stroke: Stroke): void {
    if (!this.isDrawer(playerId) || !this.isValidStroke(stroke)) return;
    if (this.strokes.some((item) => item.id === stroke.id)) return;
    this.strokes.push({ ...stroke, points: stroke.points.slice(0, 1) });
    this.io.to(this.id).emit("draw:started", this.strokes[this.strokes.length - 1]);
  }

  addStrokePoint(playerId: string, strokeId: string, point: Point): void {
    if (!this.isDrawer(playerId) || !this.validPoint(point)) return;
    const stroke = this.strokes[this.strokes.length - 1];
    if (!stroke || stroke.id !== strokeId || stroke.points.length >= 4000) return;
    stroke.points.push(point);
    this.io.to(this.id).emit("draw:point-added", { strokeId, point });
  }

  endStroke(playerId: string, strokeId: string): void {
    if (!this.isDrawer(playerId)) return;
    if (this.strokes[this.strokes.length - 1]?.id === strokeId) this.io.to(this.id).emit("draw:ended", strokeId);
  }

  undo(playerId: string): void {
    if (!this.isDrawer(playerId) || this.strokes.length === 0) return;
    const stroke = this.strokes.pop();
    if (stroke) this.io.to(this.id).emit("draw:undone", stroke.id);
    this.broadcastState();
  }

  clearCanvas(playerId: string): void {
    if (!this.isDrawer(playerId)) return;
    this.strokes.length = 0;
    this.io.to(this.id).emit("draw:cleared");
    this.broadcastState();
  }

  removePlayer(playerId: string): boolean {
    const wasDrawer = this.drawerId === playerId && this.phase !== "lobby" && this.phase !== "finished";
    this.players.delete(playerId);
    if (this.players.size === 0) {
      this.dispose();
      this.io.to(this.id).emit("room:removed");
      return true;
    }
    if (this.hostId === playerId) {
      this.hostId = this.players.keys().next().value as string;
      for (const player of this.players.values()) player.ready = false;
    }
    this.turnOrder = this.turnOrder.filter((id) => id !== playerId);
    this.broadcastState();
    if (this.phase !== "lobby" && this.phase !== "finished" && this.players.size < 2) {
      this.finishGame();
    } else if (wasDrawer) {
      this.endTurn();
    }
    return false;
  }

  snapshotFor(playerId: string): RoomSnapshot {
    const currentDrawer = this.drawerId === playerId;
    const revealWord = this.phase === "round-ended" || this.phase === "finished";
    return {
      roomId: this.id,
      isPrivate: this.isPrivate,
      settings: this.settings,
      players: [...this.players.values()].map((player) => ({ ...player })),
      hostId: this.hostId,
      phase: this.phase,
      roundNumber: this.turnOrder.length ? Math.min(this.settings.rounds, Math.floor(this.turnIndex / this.turnOrder.length) + 1) : 1,
      totalTurns: this.turnOrder.length * this.settings.rounds,
      turnNumber: Math.min(this.turnIndex + 1, this.turnOrder.length * this.settings.rounds),
      drawerId: this.drawerId,
      word: currentDrawer || revealWord ? this.activeWord : null,
      wordHint: this.activeWord && this.settings.wordMode !== "hidden" && !currentDrawer
        ? getHint(this.activeWord, this.revealedLetters)
        : "",
      timeLeft: this.phase === "drawing" ? Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000)) : 0,
      strokes: this.strokes,
      messages: this.messages,
      lastWord: this.lastWord,
      winnerId: this.winnerId,
    };
  }

  publicSummary(): PublicRoom {
    return {
      roomId: this.id,
      players: this.players.size,
      maxPlayers: this.settings.maxPlayers,
      rounds: this.settings.rounds,
      drawTime: this.settings.drawTime,
    };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
  }

  private beginTurn(): void {
    if (this.turnIndex >= this.turnOrder.length * this.settings.rounds) return this.finishGame();
    let attempts = 0;
    while (!this.players.has(this.turnOrder[this.turnIndex % this.turnOrder.length]) && attempts < this.turnOrder.length) {
      this.turnIndex += 1;
      attempts += 1;
      if (this.turnIndex >= this.turnOrder.length * this.settings.rounds) return this.finishGame();
    }
    this.drawerId = this.turnOrder[this.turnIndex % this.turnOrder.length];
    this.phase = "choosing";
    this.activeWord = null;
    this.lastWord = null;
    this.revealedLetters = 0;
    this.guessedPlayers.clear();
    this.strokes.length = 0;
    for (const player of this.players.values()) player.guessed = false;
    this.wordOptions = chooseWords(this.settings.wordCount, this.settings.wordMode);
    this.broadcastState();
    this.io.to(this.drawerId).emit("room:word-options", this.wordOptions);
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.phase !== "drawing" || !this.activeWord) return;
      const elapsed = this.settings.drawTime - Math.max(0, (this.turnDeadline - Date.now()) / 1000);
      const interval = this.settings.drawTime / (this.settings.hints + 1);
      const revealed = Math.min(this.settings.hints, Math.floor(elapsed / interval));
      if (revealed !== this.revealedLetters) this.revealedLetters = revealed;
      this.broadcastState();
      if (Date.now() >= this.turnDeadline) this.endTurn();
    }, 1000);
  }

  private endTurn(): void {
    if (this.phase !== "drawing" && this.phase !== "choosing") return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lastWord = this.activeWord;
    this.phase = "round-ended";
    this.addSystemMessage(this.activeWord ? `The word was ${this.activeWord}.` : "The drawer left before choosing a word.");
    this.broadcastState();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = undefined;
      if (this.phase !== "round-ended") return;
      this.turnIndex += 1;
      this.beginTurn();
    }, 3500);
  }

  private finishGame(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.timer = undefined;
    this.transitionTimer = undefined;
    this.phase = "finished";
    const highest = Math.max(...[...this.players.values()].map((player) => player.score));
    this.winnerId = [...this.players.values()].find((player) => player.score === highest)?.id ?? null;
    this.addSystemMessage("Game over! Check the final leaderboard.");
    this.broadcastState();
  }

  private addMessage(player: Player, text: string, kind: ChatMessage["kind"]): void {
    this.messages.push({
      id: randomUUID(),
      playerId: player.id,
      playerName: player.name,
      text,
      kind,
      createdAt: Date.now(),
    });
    if (this.messages.length > 80) this.messages.shift();
  }

  private addSystemMessage(text: string): void {
    this.messages.push({
      id: randomUUID(),
      playerId: "system",
      playerName: "Doodle Dash",
      text,
      kind: "system",
      createdAt: Date.now(),
    });
    if (this.messages.length > 80) this.messages.shift();
  }

  private broadcastState(): void {
    for (const playerId of this.players.keys()) {
      this.io.to(playerId).emit("room:state", this.snapshotFor(playerId));
    }
  }

  private error(playerId: string, message: string): void {
    this.io.to(playerId).emit("room:error", message);
  }

  private isDrawer(playerId: string): boolean {
    return this.phase === "drawing" && this.drawerId === playerId;
  }

  private validPoint(point: Point): boolean {
    return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
  }

  private isValidStroke(stroke: Stroke): boolean {
    return typeof stroke.id === "string" && stroke.id.length <= 64
      && (stroke.tool === "pen" || stroke.tool === "eraser")
      && typeof stroke.color === "string" && /^#[\da-f]{6}$/i.test(stroke.color)
      && Number.isFinite(stroke.size) && stroke.size >= 1 && stroke.size <= 40
      && Array.isArray(stroke.points) && stroke.points.length > 0 && this.validPoint(stroke.points[0]);
  }

  private normalizeGuess(value: string): string {
    return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[.!?]+$/u, "");
  }
}

export function createPlayer(id: string, name: string, index: number): Player {
  return {
    id,
    name: name.trim().slice(0, 18),
    color: playerColors[index % playerColors.length],
    score: 0,
    ready: false,
    guessed: false,
  };
}
