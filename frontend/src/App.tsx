import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { io, type Socket } from "socket.io-client";
import {
  ArrowLeft, ArrowRight, Brush, Check, ChevronDown, CircleHelp, Clock3, Copy, Crown, Eraser,
  EyeOff, Link2, LoaderCircle, LockKeyhole, MessageCircle, Moon, Paintbrush, Palette, PenLine, Plus,
  RotateCcw, Send, Sparkles, Sun, Trophy, Users, WandSparkles, X,
} from "lucide-react";
import type { ChatMessage, ClientToServerEvents, Player, Point, PublicRoom, RoomSettings, RoomSnapshot, ServerToClientEvents, Stroke } from "./types";

const colors = ["#20242c", "#f15b3c", "#f4a62a", "#f2d13d", "#52a675", "#32a6a0", "#4d83df", "#8d66d6", "#e36a9a", "#ffffff"];
const defaults: RoomSettings = { maxPlayers: 8, rounds: 3, drawTime: 80, wordCount: 3, hints: 2, wordMode: "normal" };

function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  return io(import.meta.env.VITE_SOCKET_URL || undefined, { transports: ["websocket", "polling"] }) as Socket<ServerToClientEvents, ClientToServerEvents>;
}

function CanvasBoard({
  strokes,
  canDraw,
  color,
  brushSize,
  tool,
  socket,
}: {
  strokes: Stroke[];
  canDraw: boolean;
  color: string;
  brushSize: number;
  tool: "pen" | "eraser";
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeStrokeRef = useRef<string | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(bounds.width * ratio) || canvas.height !== Math.round(bounds.height * ratio)) {
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    for (const stroke of strokes) {
      if (!stroke.points.length) continue;
      context.save();
      context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.size;
      context.lineCap = "round";
      context.lineJoin = "round";
      const first = stroke.points[0];
      if (stroke.points.length === 1) {
        context.beginPath();
        context.arc(first.x * bounds.width, first.y * bounds.height, stroke.size / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(first.x * bounds.width, first.y * bounds.height);
        for (const point of stroke.points.slice(1)) context.lineTo(point.x * bounds.width, point.y * bounds.height);
        context.stroke();
      }
      context.restore();
    }
  }, [strokes]);

  useEffect(() => {
    redraw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canDraw) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    const id = crypto.randomUUID();
    activeStrokeRef.current = id;
    socket.emit("draw:start", { id, points: [point], color, size: brushSize, tool });
  };

  const moveStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const strokeId = activeStrokeRef.current;
    if (!canDraw || !strokeId || event.buttons === 0) return;
    socket.emit("draw:point", { strokeId, point: pointFromEvent(event) });
  };

  const finishStroke = () => {
    const strokeId = activeStrokeRef.current;
    if (strokeId) socket.emit("draw:end", strokeId);
    activeStrokeRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className={`drawing-canvas${canDraw ? " is-drawable" : ""}`}
      onPointerDown={startStroke}
      onPointerMove={moveStroke}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
      aria-label="Shared drawing canvas"
    />
  );
}

function PlayerRow({ player, active, isHost, isSelf }: { player: Player; active: boolean; isHost: boolean; isSelf: boolean }) {
  return (
    <div className={`player-row${active ? " player-row-active" : ""}${player.guessed ? " player-row-guessed" : ""}`}>
      <div className="avatar" style={{ backgroundColor: player.color }}>{player.name.slice(0, 1).toUpperCase()}</div>
      <div className="player-name-wrap">
        <span className="player-name">{player.name}{isSelf ? <small>you</small> : null}</span>
        <span className="player-caption">{active ? "drawing now" : player.guessed ? "got it!" : isHost ? "room host" : "player"}</span>
      </div>
      {isHost ? <Crown size={15} className="host-icon" aria-label="Host" /> : null}
      <span className="player-score">{player.score.toLocaleString()}</span>
      {player.guessed ? <Check size={15} className="guessed-check" /> : null}
    </div>
  );
}

