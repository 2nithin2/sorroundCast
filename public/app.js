const audio = document.querySelector("#player");
const canvas = document.querySelector("#roomCanvas");
const ctx = canvas.getContext("2d");

const ui = {
  badge: document.querySelector("#connectionBadge"),
  arm: document.querySelector("#armBtn"),
  play: document.querySelector("#playBtn"),
  pause: document.querySelector("#pauseBtn"),
  stop: document.querySelector("#stopBtn"),
  file: document.querySelector("#fileInput"),
  youtubeUrl: document.querySelector("#youtubeUrl"),
  loadYoutube: document.querySelector("#loadYoutubeBtn"),
  youtubePanel: document.querySelector("#youtubePanel"),
  youtubeStatus: document.querySelector("#youtubeStatus"),
  youtubeTapToPlay: document.querySelector("#youtubeTapToPlay"),
  soundcloudUrl: document.querySelector("#soundcloudUrl"),
  loadSoundcloud: document.querySelector("#loadSoundcloudBtn"),
  soundcloudPanel: document.querySelector("#soundcloudPanel"),
  soundcloudStatus: document.querySelector("#soundcloudStatus"),
  soundcloudTapToPlay: document.querySelector("#soundcloudTapToPlay"),
  name: document.querySelector("#deviceName"),
  role: document.querySelector("#roleSelect"),
  latency: document.querySelector("#latencyTrim"),
  latencyValue: document.querySelector("#latencyValue"),
  effect: document.querySelector("#effectAmount"),
  effectValue: document.querySelector("#effectValue"),
  trackName: document.querySelector("#trackName"),
  offset: document.querySelector("#offsetMetric"),
  rtt: document.querySelector("#rttMetric"),
  devices: document.querySelector("#deviceList")
};

const roles = {
  full: { label: "Full", x: 0, y: 0, color: "#7ddfbd" },
  left: { label: "Left", x: -0.68, y: -0.18, color: "#8ec8ff" },
  right: { label: "Right", x: 0.68, y: -0.18, color: "#ffadad" },
  center: { label: "Center", x: 0, y: -0.62, color: "#f5c86b" },
  sub: { label: "Sub", x: 0, y: 0.64, color: "#b8f27f" },
  ambient: { label: "Rear", x: 0, y: 0.24, color: "#c7a4ff" }
};

let socket;
let clientId = "";
let devices = [];
let track = null;
let audioContext;
let sourceNode;
let analyser;
let graph = {};
let serverOffset = 0;
let rtt = 0;
let raf = 0;
let preparedTimer = 0;
let armed = false;
let sourceMode = "file";
let youtubePlayer;
let youtubeReady = false;
let pendingYoutubeId = "";
let youtubeApiPromise;
let soundcloudWidget;
let soundcloudReady = false;
let pendingSoundcloudUrl = "";
let soundcloudApiPromise;
let soundcloudPositionSec = 0;
let visualPhase = 0;

const saved = JSON.parse(localStorage.getItem("surroundCastDevice") || "{}");
ui.name.value = saved.name || defaultDeviceName();
ui.role.value = saved.role || "full";
ui.latency.value = saved.latencyMs || 0;
ui.effect.value = saved.effectAmount ?? 70;
updateSliderText();

connect();
draw();

