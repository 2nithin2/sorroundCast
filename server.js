const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const TRACK_PATH = path.join(DATA_DIR, "current-track");
const TRACK_META_PATH = path.join(DATA_DIR, "current-track.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

let track = readTrackMeta();
const clients = new Map();

function readTrackMeta() {
  try {
    return JSON.parse(fs.readFileSync(TRACK_META_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveTrackMeta(meta) {
  fs.writeFileSync(TRACK_META_PATH, JSON.stringify(meta, null, 2));
  track = meta;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json)
  });
  res.end(json);
}

function asciiFilename(name) {
  return String(name || "track")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 80) || "track";
}

function safePublicPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, {
      now: Date.now(),
      track,
      devices: [...clients.values()].map(({ id, name, role, latencyMs }) => ({
        id,
        name,
        role,
        latencyMs
      }))
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/track/current") {
    if (!track || !fs.existsSync(TRACK_PATH)) {
      sendJson(res, 404, { error: "No track uploaded yet." });
      return;
    }
    res.writeHead(200, {
      "content-type": track.type || "audio/mpeg",
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${asciiFilename(track.name)}"`
    });
    fs.createReadStream(TRACK_PATH).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const chunks = [];
    let total = 0;
    const maxBytes = 80 * 1024 * 1024;

    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        res.writeHead(413);
        res.end("Track is too large. Keep it below 80 MB for this prototype.");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const name = url.searchParams.get("name") || "track";
      const type = req.headers["content-type"] || "audio/mpeg";
      fs.writeFileSync(TRACK_PATH, body);
      const meta = {
        name,
        type,
        size: body.length,
        version: Date.now()
      };
      saveTrackMeta(meta);
      broadcast({ type: "track-ready", track: meta });
      sendJson(res, 200, { ok: true, track: meta });
    });

    return;
  }

  const file = safePublicPath(decodeURIComponent(url.pathname));
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  res.writeHead(200, { "content-type": contentType(file) });
  fs.createReadStream(file).pipe(res);
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const id = crypto.randomUUID();
  const client = {
    id,
    socket,
    buffer: Buffer.alloc(0),
    name: `Device ${clients.size + 1}`,
    role: "full",
    latencyMs: 0
  };
  clients.set(id, client);

  send(client, {
    type: "hello",
    id,
    serverNow: Date.now(),
    track,
    devices: publicDevices()
  });
  broadcastRoster();

  socket.on("data", chunk => readFrames(client, chunk));
  socket.on("close", () => {
    clients.delete(id);
    broadcastRoster();
  });
  socket.on("error", () => {
    clients.delete(id);
    broadcastRoster();
  });
});

function publicDevices() {
  return [...clients.values()].map(({ id, name, role, latencyMs }) => ({
    id,
    name,
    role,
    latencyMs
  }));
}

function broadcastRoster() {
  broadcast({ type: "roster", devices: publicDevices() });
}

function readFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const big = client.buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        client.socket.destroy();
        return;
      }
      length = Number(big);
      offset = 10;
    }

    const maskOffset = masked ? offset : -1;
    const payloadOffset = masked ? offset + 4 : offset;
    const frameLength = payloadOffset + length;
    if (client.buffer.length < frameLength) return;

    const opcode = first & 0x0f;
    const payload = client.buffer.subarray(payloadOffset, frameLength);
    let data = payload;

    if (masked) {
      const mask = client.buffer.subarray(maskOffset, maskOffset + 4);
      data = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) data[i] = payload[i] ^ mask[i % 4];
    }

    client.buffer = client.buffer.subarray(frameLength);

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      writeFrame(client.socket, data, 0xA);
      continue;
    }
    if (opcode === 0x1) {
      try {
        handleMessage(client, JSON.parse(data.toString("utf8")));
      } catch {
        send(client, { type: "error", message: "Bad message" });
      }
    }
  }
}

function handleMessage(client, message) {
  if (message.type === "introduce") {
    client.name = String(message.name || client.name).slice(0, 40);
    client.role = String(message.role || client.role);
    client.latencyMs = Number(message.latencyMs || 0);
    broadcastRoster();
    return;
  }

  if (message.type === "clock") {
    send(client, {
      type: "clock",
      clientSentAt: message.clientSentAt,
      serverNow: Date.now()
    });
    return;
  }

  if (message.type === "set-role") {
    client.role = String(message.role || "full");
    client.latencyMs = Number(message.latencyMs || 0);
    broadcastRoster();
    return;
  }

  if (message.type === "youtube-load") {
    const videoId = String(message.videoId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
    if (!videoId) {
      send(client, { type: "error", message: "Invalid YouTube link" });
      return;
    }

    const meta = {
      source: "youtube",
      videoId,
      name: String(message.name || `YouTube ${videoId}`).slice(0, 120),
      version: Date.now()
    };
    saveTrackMeta(meta);
    broadcast({ type: "youtube-ready", track: meta });
    return;
  }

  if (message.type === "prepare") {
    broadcast({
      type: "prepare",
      issuedAt: Date.now(),
      startAt: Date.now() + 4500,
      position: Number(message.position || 0),
      source: message.source || track?.source || "file",
      track
    });
    return;
  }

  if (["play", "pause", "stop", "seek"].includes(message.type)) {
    broadcast({
      ...message,
      issuedAt: Date.now(),
      at: Date.now() + Number(message.leadMs || 1200)
    });
  }
}

function send(client, message) {
  if (client.socket.destroyed) return;
  writeFrame(client.socket, Buffer.from(JSON.stringify(message)), 0x1);
}

function broadcast(message) {
  for (const client of clients.values()) send(client, message);
}

function writeFrame(socket, payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) addresses.push(item.address);
    }
  }
  return addresses;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SurroundCast running at http://localhost:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`Phone URL: http://${address}:${PORT}`);
  }
});
