# Resonance

A small browser-based live-show prototype. A producer creates a show and gets a room code and QR join link. Audience phones join in a browser, choose Zone A or B, and receive real-time colour cues and optional tones over WebSockets.

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000` to start a show.

To test with phones on the same Wi-Fi, open the producer page using your computer's local network address (for example, `http://192.168.1.25:3000`) rather than `localhost`. Scan the QR code from a phone. The Wi-Fi network must allow devices to communicate with each other.

## Deploy from GitHub with Render

1. Create a GitHub repository and upload the contents of this project.
2. In Render, create a **Web Service** connected to that repository.
3. Use:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Deploy. Open the Render URL, start a show, then scan the QR code with phones.

The app automatically uses Render's `PORT` and switches to secure WebSockets when served over HTTPS.

## Notes

- Room state is held in server memory and expires after four hours. Restarting or redeploying the service clears active rooms.
- This is a prototype, not a production-scale concert system. It has no login, persistent storage, analytics, or acoustic seat detection.
- Browsers require a user gesture before playing audio. The join button unlocks audio where supported; attendees can mute from their screen.
- For a public event, use a persistent hosting plan and load-test the server with your expected audience size.