export default function App() {
  const socket = useMemo(getSocket, []);
  const [theme, setTheme] = useState<"light" | "night">(() => {
    const storedTheme = localStorage.getItem("doodle-theme");
    return storedTheme === "night" ? "night" : "light";
  });
  const [connected, setConnected] = useState(socket.connected);
  const [name, setName] = useState(() => localStorage.getItem("doodle-name") ?? "");
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "");
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [settings, setSettings] = useState<RoomSettings>(defaults);
  const [privateRoom, setPrivateRoom] = useState(false);
  const [wordOptions, setWordOptions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatTab, setChatTab] = useState<"chat" | "players">("chat");
  const [selectedColor, setSelectedColor] = useState(colors[0]);
  const [brushSize, setBrushSize] = useState(6);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "night" ? "dark" : "light";
    localStorage.setItem("doodle-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((current) => current === "light" ? "night" : "light");

  const refreshRooms = useCallback(() => {
    socket.emit("room:list", (items) => setRooms(items));
  }, [socket]);

  useEffect(() => {
    const onConnect = () => { setConnected(true); refreshRooms(); };
    const onDisconnect = () => setConnected(false);
    const onState = (state: RoomSnapshot) => {
      setRoom(state);
      setRoomCode(state.roomId);
      const query = state.phase === "finished" ? "" : `?room=${state.roomId}`;
      history.replaceState(null, "", `${location.pathname}${query}`);
    };
    const onError = (message: string) => {
      setError(message);
      window.setTimeout(() => setError(""), 4500);
    };
    const onOptions = (options: string[]) => setWordOptions(options);
    const onStarted = (stroke: Stroke) => setRoom((current) => current ? { ...current, strokes: [...current.strokes, stroke] } : current);
    const onPointAdded = ({ strokeId, point }: { strokeId: string; point: Point }) => {
      setRoom((current) => current ? {
        ...current,
        strokes: current.strokes.map((stroke) => stroke.id === strokeId ? { ...stroke, points: [...stroke.points, point] } : stroke),
      } : current);
    };
    const onUndone = (strokeId: string) => setRoom((current) => current ? { ...current, strokes: current.strokes.filter((stroke) => stroke.id !== strokeId) } : current);
    const onCleared = () => setRoom((current) => current ? { ...current, strokes: [] } : current);
    const onGuessResult = ({ playerId, correct }: { playerId: string; correct: boolean; points: number }) => {
      if (correct && playerId === socket.id) {
        setToast("Nice guess! Points added to your score.");
        window.setTimeout(() => setToast(""), 2600);
      }
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", () => setError("Couldn't connect to the game server. Please try again."));
    socket.on("room:state", onState);
    socket.on("room:error", onError);
    socket.on("room:word-options", onOptions);
    socket.on("draw:started", onStarted);
    socket.on("draw:point-added", onPointAdded);
    socket.on("draw:undone", onUndone);
    socket.on("draw:cleared", onCleared);
    socket.on("game:guess-result", onGuessResult);
    if (!socket.connected) socket.connect();
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:state", onState);
      socket.off("room:error", onError);
      socket.off("room:word-options", onOptions);
      socket.off("draw:started", onStarted);
      socket.off("draw:point-added", onPointAdded);
      socket.off("draw:undone", onUndone);
      socket.off("draw:cleared", onCleared);
      socket.off("game:guess-result", onGuessResult);
      socket.disconnect();
    };
  }, [socket]);

  useEffect(() => {
    const interval = window.setInterval(refreshRooms, 5000);
    return () => window.clearInterval(interval);
  }, [refreshRooms]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.messages.length]);

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Add your name before creating a room.");
    localStorage.setItem("doodle-name", name.trim());
    socket.emit("room:create", { name: name.trim(), settings, isPrivate: privateRoom }, (result) => {
      if (!result.ok) setError(result.error ?? "Couldn't create the room.");
    });
  };

  const submitJoin = (code = roomCode) => {
    if (!name.trim()) return setError("Add your name before joining a room.");
    localStorage.setItem("doodle-name", name.trim());
    socket.emit("room:join", { roomId: code.trim().toUpperCase(), name: name.trim() }, (result) => {
      if (!result.ok) setError(result.error ?? "Couldn't join the room.");
    });
  };

  const leaveRoom = () => {
    socket.emit("room:leave");
    setRoom(null);
    setWordOptions([]);
    history.replaceState(null, "", location.pathname);
    refreshRooms();
  };

  const copyInvite = async () => {
    if (!room) return;
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room.roomId}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    if (!chatText.trim()) return;
    if (room?.phase === "drawing" && room.drawerId !== socket.id) socket.emit("chat:send", chatText);
    else socket.emit("chat:send", chatText);
    setChatText("");
  };

  const isHost = !!room && room.hostId === socket.id;
  const isDrawer = !!room && room.drawerId === socket.id;
  const me = room?.players.find((player) => player.id === socket.id);

  if (!room) {
    return (
      <main className="landing-shell">
        <header className="topbar">
          <a className="brand" href="#" onClick={(event) => event.preventDefault()}><span className="brand-mark"><Paintbrush size={19} /></span> doodle<span>dash</span></a>
          <div className="topbar-actions"><div className={`connection-pill${connected ? " online" : ""}`}><span className="connection-dot" />{connected ? "Servers are up" : "Connecting..."}</div><ThemeSwitcher theme={theme} onToggle={toggleTheme} /></div>
        </header>
        <section className="hero-section">
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={14} /> THE DRAWING GAME FOR EVERYONE</div>
            <h1>One draws.<br /><span>Everyone</span> guesses.</h1>
            <p className="hero-description">Grab a pencil, invite your people, and see who can turn a few squiggles into a masterpiece. Probably not you. That's the fun part.</p>
            <div className="hero-proof"><div className="mini-avatars"><i>J</i><i>M</i><i>A</i><i>+</i></div><span>Made for game nights, group chats & friendly chaos</span></div>
          </div>
          <div className="play-card">
            <div className="card-title-row"><div><span className="section-kicker">JUMP RIGHT IN</span><h2>Let's play</h2></div><div className="card-spark"><WandSparkles size={19} /></div></div>
            <label className="field-label" htmlFor="player-name">YOUR NAME</label>
            <input id="player-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="What should we call you?" maxLength={18} />
            <button type="button" className="settings-toggle" onClick={() => setShowSettings((value) => !value)}>
              <span><SlidersIcon /> Room settings</span><ChevronDown size={16} className={showSettings ? "rotate" : ""} />
            </button>
            {showSettings ? (
              <div className="settings-panel">
                <div className="setting-grid">
                  <label>Players <select value={settings.maxPlayers} onChange={(e) => setSettings({ ...settings, maxPlayers: Number(e.target.value) })}>{[2, 4, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n} players</option>)}</select></label>
                  <label>Rounds <select value={settings.rounds} onChange={(e) => setSettings({ ...settings, rounds: Number(e.target.value) })}>{[2, 3, 5, 8, 10, 15, 20].map((n) => <option key={n} value={n}>{n} rounds</option>)}</select></label>
                  <label>Draw time <select value={settings.drawTime} onChange={(e) => setSettings({ ...settings, drawTime: Number(e.target.value) })}>{[30, 45, 60, 80, 120, 180, 240].map((n) => <option key={n} value={n}>{n} sec</option>)}</select></label>
                  <label>Word choices <select value={settings.wordCount} onChange={(e) => setSettings({ ...settings, wordCount: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} choices</option>)}</select></label>
                  <label>Hints <select value={settings.hints} onChange={(e) => setSettings({ ...settings, hints: Number(e.target.value) })}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "No hints" : `${n} hints`}</option>)}</select></label>
                  <label>Word mode <select value={settings.wordMode} onChange={(e) => setSettings({ ...settings, wordMode: e.target.value as RoomSettings["wordMode"] })}><option value="normal">Normal</option><option value="hidden">Hidden</option><option value="combination">Combination</option></select></label>
                </div>
              </div>
            ) : null}
            <label className="private-toggle"><input type="checkbox" checked={privateRoom} onChange={(event) => setPrivateRoom(event.target.checked)} /><span className="custom-checkbox">{privateRoom ? <Check size={12} /> : null}</span><span><LockKeyhole size={14} /> Make this room invite-only</span></label>
            <button className="primary-button create-button" onClick={submitCreate}><Plus size={17} /> Create a room <ArrowRight size={16} /></button>
            <div className="form-divider"><span>or join your friends</span></div>
            <div className="join-row"><input className="text-input code-input" value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="ENTER ROOM CODE" maxLength={6} onKeyDown={(event) => { if (event.key === "Enter") submitJoin(); }} /><button className="join-button" onClick={() => submitJoin()} aria-label="Join room"><ArrowRight size={18} /></button></div>
            {error ? <div className="error-message"><CircleHelp size={15} />{error}</div> : null}
          </div>
        </section>
        <section className="public-rooms">
          <div className="rooms-heading"><div><span className="section-kicker">OPEN TABLES</span><h2>Find your next game</h2></div><span className="live-count"><i /> {rooms.length} {rooms.length === 1 ? "room" : "rooms"} open</span></div>
          {rooms.length ? <div className="rooms-list">{rooms.map((item) => <div className="room-card" key={item.roomId}><div className="room-card-icon"><Users size={18} /></div><div className="room-card-info"><strong>Room {item.roomId}</strong><span>{item.rounds} rounds · {item.drawTime}s drawing</span></div><span className="room-capacity">{item.players}/{item.maxPlayers} players</span><button className="room-join" disabled={item.players >= item.maxPlayers} onClick={() => submitJoin(item.roomId)}>Join <ArrowRight size={14} /></button></div>)}</div> : <div className="empty-rooms"><div className="empty-doodle"><PenLine size={21} /></div><div><strong>No open rooms just yet</strong><p>Start one and your friends can join with a code.</p></div></div>}
        </section>
        <footer className="landing-footer"><span>© 2025 doodledash</span><span>DRAW A LITTLE. LAUGH A LOT.</span><span><i className="footer-status" /> Built for good times</span></footer>
        {error ? <div className="toast error-toast"><CircleHelp size={16} />{error}<button onClick={() => setError("")}><X size={15} /></button></div> : null}
      </main>
    );
  }

  if (room.phase === "finished") {
    const leaderboard = [...room.players].sort((a, b) => b.score - a.score);
    const winner = room.players.find((player) => player.id === room.winnerId);
    return (
      <main className="results-page">
        <header className="game-topbar"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); leaveRoom(); }}><span className="brand-mark"><Paintbrush size={19} /></span> doodle<span>dash</span></a><div className="topbar-actions"><ThemeSwitcher theme={theme} onToggle={toggleTheme} /><button className="quiet-button" onClick={leaveRoom}><ArrowLeft size={16} /> Back to lobby</button></div></header>
        <section className="results-card">
          <div className="trophy-orb"><Trophy size={30} /></div><span className="eyebrow">THAT'S A WRAP</span><h1>{winner?.name ?? "Everyone"} <span>takes the crown!</span></h1><p>Thanks for making a little art and a lot of memories.</p>
          <div className="final-board">{leaderboard.map((player, index) => <div className={`final-row${index === 0 ? " first-place" : ""}`} key={player.id}><span className="rank-number">{String(index + 1).padStart(2, "0")}</span><div className="avatar" style={{ background: player.color }}>{player.name.slice(0, 1).toUpperCase()}</div><strong>{player.name}{index === 0 ? <Crown size={15} /> : null}</strong><span>{player.score.toLocaleString()} pts</span></div>)}</div>
          <button className="primary-button results-button" onClick={leaveRoom}>Play another round <ArrowRight size={16} /></button>
        </section>
      </main>
    );
  }

  const currentDrawer = room.players.find((player) => player.id === room.drawerId);
  const canDraw = isDrawer && room.phase === "drawing";
  const readyCount = room.players.filter((player) => player.ready).length;
  const handleChat = sendChat;

  return (
    <main className="game-page">
      <header className="game-topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); leaveRoom(); }}><span className="brand-mark"><Paintbrush size={19} /></span> doodle<span>dash</span></a>
        <div className="room-meta"><span className={`room-privacy${room.isPrivate ? " is-private" : ""}`}>{room.isPrivate ? <LockKeyhole size={13} /> : <Users size={14} />}{room.isPrivate ? "Private room" : "Open room"}</span><span className="meta-divider" /><span className="room-code-label">ROOM CODE</span><button className="room-code" onClick={copyInvite}>{room.roomId}<Copy size={13} /></button>{copied ? <span className="copied-label">Copied!</span> : null}</div>
        <div className="topbar-actions"><ThemeSwitcher theme={theme} onToggle={toggleTheme} /><button className="quiet-button leave-button" onClick={leaveRoom}><ArrowLeft size={16} /> Leave game</button></div>
      </header>
      {room.phase === "lobby" ? (
        <section className="lobby-layout">
          <div className="lobby-main">
            <div className="lobby-intro"><div className="lobby-illustration"><div className="illustration-sheet"><span /><span /><span /><i /></div><div className="illustration-pencil"><PenLine size={28} /></div></div><div><span className="eyebrow">ROOM {room.roomId}</span><h1>Make yourself<br /><span>at home.</span></h1><p>Invite your favorite people, then let's get drawing.</p></div></div>
            <div className="lobby-players-header"><div><h2>Who's here <span>{room.players.length}/{room.settings.maxPlayers}</span></h2><p>{readyCount} of {room.players.length} ready to play</p></div><button className="invite-button" onClick={copyInvite}><Link2 size={15} /> Invite friends</button></div>
            <div className="lobby-players">{room.players.map((player) => <div className="lobby-player" key={player.id}><div className="avatar" style={{ background: player.color }}>{player.name.slice(0, 1).toUpperCase()}</div><div className="lobby-player-name"><strong>{player.name}{player.id === socket.id ? <small>you</small> : null}</strong><span>{player.id === room.hostId ? "Room host" : player.ready ? "Ready to play" : "Picking a playlist..."}</span></div>{player.id === room.hostId ? <Crown size={16} className="host-icon" /> : player.ready ? <span className="ready-badge"><Check size={12} /> Ready</span> : null}</div>)}
              {Array.from({ length: Math.min(3, room.settings.maxPlayers - room.players.length) }).map((_, index) => <div className="lobby-player waiting-player" key={`empty-${index}`}><div className="avatar waiting-avatar"><Plus size={15} /></div><div className="lobby-player-name"><strong>Waiting for a friend</strong><span>Share your room code to invite</span></div></div>)}
            </div>
            <div className="lobby-bottom"><div className="ready-note"><span className="ready-dot" />{room.players.length < 2 ? "At least 2 players to start" : readyCount === room.players.length ? "Everyone's ready. Game on!" : "Waiting for everyone to ready up"}</div><div className="lobby-actions">{!isHost ? <button className={`ready-button${me?.ready ? " is-ready" : ""}`} onClick={() => socket.emit("room:ready", !me?.ready)}>{me?.ready ? <><Check size={16} /> You're ready!</> : <>I'm ready <ArrowRight size={16} /></>}</button> : <button className="ready-button host-ready" onClick={() => socket.emit("room:ready", !me?.ready)}>{me?.ready ? <><Check size={16} /> Ready</> : "Ready up"}</button>}{isHost ? <button className="primary-button start-button" disabled={room.players.length < 2 || readyCount !== room.players.length} onClick={() => socket.emit("room:start")}>Start game <ArrowRight size={16} /></button> : null}</div></div>
          </div>
          <aside className="lobby-aside"><div className="aside-heading"><span className="section-kicker">THE PLAN</span><h3>Game settings</h3></div><div className="settings-summary"><SummaryItem icon={<Users size={16} />} label="Players" value={`${room.players.length} / ${room.settings.maxPlayers}`} /><SummaryItem icon={<RotateCcw size={16} />} label="Rounds" value={`${room.settings.rounds} rounds`} /><SummaryItem icon={<Clock3 size={16} />} label="Drawing time" value={`${room.settings.drawTime} seconds`} /><SummaryItem icon={<Palette size={16} />} label="Word choices" value={`${room.settings.wordCount} per turn`} /><SummaryItem icon={<Sparkles size={16} />} label="Hints" value={room.settings.hints ? `${room.settings.hints} hints` : "No hints"} /><SummaryItem icon={<EyeOff size={16} />} label="Word mode" value={room.settings.wordMode} />{room.isPrivate ? <SummaryItem icon={<LockKeyhole size={16} />} label="Privacy" value="Invite only" /> : null}</div><div className="how-to-card"><div className="how-to-icon"><WandSparkles size={17} /></div><strong>How to play</strong><p>Take turns drawing a secret word while everyone else races to guess it. The quicker you guess, the more points you get!</p><div className="how-to-link">No art degree required <Sparkles size={13} /></div></div><button className="copy-link-button" onClick={copyInvite}><Copy size={15} /> {copied ? "Invite link copied" : "Copy invite link"}</button></aside>
        </section>
      ) : (
        <section className="game-layout">
          <aside className="score-panel">
            <div className="score-heading"><div><span className="section-kicker">THE LEADERBOARD</span><h2>Players <span>{room.players.length}</span></h2></div><Trophy size={19} /></div>
            <div className="score-list">{[...room.players].sort((a, b) => b.score - a.score).map((player) => <PlayerRow key={player.id} player={player} active={player.id === room.drawerId && room.phase !== "round-ended"} isHost={player.id === room.hostId} isSelf={player.id === socket.id} />)}</div>
            <div className="score-footer"><span>ROUND</span><strong>{room.roundNumber}<i> / {room.settings.rounds}</i></strong></div>
            <div className="turn-progress"><span style={{ width: `${room.totalTurns ? (room.turnNumber / room.totalTurns) * 100 : 0}%` }} /></div>
            <span className="turn-caption">TURN {room.turnNumber} OF {room.totalTurns}</span>
          </aside>
          <div className="play-area">
            <div className="round-banner">
              <div className="round-info"><div className={`round-avatar${currentDrawer ? "" : " waiting"}`} style={currentDrawer ? { background: currentDrawer.color } : undefined}>{currentDrawer?.name.slice(0, 1).toUpperCase() ?? <LoaderCircle size={16} />}</div><div><span className="round-caption">{room.phase === "choosing" ? `${currentDrawer?.name ?? "Drawer"} is choosing` : room.phase === "round-ended" ? "Round complete" : "NOW DRAWING"}</span><strong>{room.phase === "choosing" ? "Pick a word to draw" : room.phase === "round-ended" ? `${currentDrawer?.name ?? "The drawer"} finished their turn` : isDrawer ? "Your turn to draw!" : `${currentDrawer?.name ?? "Someone"} is drawing`}</strong></div></div>
              <div className={`timer-pill${room.timeLeft <= 10 && room.phase === "drawing" ? " timer-warning" : ""}`}><Clock3 size={15} /><strong>{room.phase === "drawing" ? `${room.timeLeft}s` : room.phase === "choosing" ? "···" : "—"}</strong></div>
            </div>
            {room.phase === "choosing" ? <div className="word-picker"><span className="section-kicker">YOUR SECRET WORD</span><h2>Choose one to draw</h2><p>Your friends will only see the blanks. No pressure.</p><div className="word-options">{wordOptions.map((word) => <button key={word} onClick={() => { socket.emit("game:choose-word", word); setWordOptions([]); }}><span>{word.length} letters</span><strong>{word}</strong><ArrowRight size={15} /></button>)}</div></div> : null}
            <div className={`drawing-stage${room.phase === "choosing" ? " choosing-stage" : ""}`}>
              <div className="word-display">{room.phase === "choosing" ? <span>THE CANVAS IS ALL YOURS</span> : room.phase === "round-ended" ? <>The word was <strong>{room.lastWord}</strong></> : isDrawer ? <>Your word is <strong>{room.word}</strong><span className="drawer-private">Keep it secret!</span></> : room.wordHint ? <><span>GUESS THE WORD</span><strong className="word-blanks">{room.wordHint}</strong></> : room.phase === "drawing" ? <><span>GUESS THE WORD</span><strong className="word-blanks">???</strong></> : <span>GET READY</span>}</div>
              <div className="canvas-wrap"><CanvasBoard strokes={room.strokes} canDraw={canDraw} color={tool === "eraser" ? "#ffffff" : selectedColor} brushSize={tool === "eraser" ? 22 : brushSize} tool={tool} socket={socket} />{room.phase === "round-ended" ? <div className="round-ended-overlay"><div className="round-ended-icon"><Check size={21} /></div><strong>Nice round!</strong><span>Next artist is warming up…</span></div> : null}{room.phase === "choosing" ? <div className="waiting-overlay"><div className="waiting-pencil"><PenLine size={21} /></div><strong>Getting the canvas ready</strong><span>Waiting for {currentDrawer?.name} to pick a word</span></div> : null}</div>
              {canDraw ? <div className="drawing-toolbar"><div className="tool-buttons"><button className={tool === "pen" ? "tool-active" : ""} title="Brush" onClick={() => setTool("pen")}><Brush size={17} /></button><button className={tool === "eraser" ? "tool-active" : ""} title="Eraser" onClick={() => setTool("eraser")}><Eraser size={17} /></button><span className="toolbar-divider" /><button title="Undo last stroke" onClick={() => socket.emit("draw:undo")}><RotateCcw size={16} /></button><button title="Clear canvas" onClick={() => socket.emit("draw:clear")}><X size={17} /></button></div><div className="color-swatches">{colors.map((item) => <button key={item} title={item} className={`color-swatch${selectedColor === item && tool === "pen" ? " selected" : ""}`} style={{ background: item }} onClick={() => { setSelectedColor(item); setTool("pen"); }} />)}</div><label className="brush-size"><span>SIZE</span><input type="range" min="2" max="18" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><i>{brushSize}</i></label></div> : null}
            </div>
            <div className="game-hint"><Sparkles size={14} /><span>{isDrawer ? "Make it recognizable, but don't write the word!" : room.phase === "drawing" ? "Type your guess in the chat. The faster you are, the more you score!" : "Get ready to guess the next word."}</span></div>
          </div>
          <aside className="chat-panel"><div className="chat-tabs"><button className={chatTab === "chat" ? "tab-active" : ""} onClick={() => setChatTab("chat")}><MessageCircle size={15} /> Chat <span>{room.messages.length}</span></button><button className={chatTab === "players" ? "tab-active" : ""} onClick={() => setChatTab("players")}><Users size={15} /> Players</button></div>{chatTab === "chat" ? <><div className="chat-messages">{room.messages.map((message) => <ChatRow key={message.id} message={message} self={message.playerId === socket.id} />)}<div ref={chatEndRef} /></div><form className="chat-form" onSubmit={handleChat}><input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder={room.phase === "drawing" && !isDrawer ? "Take a guess…" : "Say something nice…"} maxLength={180} /><button type="submit" disabled={!chatText.trim()} aria-label="Send message"><Send size={16} /></button><span className="chat-privacy">{room.phase === "drawing" && !isDrawer ? "Your guesses are public" : "Be nice to each other"}</span></form></> : <div className="chat-player-list">{[...room.players].sort((a, b) => b.score - a.score).map((player) => <PlayerRow key={player.id} player={player} active={player.id === room.drawerId} isHost={player.id === room.hostId} isSelf={player.id === socket.id} />)}</div>}</aside>
        </section>
      )}
      {error || toast ? <div className={`toast${error ? " error-toast" : ""}`}><span>{error || toast}</span><button onClick={() => { setError(""); setToast(""); }}><X size={15} /></button></div> : null}
    </main>
  );
}

function SummaryItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="summary-item"><span className="summary-icon">{icon}</span><span>{label}</span><strong>{value}</strong></div>;
}

function ThemeSwitcher({ theme, onToggle }: { theme: "light" | "night"; onToggle: () => void }) {
  const isNight = theme === "night";
  return (
    <button
      className="theme-switch"
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${isNight ? "light" : "night"} theme`}
      title={`Switch to ${isNight ? "light" : "night"} theme`}
    >
      {isNight ? <Sun size={15} /> : <Moon size={15} />}
      <span>{isNight ? "Light" : "Night"}</span>
    </button>
  );
}

function ChatRow({ message, self }: { message: ChatMessage; self: boolean }) {
  if (message.kind === "system") return <div className="system-message"><span>{message.text}</span></div>;
  if (message.kind === "correct") return <div className="correct-message"><span className="correct-star"><Check size={11} /></span><strong>{self ? "You" : message.playerName}</strong> guessed it! <Sparkles size={12} /></div>;
  return <div className={`chat-message${self ? " own-message" : ""}`}><strong style={{ color: self ? "#16a08e" : undefined }}>{self ? "You" : message.playerName}</strong><span>{message.text}</span></div>;
}

function SlidersIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4.5h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="6" cy="4.5" r="1.75" fill="white" stroke="currentColor" strokeWidth="1.5" /><circle cx="10" cy="11.5" r="1.75" fill="white" stroke="currentColor" strokeWidth="1.5" /></svg>;
}
