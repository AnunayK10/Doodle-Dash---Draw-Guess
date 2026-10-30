export type GamePhase = "lobby" | "choosing" | "drawing" | "round-ended" | "finished";
export type WordMode = "normal" | "hidden" | "combination";

export interface RoomSettings {
  maxPlayers: number;
  rounds: number;
  drawTime: number;
  wordCount: number;
  hints: number;
  wordMode: WordMode;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  score: number;
  ready: boolean;
  guessed: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  points: Point[];
  color: string;
  size: number;
  tool: "pen" | "eraser";
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  kind: "chat" | "correct" | "system";
  createdAt: number;
}

export interface RoomSnapshot {
  roomId: string;
  isPrivate: boolean;
  settings: RoomSettings;
  players: Player[];
  hostId: string;
  phase: GamePhase;
  roundNumber: number;
  totalTurns: number;
  turnNumber: number;
  drawerId: string | null;
  word: string | null;
  wordHint: string;
  timeLeft: number;
  strokes: Stroke[];
  messages: ChatMessage[];
  lastWord: string | null;
  winnerId: string | null;
}

export interface PublicRoom {
  roomId: string;
  players: number;
  maxPlayers: number;
  rounds: number;
  drawTime: number;
}

export interface CreateRoomInput {
  name: string;
  settings: RoomSettings;
  isPrivate: boolean;
}

export interface JoinRoomInput {
  roomId: string;
  name: string;
}

export interface AckResult {
  ok: boolean;
  error?: string;
  roomId?: string;
}

export interface ClientToServerEvents {
  "room:create": (input: CreateRoomInput, ack: (result: AckResult) => void) => void;
  "room:join": (input: JoinRoomInput, ack: (result: AckResult) => void) => void;
  "room:leave": () => void;
  "room:list": (ack: (rooms: PublicRoom[]) => void) => void;
  "room:ready": (ready: boolean) => void;
  "room:start": () => void;
  "game:choose-word": (word: string) => void;
  "draw:start": (stroke: Stroke) => void;
  "draw:point": (payload: { strokeId: string; point: Point }) => void;
  "draw:end": (strokeId: string) => void;
  "draw:undo": () => void;
  "draw:clear": () => void;
  "chat:send": (text: string) => void;
}

export interface ServerToClientEvents {
  "room:state": (state: RoomSnapshot) => void;
  "room:error": (message: string) => void;
  "room:removed": () => void;
  "room:word-options": (words: string[]) => void;
  "draw:started": (stroke: Stroke) => void;
  "draw:point-added": (payload: { strokeId: string; point: Point }) => void;
  "draw:ended": (strokeId: string) => void;
  "draw:undone": (strokeId: string) => void;
  "draw:cleared": () => void;
  "game:guess-result": (payload: { playerId: string; correct: boolean; points: number }) => void;
}
