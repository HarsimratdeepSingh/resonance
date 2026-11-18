const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const QRCode = require("qrcode");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map();
const PORT = Number(process.env.PORT) || 3000;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

function randomCode(length = 6) {
  return Array.from(crypto.randomBytes(length), byte => ROOM_CHARS[byte % ROOM_CHARS.length]).join("");
}

function createRoom() {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  const room = {
    code,
    hostKey: crypto.randomBytes(18).toString("hex"),
    clients: new Map(),
    cues: {
      A: { action: "cue", color: "#172033", label: "Waiting for cue", tone: false },
      B: { action: "cue", color: "#172033", label: "Waiting for cue", tone: false }
    },
    expiresAt: Date.now() + 4 * 60 * 60 * 1000
  };
  rooms.set(code, room);
  return room;
}

function getCounts(room) {
  const devices = [...room.clients.values()]
    .filter(client => client.role === "attendee")
    .map(client => ({ id: client.id, zone: client.zone }));
  return {
    action: "counts",
    online: devices.length,
    zones: {
      A: devices.filter(device => device.zone === "A").length,
      B: devices.filter(device => device.zone === "B").length
    },
    devices
  };
}

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

function broadcastCounts(room) {
  const counts = getCounts(room);
  for (const [socket, client] of room.clients) {
    if (client.role === "host") send(socket, counts);
  }
}

function safeZone(value) {
  return value === "B" ? "B" : "A";
}

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/api/rooms", (_req, res) => {
  const room = createRoom();
  res.status(201).json({ room: room.code, hostKey: room.hostKey });
});

app.get("/api/qr", async (req, res) => {
  const value = String(req.query.text || "").slice(0, 2048);
  if (!value) return res.status(400).send("Missing QR text");
  try {
    const svg = await QRCode.toString(value, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
      color: { dark: "#101827", light: "#ffffff" }
    });
    res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
  } catch {
    res.status(400).send("Could not generate QR code");
  }
});

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("room") || "").toUpperCase();
  const role = url.searchParams.get("role") === "host" ? "host" : "attendee";
  const room = rooms.get(code);

  if (!room || room.expiresAt < Date.now()) {
    send(socket, { action: "error", message: "Show not found. Ask the producer for a fresh link." });
    socket.close(1008, "Room not found");
    return;
  }

  if (role === "host" && url.searchParams.get("key") !== room.hostKey) {
    send(socket, { action: "error", message: "Producer link is invalid." });
    socket.close(1008, "Invalid producer key");
    return;
  }

  const id = role === "host"
    ? "producer"
    : (url.searchParams.get("id") || crypto.randomBytes(5).toString("hex")).slice(0, 32);

  // Replace a stale connection if this browser reconnects.
  for (const [oldSocket, oldClient] of room.clients) {
    if (oldClient.role === role && oldClient.id === id) {
      room.clients.delete(oldSocket);
      oldSocket.close(1000, "Reconnected");
    }
  }

  const client = { role, id, zone: safeZone(url.searchParams.get("zone")) };
  room.clients.set(socket, client);

  if (role === "host") {
    send(socket, { action: "connected", role: "host", room: code });
    send(socket, getCounts(room));
  } else {
    send(socket, { action: "connected", role: "attendee", room: code, zone: client.zone });
    send(socket, room.cues[client.zone]);
    broadcastCounts(room);
  }

  socket.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const current = room.clients.get(socket);
    if (!current) return;

    if (current.role === "attendee" && message.action === "set-zone") {
      current.zone = safeZone(message.zone);
      send(socket, { action: "zone-set", zone: current.zone });
      send(socket, room.cues[current.zone]);
      broadcastCounts(room);
      return;
    }

    if (current.role !== "host") return;

    if (message.action === "cue" || message.action === "clear") {
      const target = ["A", "B"].includes(message.target) ? message.target : "all";
      const cue = message.action === "clear"
        ? { action: "cue", color: "#172033", label: "Waiting for cue", tone: false }
        : {
            action: "cue",
            color: /^#[0-9a-fA-F]{6}$/.test(message.color) ? message.color : "#ffffff",
            label: String(message.label || "Live cue").slice(0, 32),
            tone: Boolean(message.tone)
          };

      const zones = target === "all" ? ["A", "B"] : [target];
      for (const zone of zones) room.cues[zone] = cue;

      for (const [recipient, recipientData] of room.clients) {
        if (recipientData.role === "attendee" && zones.includes(recipientData.zone)) {
          send(recipient, { ...cue, target });
        }
      }
      send(socket, {
        action: "cue-sent",
        label: cue.label,
        target,
        deliveredTo: getCounts(room).devices.filter(device => zones.includes(device.zone)).length
      });
    }
  });

  socket.on("close", () => {
    if (room.clients.has(socket)) {
      room.clients.delete(socket);
      broadcastCounts(room);
    }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.expiresAt < Date.now()) {
      for (const socket of room.clients.keys()) socket.close(1000, "Show expired");
      rooms.delete(code);
    }
  }
}, 60_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Resonance running on port ${PORT}`);
});
