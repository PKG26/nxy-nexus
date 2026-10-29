# NXY NEXUS deployment notes

## Project inventory

- One Node.js application: `server.mjs` serves the public HTML/JS and the account/admin API.
- Node.js 24 or later; no third-party npm packages are required. The app uses Node built-ins, including `node:sqlite`.
- `npm start` launches the server. It listens on Hostinger's `PORT` when set.
- Persistent application data: SQLite database `data/nxy.sqlite` by default. Set `NXY_DATA_DIR` to select another writable persistent directory.
- The database stores user accounts, password hashes, sessions, settings, marketplace records, deposits, and mint requests. NFT image uploads are kept as data URLs in the database.
- Public live chat stores anonymous visitor conversations in the same SQLite database. Visitors can see replies again from the same browser.
- `NODE_ENV=production` enables the Secure session cookie flag.

## Deployment bundle

`NXY-NEXUS-deploy.zip` contains the application source and `package.json`, but excludes `data/` and all local SQLite files. This protects the local database from being uploaded or overwritten. A fresh production database will be created after first launch; public signup creates collector accounts only. Use the private one-time setup below to create the administrator. Local accounts and records are not copied automatically.

## Render free preview

This project is prepared for a Render Node web service by `render.yaml` and `.node-version`.

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Runtime: Node.js 24.21.0
- Environment: `NODE_ENV=production`; `NXY_DATA_DIR=/tmp/nxy-nexus-data`
- The first administrator can be claimed once from `/admin-setup.html`; no Render setup key is required. Public signup always creates collector accounts.

The service uses a SQLite database, and Render's free web service does not provide persistent disk storage. The configured `/tmp` location is temporary too. Accounts, sessions, marketplace records, deposits, mint requests, and uploaded images can be lost when the service sleeps, restarts, or deploys. Render describes free instances as intended for testing, hobby projects, or previews, and says not to use them for production. Use this setup to preview the live website only; preserving real user accounts requires paid persistent storage or a database migration before accepting real users.

### One-time administrator setup

1. Wait for the latest deployment to show **Live**.
2. Open `https://YOUR-RENDER-SERVICE.onrender.com/admin-login.html` and choose **First time here? Claim and create the admin account**.
3. Enter the administrator name, email, and a unique password of at least 12 characters. The first claim is created as the only administrator and signs you in. Once an administrator exists, the claim link disappears and `/admin-setup.html` redirects to admin sign-in.
4. Later, sign in at `/admin-login.html`.

The first claim is open to whoever creates the first administrator, so complete it as soon as the deployment is live. The current Render free configuration stores SQLite in temporary `/tmp` storage. Admin and user accounts can disappear on restart or deployment, which can make the claim link available again. Set up persistent storage or migrate the database before relying on the account for a live service.

## Upload to GitHub and create the Render service

1. In GitHub, create a **new private repository** named `nxy-nexus`. Leave the options to add a README, `.gitignore`, or license unchecked so the repository starts empty.
2. Open PowerShell in this project folder (`outputs`) and run the following, replacing `YOUR_GITHUB_NAME` with your GitHub username:

   ```powershell
   git init -b main
   git add .
   git status --short
   git commit -m "Prepare NXY NEXUS for Render"
   git remote add origin https://github.com/YOUR_GITHUB_NAME/nxy-nexus.git
   git push -u origin main
   ```

   Check `git status --short` before committing. The ignore rules exclude the local SQLite database, `.env` files, `node_modules`, and ZIP bundles. Do not force-push if GitHub reports a conflict; stop and inspect the repository first.
3. In Render, choose **New → Blueprint** and connect the new GitHub repository. Render reads `render.yaml` and shows the service configuration for review. Confirm it is a free web service before creating it. Creating the service starts a deployment, so do this only when you are ready to publish.
4. After Render reports the service is live, open its `onrender.com` URL and check `/api/health` for `{"ok":true}`. Then open the public page and verify signup/login. Because free storage is temporary, do not treat any accounts or transactions created there as durable.

The `render.yaml` file sets the same commands and settings if you create a Web Service manually instead of using a Blueprint.

## Recommended persistent production setup

Use a server with Node.js 24+ and persistent writable storage. Since this app currently uses SQLite, a Hostinger VPS is the most direct fit if you have one: keep `NXY_DATA_DIR` on the VPS disk, run `npm start` as a managed service, and place HTTPS/reverse proxy in front of the app. The code already honors `PORT` and `NXY_DATA_DIR`.

Hostinger's managed Node.js web app can deploy a ZIP, but each deployment uses versioned build directories. The app's default SQLite path is beside the running source, so do not assume the database will survive a redeploy there. Before production use, confirm with Hostinger that your plan offers a persistent writable directory and set `NXY_DATA_DIR` to that path. Otherwise use a VPS or migrate the database to a managed database with a corresponding code change.

## Hostinger custom domain

1. In hPanel, open **Websites → Create website → Web App / Node.js**. Upload `NXY-NEXUS-deploy.zip` and select Node.js 24.
2. Set the start command to `npm start` (or entry file `server.mjs`, if prompted). Set `NODE_ENV=production` and configure `NXY_DATA_DIR` only after confirming the persistent path.
3. Deploy and open the temporary URL. Confirm `/api/health` returns `{"ok":true}`.
4. In the website dashboard, choose **Connect domain** and select `nxynxs.com`. If hPanel requests DNS changes, use the exact records shown there. Do not guess an IP address.
5. Wait for DNS/SSL setup, then test `https://nxynxs.com`, signup, login, dashboard, and admin access.
6. Register the owner account first and verify its administrator access before sharing the URL. Keep a separate database backup.

If you use email on `nxynxs.com`, preserve its MX and email-authentication DNS records when changing nameservers.

## Free hosting note

Render free services can run Node.js for a preview, but the filesystem is ephemeral and services can spin down. SQLite data and uploaded images can be lost on restarts/redeploys. Render's free Postgres expires after 30 days. This is not a safe production setup for NXY accounts and marketplace records. A reliable production deployment needs paid persistent storage or a database migration.