function defaultDeviceName() {
  const names = ["Front phone", "Left pocket", "Right pocket", "Table speaker", "Back row"];
  return names[Math.floor(Math.random() * names.length)];
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}`);

  socket.addEventListener("open", () => {
    ui.badge.textContent = "Live";
    ui.badge.classList.add("live");
    introduce();
    startClockSync();
  });

  socket.addEventListener("close", () => {
    ui.badge.textContent = "Reconnecting";
    ui.badge.classList.remove("live");
    setTimeout(connect, 900);
  });

  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function introduce() {
  saveSettings();
  send({
    type: "introduce",
    name: ui.name.value,
    role: ui.role.value,
    latencyMs: Number(ui.latency.value)
  });
}

function handleMessage(message) {
  if (message.type === "hello") {
    clientId = message.id;
    track = message.track;
    sourceMode = track?.source || "file";
    devices = message.devices || [];
    updateTrack();
    if (track?.source === "youtube") loadYoutubeVideo(track.videoId);
    else if (track?.source === "soundcloud") loadSoundcloudTrack(track.url);
    renderDevices();
  }

  if (message.type === "track-ready") {
    track = message.track;
    sourceMode = "file";
    updateTrack();
    loadTrack();
  }

  if (message.type === "youtube-ready") {
    track = message.track;
    sourceMode = "youtube";
    updateTrack();
    loadYoutubeVideo(track.videoId);
  }

  if (message.type === "soundcloud-ready") {
    track = message.track;
    sourceMode = "soundcloud";
    updateTrack();
    loadSoundcloudTrack(track.url);
  }

  if (message.type === "roster") {
    devices = message.devices || [];
    renderDevices();
  }

  if (message.type === "clock") {
    const receivedAt = performance.now();
    const localMidpoint = (message.clientSentAt + receivedAt) / 2;
    serverOffset = message.serverNow - localMidpoint;
    rtt = receivedAt - message.clientSentAt;
    ui.offset.textContent = `${Math.round(serverOffset)} ms`;
    ui.rtt.textContent = `${Math.round(rtt)} ms`;
  }

  if (message.type === "prepare") {
    preparePlayback(message);
  }

  if (message.type === "pause") {
    window.setTimeout(() => pauseCurrentSource(), delayUntil(message.at));
  }

  if (message.type === "stop") {
    window.setTimeout(() => {
      stopCurrentSource();
    }, delayUntil(message.at));
  }

  if (message.type === "seek") {
    window.setTimeout(() => {
      audio.currentTime = Number(message.position || 0);
    }, delayUntil(message.at));
  }
}

function startClockSync() {
  const tick = () => send({ type: "clock", clientSentAt: performance.now() });
  tick();
  window.setInterval(tick, 1800);
}

function delayUntil(serverEpochMs) {
  const estimatedServerNow = performance.now() + serverOffset;
  const localDelay = serverEpochMs - estimatedServerNow + Number(ui.latency.value);
  return Math.max(0, localDelay);
}

async function initAudio() {
  if (audioContext) return;

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaElementSource(audio);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.82;

  graph.input = audioContext.createGain();
  graph.filter = audioContext.createBiquadFilter();
  graph.panner = audioContext.createStereoPanner();
  graph.delay = audioContext.createDelay(0.8);
  graph.feedback = audioContext.createGain();
  graph.wet = audioContext.createGain();
  graph.dry = audioContext.createGain();
  graph.output = audioContext.createGain();

  sourceNode.connect(graph.input);
  graph.input.connect(graph.filter);
  graph.filter.connect(graph.panner);
  graph.panner.connect(graph.dry);
  graph.panner.connect(graph.delay);
  graph.delay.connect(graph.feedback);
  graph.feedback.connect(graph.delay);
  graph.delay.connect(graph.wet);
  graph.dry.connect(graph.output);
  graph.wet.connect(graph.output);
  graph.output.connect(analyser);
  analyser.connect(audioContext.destination);

  applyRole();
}

async function armSpeaker() {
  await initAudio();
  await audioContext.resume();
  if (!audio.src && sourceMode === "file") loadTrack();

  // Prime YouTube iframe inside user gesture if active
  if (sourceMode === "youtube" && youtubePlayer && youtubeReady) {
    try {
      youtubePlayer.playVideo();
      youtubePlayer.pauseVideo();
    } catch {}
  }

  // Prime SoundCloud iframe inside user gesture if active
  if (sourceMode === "soundcloud" && soundcloudWidget && soundcloudReady) {
    try {
      soundcloudWidget.play();
      soundcloudWidget.pause();
    } catch {}
  }

  armed = true;
  ui.arm.textContent = "Speaker armed";
  ui.badge.textContent = socket?.readyState === WebSocket.OPEN ? "Live" : "Ready";
  ui.badge.classList.toggle("live", socket?.readyState === WebSocket.OPEN);
}

function applyRole() {
  if (!audioContext) return;
  const amount = Number(ui.effect.value) / 100;
  const role = ui.role.value;

  graph.filter.type = "allpass";
  graph.filter.frequency.value = 1200;
  graph.panner.pan.value = 0;
  graph.delay.delayTime.value = 0.02;
  graph.feedback.gain.value = 0;
  graph.wet.gain.value = 0;
  graph.dry.gain.value = 1;
  graph.output.gain.value = 1;

  if (role === "left") graph.panner.pan.value = -0.9 * amount;
  if (role === "right") graph.panner.pan.value = 0.9 * amount;

  if (role === "center") {
    graph.filter.type = "bandpass";
    graph.filter.frequency.value = 1100;
    graph.filter.Q.value = 0.85;
    graph.output.gain.value = 1.15;
  }

  if (role === "sub") {
    graph.filter.type = "lowpass";
    graph.filter.frequency.value = 90 + 80 * (1 - amount);
    graph.filter.Q.value = 1.1;
    graph.output.gain.value = 1.35;
  }

  if (role === "ambient") {
    graph.filter.type = "highpass";
    graph.filter.frequency.value = 650;
    graph.delay.delayTime.value = 0.08 + amount * 0.22;
    graph.feedback.gain.value = amount * 0.32;
    graph.wet.gain.value = amount * 0.8;
    graph.dry.gain.value = 0.55;
  }
}

function updateTrack() {
  if (track?.source === "youtube") {
    ui.trackName.textContent = `YouTube: ${track.name}`;
    ui.youtubePanel.classList.add("active");
    ui.soundcloudPanel.classList.remove("active");
  } else if (track?.source === "soundcloud") {
    ui.trackName.textContent = `SoundCloud: ${track.name}`;
    ui.soundcloudPanel.classList.add("active");
    ui.youtubePanel.classList.remove("active");
  } else {
    ui.trackName.textContent = track?.name || "No track loaded";
    ui.youtubePanel.classList.remove("active");
    ui.soundcloudPanel.classList.remove("active");
  }
}

function loadTrack() {
  if (!track) return;
  sourceMode = "file";
  ui.youtubePanel.classList.remove("active");
  ui.soundcloudPanel.classList.remove("active");
  ui.youtubeTapToPlay.classList.remove("show");
  ui.soundcloudTapToPlay.classList.remove("show");
  const previous = audio.currentTime || 0;
  audio.src = `/track/current?v=${track.version}`;
  audio.load();
  audio.addEventListener("loadedmetadata", () => {
    audio.currentTime = Math.min(previous, Math.max(0, audio.duration - 0.2));
  }, { once: true });
}

async function preparePlayback(message) {
  if (!armed) {
    ui.badge.textContent = "Tap Arm";
    ui.badge.classList.remove("live");
    return;
  }

  track = message.track;
  sourceMode = message.source || track?.source || "file";
  updateTrack();

  if (sourceMode === "youtube") {
    await ensureYoutubePlayer();
    if (track?.videoId) await loadYoutubeVideo(track.videoId);
    if (youtubeReady) youtubePlayer.seekTo(Number(message.position || 0), true);
  } else if (sourceMode === "soundcloud") {
    await ensureSoundcloudPlayer();
    if (track?.url && track.url !== pendingSoundcloudUrl) await loadSoundcloudTrack(track.url);
    if (soundcloudWidget && soundcloudReady) {
      soundcloudWidget.seekTo(Number(message.position || 0) * 1000);
    }
  } else {
    await initAudio();
    await audioContext.resume();
    if (!audio.src || track?.version !== message.track?.version) loadTrack();
    audio.pause();
    audio.currentTime = Number(message.position || 0);
    audio.load();
  }

  clearTimeout(preparedTimer);
  preparedTimer = window.setTimeout(async () => {
    try {
      if (sourceMode === "youtube") {
        if (youtubeReady) {
          youtubePlayer.playVideo();
          // Watch for mobile autoplay rejection
          setTimeout(() => {
            const state = youtubePlayer.getPlayerState?.();
            if (state !== 1 && state !== 3) {
              ui.youtubeTapToPlay.classList.add("show");
              ui.youtubeStatus.textContent = "Tap button below to start YouTube on this phone.";
            }
          }, 800);
        }
      } else if (sourceMode === "soundcloud") {
        if (soundcloudWidget && soundcloudReady) {
          soundcloudWidget.play();
          setTimeout(() => {
            soundcloudWidget.isPaused?.(paused => {
              if (paused) {
                ui.soundcloudTapToPlay.classList.add("show");
                ui.soundcloudStatus.textContent = "Tap button below to start SoundCloud on this phone.";
              }
            });
          }, 800);
        }
      } else {
        await audio.play();
      }
    } catch (error) {
      ui.badge.textContent = "Tap Play";
      ui.badge.classList.remove("live");
      if (sourceMode === "youtube") ui.youtubeTapToPlay.classList.add("show");
      if (sourceMode === "soundcloud") ui.soundcloudTapToPlay.classList.add("show");
    }
  }, delayUntil(message.startAt));
}

function currentPosition() {
  if (sourceMode === "youtube" && youtubeReady) return youtubePlayer.getCurrentTime() || 0;
  if (sourceMode === "soundcloud") return soundcloudPositionSec || 0;
  return audio.currentTime || 0;
}

function pauseCurrentSource() {
  if (sourceMode === "youtube" && youtubeReady) {
    youtubePlayer.pauseVideo();
    return;
  }
  if (sourceMode === "soundcloud" && soundcloudReady && soundcloudWidget) {
    soundcloudWidget.pause();
    return;
  }
  audio.pause();
}

function stopCurrentSource() {
  if (sourceMode === "youtube" && youtubeReady) {
    youtubePlayer.stopVideo();
    youtubePlayer.seekTo(0, true);
    return;
  }
  if (sourceMode === "soundcloud" && soundcloudReady && soundcloudWidget) {
    soundcloudWidget.pause();
    soundcloudWidget.seekTo(0);
    soundcloudPositionSec = 0;
    return;
  }
  audio.pause();
  audio.currentTime = 0;
}

function parseYoutubeId(value) {
  const raw = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) return cleanYoutubeId(url.pathname.slice(1).split(/[/?#]/)[0]);
    if (url.searchParams.get("v")) return cleanYoutubeId(url.searchParams.get("v"));
    const shortsMatch = url.pathname.match(/\/shorts\/([^/?#]+)/);
    if (shortsMatch) return cleanYoutubeId(shortsMatch[1]);
    const embedMatch = url.pathname.match(/\/embed\/([^/?#]+)/);
    if (embedMatch) return cleanYoutubeId(embedMatch[1]);
  } catch {
    return "";
  }
  return "";
}

function cleanYoutubeId(value) {
  const match = String(value || "").match(/[a-zA-Z0-9_-]{11}/);
  return match ? match[0] : "";
}

function ensureYoutubePlayer() {
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    if (youtubePlayer) {
      resolve();
      return;
    }

    const buildPlayer = () => {
      youtubePlayer = new YT.Player("youtubePlayer", {
        width: "100%",
        height: "220",
        playerVars: {
          enablejsapi: 1,
          playsinline: 1,
          modestbranding: 1,
          rel: 0
        },
        events: {
          onReady: () => {
            youtubeReady = true;
            if (pendingYoutubeId) {
              youtubePlayer.cueVideoById(pendingYoutubeId);
            }
            ui.youtubeStatus.textContent = pendingYoutubeId ? "YouTube video ready" : "YouTube player ready";
            resolve();
          },
          onStateChange: event => {
            if (event.data === 1) { // PLAYING
              ui.youtubeTapToPlay.classList.remove("show");
              ui.youtubeStatus.textContent = "YouTube playing in sync";
            } else if (event.data === 2) { // PAUSED
              ui.youtubeStatus.textContent = "YouTube paused";
            }
          },
          onError: event => {
            ui.youtubeStatus.textContent = youtubeErrorText(event.data);
          }
        }
      });
    };

    if (window.YT?.Player) {
      buildPlayer();
      return;
    }

    window.onYouTubeIframeAPIReady = buildPlayer;

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      youtubeApiPromise = null;
      ui.youtubeStatus.textContent = "Could not load the YouTube player API. Check internet access or try a direct audio upload.";
      reject(new Error("YouTube API failed to load"));
    };
    document.head.append(script);
  });

  return youtubeApiPromise;
}

function youtubeErrorText(code) {
  if ([101, 150].includes(code)) return "This YouTube video blocks embedded playback. Try another video or upload the audio file.";
  if (code === 100) return "This YouTube video was not found or is private.";
  if (code === 5) return "This YouTube video cannot play in the embedded player.";
  if (code === 2) return "The YouTube link does not look valid.";
  return "YouTube could not play this video here. Try another link.";
}

async function loadYoutubeVideo(videoId) {
  sourceMode = "youtube";
  pendingYoutubeId = videoId;
  ui.soundcloudPanel.classList.remove("active");
  ui.youtubePanel.classList.add("active");
  ui.youtubeStatus.textContent = "Loading YouTube player...";
  ui.youtubeTapToPlay.classList.remove("show");
  audio.pause();
  if (soundcloudWidget && soundcloudReady) soundcloudWidget.pause();
  try {
    await ensureYoutubePlayer();
    if (youtubeReady) {
      youtubePlayer.cueVideoById(videoId);
      ui.youtubeStatus.textContent = "YouTube video ready";
    }
  } catch {
    ui.badge.textContent = "YouTube error";
    ui.badge.classList.remove("live");
  }
}

function ensureSoundcloudPlayer() {
  if (soundcloudApiPromise) return soundcloudApiPromise;

  soundcloudApiPromise = new Promise((resolve, reject) => {
    const initWidget = () => {
      if (!window.SC?.Widget) {
        setTimeout(initWidget, 80);
        return;
      }
      const iframe = document.querySelector("#soundcloudPlayer");
      soundcloudWidget = window.SC.Widget(iframe);
      soundcloudWidget.bind(window.SC.Widget.Events.READY, () => {
        soundcloudReady = true;
        ui.soundcloudStatus.textContent = "SoundCloud player ready";
        resolve();
      });
      soundcloudWidget.bind(window.SC.Widget.Events.PLAY, () => {
        ui.soundcloudTapToPlay.classList.remove("show");
        ui.soundcloudStatus.textContent = "SoundCloud playing in sync";
      });
      soundcloudWidget.bind(window.SC.Widget.Events.PAUSE, () => {
        ui.soundcloudStatus.textContent = "SoundCloud paused";
      });
      soundcloudWidget.bind(window.SC.Widget.Events.PLAY_PROGRESS, data => {
        if (data && typeof data.currentPosition === "number") {
          soundcloudPositionSec = data.currentPosition / 1000;
        }
      });
      soundcloudWidget.bind(window.SC.Widget.Events.ERROR, () => {
        ui.soundcloudStatus.textContent = "SoundCloud error: Unable to load track.";
      });
    };

    if (window.SC?.Widget) {
      initWidget();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://w.soundcloud.com/player/api.js";
    script.onload = initWidget;
    script.onerror = () => {
      soundcloudApiPromise = null;
      ui.soundcloudStatus.textContent = "Could not load SoundCloud Widget API.";
      reject(new Error("SoundCloud API failed to load"));
    };
    document.head.append(script);
  });

  return soundcloudApiPromise;
}

async function loadSoundcloudTrack(url) {
  sourceMode = "soundcloud";
  pendingSoundcloudUrl = url;
  ui.youtubePanel.classList.remove("active");
  ui.soundcloudPanel.classList.add("active");
  ui.soundcloudStatus.textContent = "Loading SoundCloud track...";
  ui.soundcloudTapToPlay.classList.remove("show");
  audio.pause();
  if (youtubePlayer && youtubeReady) youtubePlayer.pauseVideo();

  try {
    await ensureSoundcloudPlayer();
    if (soundcloudWidget && soundcloudReady) {
      soundcloudWidget.load(url, {
        auto_play: false,
        show_artwork: true,
        show_comments: false,
        buying: false,
        sharing: false,
        download: false,
        callback: () => {
          ui.soundcloudStatus.textContent = "SoundCloud track ready";
          soundcloudWidget.getCurrentSound(sound => {
            if (sound?.title) {
              const displayName = `${sound.user?.username ? sound.user.username + " - " : ""}${sound.title}`;
              ui.trackName.textContent = `SoundCloud: ${displayName}`;
            }
          });
        }
      });
    }
  } catch {
    ui.badge.textContent = "SoundCloud error";
    ui.badge.classList.remove("live");
  }
}

function renderDevices() {
  ui.devices.innerHTML = "";
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "device";
    row.innerHTML = `<span>${escapeHtml(device.name)}${device.id === clientId ? " (you)" : ""}</span><strong>${roles[device.role]?.label || device.role}</strong>`;
    ui.devices.append(row);
  }
}

function saveSettings() {
  localStorage.setItem("surroundCastDevice", JSON.stringify({
    name: ui.name.value,
    role: ui.role.value,
    latencyMs: Number(ui.latency.value),
    effectAmount: Number(ui.effect.value)
  }));
}

function updateSliderText() {
  ui.latencyValue.textContent = `${ui.latency.value} ms`;
  ui.effectValue.textContent = `${ui.effect.value}%`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

ui.name.addEventListener("change", introduce);
ui.role.addEventListener("change", () => {
  applyRole();
  introduce();
});
ui.latency.addEventListener("input", () => {
  updateSliderText();
  introduce();
});
ui.effect.addEventListener("input", () => {
  updateSliderText();
  saveSettings();
  applyRole();
});

ui.file.addEventListener("change", async () => {
  const file = ui.file.files[0];
  if (!file) return;
  ui.trackName.textContent = `Uploading ${file.name}`;
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": file.type || "audio/mpeg" },
    body: await file.arrayBuffer()
  });
  const result = await res.json();
  track = result.track;
  sourceMode = "file";
  updateTrack();
  loadTrack();
});

ui.arm.addEventListener("click", armSpeaker);

ui.youtubeTapToPlay.addEventListener("click", () => {
  if (youtubePlayer && youtubeReady) {
    youtubePlayer.playVideo();
    ui.youtubeTapToPlay.classList.remove("show");
  }
});

ui.soundcloudTapToPlay.addEventListener("click", () => {
  if (soundcloudWidget && soundcloudReady) {
    soundcloudWidget.play();
    ui.soundcloudTapToPlay.classList.remove("show");
  }
});

ui.loadYoutube.addEventListener("click", async () => {
  const videoId = parseYoutubeId(ui.youtubeUrl.value);
  if (!videoId) {
    ui.trackName.textContent = "Paste a valid YouTube link";
    ui.youtubeStatus.textContent = "Paste a full YouTube URL or an 11-character video ID.";
    return;
  }

  await armSpeaker();
  sourceMode = "youtube";
  ui.soundcloudPanel.classList.remove("active");
  ui.youtubePanel.classList.add("active");
  ui.youtubeStatus.textContent = "Sending YouTube link to connected speakers...";
  send({
    type: "youtube-load",
    videoId,
    name: `Video ${videoId}`
  });
});

ui.loadSoundcloud.addEventListener("click", async () => {
  const url = ui.soundcloudUrl.value.trim();
  if (!url || (!url.includes("soundcloud.com") && !url.includes("on.soundcloud.com"))) {
    ui.trackName.textContent = "Paste a valid SoundCloud link";
    ui.soundcloudStatus.textContent = "Paste a SoundCloud link (e.g. https://soundcloud.com/artist/track).";
    return;
  }

  await armSpeaker();
  sourceMode = "soundcloud";
  ui.youtubePanel.classList.remove("active");
  ui.soundcloudPanel.classList.add("active");
  ui.soundcloudStatus.textContent = "Sending SoundCloud link to connected speakers...";
  send({
    type: "soundcloud-load",
    url,
    name: "SoundCloud Track"
  });
});

ui.play.addEventListener("click", async () => {
  await armSpeaker();
  if (sourceMode === "file" && !audio.src) loadTrack();
  send({ type: "prepare", source: sourceMode, position: currentPosition() });
});

ui.pause.addEventListener("click", () => send({ type: "pause", leadMs: 800 }));
ui.stop.addEventListener("click", () => send({ type: "stop", leadMs: 800 }));

function draw() {
  raf = requestAnimationFrame(draw);
  const width = canvas.width = canvas.clientWidth * devicePixelRatio;
  const height = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.27;
  const spectrum = currentSpectrum();
  visualPhase += 0.018 + spectrum.energy * 0.035;

  ctx.clearRect(0, 0, width, height);
  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, "#08110f");
  background.addColorStop(0.52, "#111614");
  background.addColorStop(1, "#15130b");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  drawStarfield(w, h, spectrum.energy);
  drawWaveRibbon(w, h, spectrum);
  drawRadialSpectrum(cx, cy, radius, spectrum);
  drawRoomGrid(cx, cy, radius, spectrum);
  drawSpeakerNodes(cx, cy, radius, spectrum);
  drawCenterMeter(cx, cy, spectrum);
}

function drawRoomGrid(cx, cy, radius, spectrum) {
  ctx.strokeStyle = "#34413d";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i += 1) {
    const pulse = i === 4 ? spectrum.bass * 14 : 0;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (i / 4) + pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(125, 223, 189, 0.18)";
  ctx.beginPath();
  ctx.moveTo(cx - radius * 1.35, cy);
  ctx.lineTo(cx + radius * 1.35, cy);
  ctx.moveTo(cx, cy - radius * 1.35);
  ctx.lineTo(cx, cy + radius * 1.35);
  ctx.stroke();
}

function drawSpeakerNodes(cx, cy, radius, spectrum) {
  const grouped = devices.reduce((acc, device) => {
    const role = device.role || "full";
    acc[role] = acc[role] || [];
    acc[role].push(device);
    return acc;
  }, {});

  Object.entries(grouped).forEach(([role, group], index) => {
      const info = roles[role] || roles.full;
      const angleOffset = (index - 2) * 0.08;
      group.forEach((device, groupIndex) => {
        const x = cx + (info.x + groupIndex * 0.06 + angleOffset) * radius;
        const y = cy + (info.y + groupIndex * 0.06) * radius;
      const roleEnergy = role === "sub"
        ? spectrum.bass
        : role === "ambient"
          ? spectrum.highs
          : role === "center"
            ? spectrum.mids
            : spectrum.energy;
      const pulse = device.id === clientId ? 12 + roleEnergy * 34 : 8 + roleEnergy * 18;

      ctx.fillStyle = `${info.color}22`;
      ctx.beginPath();
      ctx.arc(x, y, 28 + pulse, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `${info.color}66`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 20 + pulse * 0.35, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = info.color;
      ctx.beginPath();
      ctx.arc(x, y, 13 + roleEnergy * 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#eef6f0";
      ctx.font = "700 12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(info.label, x, y + 36);
    });
  });
}

function drawCenterMeter(cx, cy, spectrum) {
  const core = 18 + spectrum.energy * 14;
  const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, 76 + spectrum.bass * 40);
  glow.addColorStop(0, "rgba(238, 246, 240, 0.95)");
  glow.addColorStop(0.24, "rgba(125, 223, 189, 0.42)");
  glow.addColorStop(1, "rgba(125, 223, 189, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, 76 + spectrum.bass * 40, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#eef6f0";
  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111614";
  ctx.font = "800 11px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("YOU", cx, cy);
}

function drawRadialSpectrum(cx, cy, radius, spectrum) {
  const bars = 96;
  const data = spectrum.data;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(visualPhase * 0.08);
  ctx.lineCap = "round";

  for (let i = 0; i < bars; i += 1) {
    const angle = (i / bars) * Math.PI * 2;
    const bin = data.length ? data[Math.floor((i / bars) * data.length)] / 255 : 0.12;
    const lift = Math.pow(bin, 1.45);
    const inner = radius * 1.06;
    const outer = inner + 14 + lift * radius * 0.64;
    const color = i % 3 === 0 ? "#7ddfbd" : i % 3 === 1 ? "#f5c86b" : "#8ec8ff";

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.18 + lift * 0.78;
    ctx.lineWidth = 2 + lift * 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawWaveRibbon(w, h, spectrum) {
  const data = spectrum.wave;
  const baseline = h * 0.82;
  const amplitude = Math.max(18, h * 0.12);
  ctx.lineWidth = 2;

  for (let layer = 0; layer < 3; layer += 1) {
    ctx.beginPath();
    for (let i = 0; i < 180; i += 1) {
      const x = (i / 179) * w;
      const waveValue = data.length ? (data[Math.floor((i / 180) * data.length)] - 128) / 128 : Math.sin(i * 0.16 + visualPhase);
      const drift = Math.sin(i * 0.07 + visualPhase + layer) * 10;
      const y = baseline + waveValue * amplitude * (1 - layer * 0.22) + drift;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = layer === 0 ? "#7ddfbd" : layer === 1 ? "#f5c86b" : "#c7a4ff";
    ctx.globalAlpha = 0.72 - layer * 0.2;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function drawStarfield(w, h, energy) {
  const count = 42;
  ctx.fillStyle = "rgba(238, 246, 240, 0.42)";
  for (let i = 0; i < count; i += 1) {
    const x = ((Math.sin(i * 73.13) + 1) / 2) * w;
    const y = ((Math.cos(i * 41.71) + 1) / 2) * h;
    const twinkle = 0.6 + Math.sin(visualPhase * 2 + i) * 0.4;
    ctx.globalAlpha = 0.08 + twinkle * energy * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, 1 + twinkle * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function currentSpectrum() {
  const isExternalStream = (sourceMode === "youtube" && youtubeReady) || (sourceMode === "soundcloud" && soundcloudReady);
  const fallbackEnergy = isExternalStream ? 0.24 + Math.sin(visualPhase * 2) * 0.08 : 0.1;
  if (!analyser) {
    return {
      data: new Uint8Array(0),
      wave: new Uint8Array(0),
      energy: fallbackEnergy,
      bass: fallbackEnergy * 0.8,
      mids: fallbackEnergy,
      highs: fallbackEnergy * 0.7
    };
  }

  const data = new Uint8Array(analyser.frequencyBinCount);
  const wave = new Uint8Array(analyser.fftSize);
  analyser.getByteFrequencyData(data);
  analyser.getByteTimeDomainData(wave);

  const band = (start, end) => {
    const slice = data.slice(start, Math.max(start + 1, end));
    const sum = slice.reduce((total, value) => total + value, 0);
    return Math.min(1, sum / slice.length / 220);
  };

  const bass = band(0, 10);
  const mids = band(10, 90);
  const highs = band(90, data.length);
  const energy = Math.min(1, bass * 0.42 + mids * 0.4 + highs * 0.28);

  return { data, wave, energy, bass, mids, highs };
}

window.addEventListener("beforeunload", () => cancelAnimationFrame(raf));
