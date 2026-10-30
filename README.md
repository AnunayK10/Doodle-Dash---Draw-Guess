# Doodle-Dash---Draw-Guess

A real-time multiplayer drawing and guessing game built with React, TypeScript, Express, Socket.IO, and the HTML canvas API. Create rooms, draw, guess, score points, and compete with friends online.

## Game description

Doodle Dash is a browser-based multiplayer drawing and guessing game inspired by classic party games. Players meet in a shared room, take turns drawing a secret word, and race to guess what the artist is sketching. The quicker a player guesses, the more points they can earn. At the end of the game, the player with the highest score is crowned the winner.

### How to play

1. **Choose a name.** Enter a player name to create a room or join a friend's room.
2. **Create or join a room.** Create an open room that appears in the public lobby, or make a private room and invite people using its code or link.
3. **Get the group ready.** At least two players must join. Each player marks themselves ready, and the host starts the game when everyone is ready.
4. **Take turns as the artist.** The current drawer privately receives a selection of words and chooses one before the drawing timer starts. The word stays secret from everyone else.
5. **Draw and guess in real time.** The artist draws on a shared canvas. Other players submit guesses in chat, and drawings, messages, and game updates are synchronized live.
6. **Earn points.** Guesses are trimmed, normalized, and compared without regard to letter case; trailing punctuation is ignored. A correct guess earns points based on the time remaining, and the drawer earns points when a player guesses correctly. Partial-word guesses do not count.
7. **Finish the rounds.** A turn ends when all guessers have solved the word or the drawing timer runs out. The word is then revealed, scores update, and the drawer rotates to the next player.
8. **See the results.** After every configured turn is finished, the game displays the final leaderboard and winner.

### Rooms and game settings

- **Public rooms** appear in the open-room list while they are waiting for players. **Private rooms** do not appear in that list and require their room code or invitation link to join.
- Room settings let the host configure the maximum player count (2–12), number of rounds (2–20), drawing time (15–240 seconds), word choices per turn (1–5), and hint count (0–5).
- **Normal** word mode displays letter blanks to guessers. Configured hints reveal letters over time.
- **Hidden** word mode hides the letter pattern from guessers.
- **Combination** word mode offers phrases made up of multiple words.
- If every guesser solves the word before time runs out, the round ends early. Otherwise, the countdown ends the round and the word is revealed.

### Drawing, chat, and scoring

- The artist draws using a shared canvas with selectable colors, adjustable brush size, and an eraser.
- The drawer can undo their latest stroke or clear the canvas. These actions are synchronized for everyone in the room.
- During a round, guessers submit word guesses in chat. Incorrect guesses are visible to the room; correct guesses are announced and award points.
- Faster correct guesses are worth more points. The active drawer also earns points when another player guesses correctly.
- The scoreboard tracks player points and turn progress throughout the game. The final screen presents players in score order and identifies the winner.
- A player can share a room link or code to invite others and can leave the room. When the host leaves the lobby, another player becomes host; disconnects during a game are handled by the server.

### Themes and interface

- The interface supports both light and night themes.
- The theme switcher is available in the lobby, game, and results screens. The selected theme is saved in the browser and restored after a reload.
- The layout adapts to smaller screens, with the lobby, drawing canvas, leaderboard, and chat arranged for mobile play.

## Run locally

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). The backend runs on port `3001`. To build and serve the production app locally, run:

```bash
npm run build
npm start
```

The production server serves the frontend and API on port `3001`. Set `PORT` to change the server port. `CLIENT_URL` can be set to the frontend origin when hosting the frontend separately.

## Test the REST API with Thunder Client

Start the backend with `npm run dev`, then in VS Code open Thunder Client and import `.vscode/thunder-collection_Doodle Dash Server.json` as a Thunder Client collection. Send **Health check** (`GET http://localhost:3001/api/health`) and **List public rooms** (`GET http://localhost:3001/api/rooms`). The health response should include `"status": "ok"`; the public-room endpoint returns an array. Game actions and multiplayer synchronization use Socket.IO rather than REST requests.

## Play

Create a public or private room, share the room code or invite link, then have at least two players join and ready up. The host can start once everyone is ready. The drawer chooses a word; other players draw or guess until the timer ends or every guesser has guessed correctly. Turns rotate through each player for the configured number of rounds.

Room settings include player limit, rounds, draw duration, word choices, hints, and word mode. Public rooms are listed in the lobby; private rooms can only be joined with their code. In Normal mode, guessers see letter blanks and configured hints reveal letters over time. Hidden mode conceals the blank pattern. Combination mode uses multi-word phrases. Guesses are compared after Unicode normalization, trimming, lowercasing, and removal of trailing punctuation; matching is exact, not partial.

## Architecture

- `frontend/` contains the responsive React application, lobby, room/game screens, chat, scoreboard, and canvas drawing tools.
- `backend/` contains the Express health endpoint and the Socket.IO server. The `Room` class owns room membership, game phases, turn rotation, timers, hint reveals, chat, and scoring. Clients never receive the secret word except for the drawer and the end-of-round reveal.
- The HTML canvas stores strokes as normalized coordinates, so drawings scale with the board. The drawer streams stroke starts and points through Socket.IO; the server validates the active drawer and broadcasts accepted updates to the room. Undo and clear are likewise authorized and synchronized by the server.
- Game state and guesses are authoritative on the backend; socket disconnects update membership and progress or end an unplayable game cleanly.
- Rooms, scores, chat, and drawings are held in server memory; there is no database in this assignment, so a server restart clears active games.

## Deployment

`render.yaml` configures a single Render web service. Connect this repository to Render and deploy using the included Blueprint. Render builds both workspaces and the backend serves the compiled frontend, API, and WebSocket endpoint from the same origin. A WebSocket-capable host is required; this app is not suitable for a serverless-only deployment that cannot keep Socket.IO connections open.

Live URL: _Add the deployed URL here after publishing the service._
