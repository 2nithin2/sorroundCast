# SurroundCast

SurroundCast is a local Wi-Fi prototype for turning several phones into one synchronized music system. One browser uploads a track, every phone joins the same address, and each device can take a role: full range, left, right, center, subwoofer, or rear ambient.

The design borrows three useful ideas from existing projects:

- Snapcast-style scheduled playback: controls are sent with a future server time so devices start together.
- MUSIXQUARE-style speaker roles: phones can act as left, right, center, sub, or ambient speakers.
- Browser-native Web Audio effects: role routing, filtering, delay, feedback, and stereo panning run locally on each phone.

## Run

```bash
npm start
```

Open the laptop URL shown in the terminal. On phones, open the `Phone URL` printed by the server while connected to the same Wi-Fi or hotspot.

## Use

1. Open the page on every phone.
2. Give each phone a useful name.
3. Pick a role for each phone.
4. Tap `Arm speaker` on each phone so the browser allows audio playback.
5. Load an audio file from one device.
6. Tap `Play in sync`.
7. Use `Delay trim` on any phone that sounds early or late.

For YouTube, paste a YouTube link into the panel, tap `Load YouTube`, arm each phone, then tap `Play in sync`.

YouTube mode uses the official embedded player. Sync controls work, but the browser does not expose YouTube audio to Web Audio, so the speaker-role filters and ambient/sub effects only apply to uploaded audio files.

## Prototype Limits

- All devices need to be on the same local network.
- Browser audio startup latency differs by device, so the delay trim is important.
- The uploaded track is stored locally in `data/current-track`.
- Track upload is capped at 80 MB.
- This is a practical prototype, not sample-accurate native audio like Snapcast.
