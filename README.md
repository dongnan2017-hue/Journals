# Journal

A simple personal journal server. You write daily entries in a rich editor, with photos. Entries are stored as plain `.html` files in a dated folder structure so the content outlives the app.

```
entries/
└── 2026/
    ├── 2026-04-23.html       ← the entry (HTML from the editor)
    └── 2026-04-23/           ← photos uploaded that day
        ├── 1745...-xyz.jpg
        └── ...
```

Two roles, one password each:
- **Writer** — that's you. Can create/edit entries and upload photos.
- **Reader** — the password you will share with your daughter one day. Read-only.

## Run locally

1. [Install Node.js 20+](https://nodejs.org/)
2. In this folder:
   ```
   npm install
   copy .env.example .env
   ```
3. Open `.env` and set `WRITER_PASSWORD`, `READER_PASSWORD`, `SESSION_SECRET`.
4. Start it:
   ```
   npm start
   ```
5. Open http://localhost:3000

## Deploy to Fly.io (public URL)

See `DEPLOY.md` in the parent folder for the full walkthrough.

## Backup

Click **Backup** in the header (writer only) to download a zip of everything.
Do this regularly and keep copies in at least two places (e.g., OneDrive + an external drive).
