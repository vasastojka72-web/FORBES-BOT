import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";

export const DANCE_ROOM = "FORBES_GLOBAL_DANCE";
export const DANCE_EXECUTION_DELAY_MS = 1500;
export const DANCE_COMMAND_COOLDOWN_MS = 2000;

const json = (socket, value) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(value)); return true; } catch { return false; }
};

export function createDanceSyncManager({ verifyToken, logger = console } = {}) {
  const rooms = new Map();
  const clientsByUser = new Map();
  const rateByUser = new Map();
  let lastCommand = null;
  let busyUntil = 0;

  const room = name => {
    if (!rooms.has(name)) rooms.set(name, new Set());
    return rooms.get(name);
  };
  const presence = name => {
    const members = room(name);
    const message = { type: "dance_presence", room: name, participantCount: members.size, serverTime: Date.now() };
    for (const client of members) json(client, message);
  };
  const leave = client => {
    if (!client.danceRoom) return;
    const name = client.danceRoom;
    room(name).delete(client);
    if (clientsByUser.get(client.danceUser?.id) === client) clientsByUser.delete(client.danceUser.id);
    client.danceRoom = "";
    logger.info?.(`[DANCE] left room user=${client.danceUser?.id || "unknown"} room=${name}`);
    presence(name);
  };
  const closeDuplicate = (userId, replacement) => {
    const previous = clientsByUser.get(userId);
    if (!previous || previous === replacement) return;
    logger.info?.(`[DANCE] duplicate session replaced user=${userId}`);
    json(previous, { type: "server_error", reason: "duplicate_session", message: "Dance Sync відкрито в іншому Launcher." });
    previous.close(4001, "duplicate_session");
  };
  const authenticate = (client, token) => {
    const user = verifyToken?.(String(token || ""));
    if (!user?.id) return null;
    client.danceUser = { id: String(user.id), name: String(user.name || user.globalName || user.username || "FORBES") };
    return client.danceUser;
  };
  const rateAllowed = userId => {
    const now = Date.now();
    const previous = rateByUser.get(userId) || [];
    const recent = previous.filter(value => now - value < 10_000);
    if (recent.length >= 5) { rateByUser.set(userId, recent); return false; }
    recent.push(now); rateByUser.set(userId, recent); return true;
  };
  const reject = (client, reason, message) => json(client, { type: "dance_command_rejected", reason, message, serverTime: Date.now() });

  const onMessage = (client, raw) => {
    let data;
    try { data = JSON.parse(String(raw)); } catch { return json(client, { type: "server_error", reason: "invalid_json" }); }
    if (data.type === "dance_auth") {
      if (client.danceUser) return;
      const user = authenticate(client, data.token);
      if (!user) { json(client, { type: "server_error", reason: "unauthorized" }); return client.close(4003, "unauthorized"); }
      closeDuplicate(user.id, client);
      clientsByUser.set(user.id, client);
      logger.info?.(`[DANCE] authenticated user=${user.id}`);
      return json(client, { type: "dance_authenticated", serverTime: Date.now() });
    }
    if (!client.danceUser) return reject(client, "unauthorized", "Потрібен вхід через Discord у Launcher.");
    if (data.type === "time_sync_request") {
      const serverReceive = Date.now();
      return json(client, { type: "time_sync_response", sampleId: String(data.sampleId || ""), clientSend: Number(data.clientSend || 0), serverReceive, serverSend: Date.now() });
    }
    if (data.type === "heartbeat") return json(client, { type: "heartbeat_ack", clientTime: Number(data.clientTime || 0), serverTime: Date.now() });
    if (data.type === "dance_join") {
      const name = data.room === DANCE_ROOM ? DANCE_ROOM : DANCE_ROOM;
      leave(client);
      client.danceRoom = name; room(name).add(client);
      logger.info?.(`[DANCE] joined room user=${client.danceUser.id} room=${name}`);
      json(client, { type: "dance_ready", room: name, participantCount: room(name).size, serverTime: Date.now() });
      return presence(name);
    }
    if (data.type === "dance_leave") { leave(client); return json(client, { type: "dance_left", serverTime: Date.now() }); }
    if (data.type !== "dance_command_request") return;
    const dance = Number(data.dance);
    if (!client.danceRoom || !room(client.danceRoom).has(client)) return reject(client, "not_joined", "Спочатку увімкніть синхронізацію.");
    if (![5, 6, 7, 8, 9].includes(dance)) return reject(client, "invalid_dance", "Доступні лише Dance 5–9.");
    if (!rateAllowed(client.danceUser.id)) return reject(client, "rate_limited", "Забагато команд. Спробуйте трохи пізніше.");
    const createdAt = Date.now();
    if (createdAt < busyUntil) return reject(client, "busy", "Команда вже виконується.");
    busyUntil = createdAt + DANCE_COMMAND_COOLDOWN_MS;
    const command = { type: "dance_command", commandId: `dance_${crypto.randomUUID()}`, dance, createdAt, executeAt: createdAt + DANCE_EXECUTION_DELAY_MS, sourceDisplayName: client.danceUser.name };
    lastCommand = command;
    let count = 0;
    for (const member of room(client.danceRoom)) if (json(member, command)) count++;
    logger.info?.(`[DANCE] command accepted user=${client.danceUser.id} dance=${dance} commandId=${command.commandId} broadcast=${count}`);
  };
  const attach = server => {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      let path = "";
      try { path = new URL(request.url, "http://localhost").pathname; } catch {}
      if (path !== "/ws/dance-sync") return;
      wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client, request));
    });
    wss.on("connection", client => {
      client.isAlive = true;
      client.on("pong", () => { client.isAlive = true; });
      client.on("message", raw => onMessage(client, raw));
      client.on("close", () => leave(client));
      client.on("error", error => logger.warn?.(`[DANCE] socket error user=${client.danceUser?.id || "unknown"} error=${error.message}`));
    });
    const timer = setInterval(() => {
      for (const client of wss.clients) {
        if (!client.isAlive) { leave(client); client.terminate(); continue; }
        client.isAlive = false; try { client.ping(); } catch {}
      }
    }, 20_000);
    timer.unref?.();
    return wss;
  };
  const status = () => ({ room: DANCE_ROOM, participants: room(DANCE_ROOM).size, lastCommand: lastCommand?.dance || null, lastCommandAt: lastCommand?.createdAt || null });
  return { attach, status, onMessage, leave };
}
