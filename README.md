# WebReader (on-device)

Server-free build of [WebReader](https://github.com/Utility-SOC/webreader) for phones/browsers: RSVP speed reading with on-device OCR (photos, scanned PDFs), PDF text, TXT, and the touch-friendly manual box editor (drag, corner-drag, two-finger pinch resize).

- `docs/` - the prebuilt site served by GitHub Pages (Settings -> Pages -> Deploy from branch -> `main` / `/docs`).
- `frontend/` - source. Rebuild: `cd frontend && npm install && npm run build:local`, then copy `dist-local/*` to `docs/`.

On iPhone: open the Pages URL in Safari -> Share -> Add to Home Screen. Run one OCR while online so the engine is cached for offline use.
