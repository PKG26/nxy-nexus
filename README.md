# NXY NEXUS

NXY NEXUS is a Node.js marketplace app with server-backed accounts, collector dashboards, an administrator console, listings, favorites, bid records, sale records, and editable public-site settings.

## Local run

Use Node.js 24 or later. From this folder, run `npm start` and open `http://localhost:3000`. The SQLite database is created in `data/nxy.sqlite` by default. Set `NXY_DATA_DIR` to a persistent data directory if your host provides one.

## First administrator account

On a fresh database, the first account created receives the administrator role. Later accounts are collectors. Keep the site unpublished until you are ready to create the owner account; once the temporary URL is public, someone else could register first. `/admin.html` requires an administrator login and the server checks administrator permission for its control APIs.

## Hostinger deployment

Hostinger's managed Node.js web apps are available on Business and Cloud plans. Its deployment flow accepts a ZIP and can create a temporary URL. Choose Node.js 24, upload the ZIP, use `server.mjs` as the entry file if prompted, and set `NODE_ENV=production`. The app reads the assigned `PORT` environment variable.

The app currently uses Node's built-in SQLite database. Before public launch, confirm that the selected Hostinger runtime keeps the app's `data` directory across restarts and deployments. If it does not, use Hostinger VPS with persistent disk storage or migrate the database to Hostinger MySQL. Keep database backups and do not publish before claiming the first admin account.

## Admin controls

The admin console can edit public content and listings, manage collector accounts, toggle marketplace features, and edit/delete bid and sale records. The admin console can configure deposit network, asset, and receiving address. Collector deposits remain pending until an administrator verifies the submitted transaction reference; approval credits the site ledger balance. The collector mint flow uses three steps: create a collection, add NFT artwork and metadata, then set sale type, price, and edition size. The request form does not ask for a wallet address. Artwork can be uploaded (up to 4 MB) or supplied by public URL. Requests enter an admin queue, and publishing requires an administrator to provide a confirmed transaction hash from an external mint. These are manual ledger workflows: the site does not independently verify deposits, connect wallets, mint tokens, escrow funds, or execute on-chain purchases. Admin changes to bid and sale records update the site database only.

## Current marketplace boundary

Signup, login, favorite saves, listings, and bid records use persistent application data. The marketplace does not yet connect a crypto wallet, independently verify crypto deposits, mint tokens, escrow funds, or execute on-chain purchases. The initial database starts without seeded/sample listings; add genuine listings through the admin console.
