# Deploying the backend to a DigitalOcean droplet

Target: the **$6 droplet** (1 vCPU, 1 GB RAM, 25 GB disk), **Ubuntu 24.04 LTS x64**. The database stays on
**Aiven MySQL**, so the droplet only runs Node, pm2, Chrome (for quotation PDFs) and Caddy (HTTPS).

```
browser ──HTTPS──▶ Caddy :443 ──▶ Node (pm2) 127.0.0.1:5000 ──SSL──▶ Aiven MySQL
```

Replace these placeholders throughout:

| Placeholder | Example |
|---|---|
| `<DROPLET_IP>` | `164.90.1.2` (from the DigitalOcean dashboard) |
| `<API_DOMAIN>` | `api.casiguro.com`, or without a domain: `164-90-1-2.sslip.io` (the IP with dashes) |
| `<FRONTEND_URL>` | `https://casiguro.vercel.app` (no trailing slash) |

## 1. Create the droplet

- Image **Ubuntu 24.04 (LTS) x64**, plan Basic / Regular / **$6**, a region close to the users (**Singapore**).
- Authentication: **SSH key** (safer than a password). On Windows: `ssh-keygen -t ed25519` in PowerShell, then paste
  the contents of `C:\Users\<you>\.ssh\id_ed25519.pub` into DigitalOcean.
- After it starts, copy its IPv4 address.

**Domain:** if you have one, add an `A` record `api` → `<DROPLET_IP>` at your DNS provider and wait until
`nslookup <API_DOMAIN>` shows the IP. Without a domain, use `<ip-with-dashes>.sslip.io`; it already points at the IP.

## 2. First login: user, firewall, swap

```bash
ssh root@<DROPLET_IP>

# A normal user to run the app (not root)
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Firewall: SSH + HTTP + HTTPS only. Port 5000 stays closed (Caddy talks to Node locally)
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# 2 GB swap: 1 GB RAM is tight while Chrome renders a PDF or npm installs packages
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl --system

# Server clock in Manila time (logs are easier to read; the database time zone is set by the app)
timedatectl set-timezone Asia/Manila

apt update && apt upgrade -y
exit
```

From now on log in as `ssh deploy@<DROPLET_IP>`.

## 3. Install Node 24, pm2, Chrome libraries, fonts, Caddy

```bash
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git
node -v            # v24.x

sudo npm install -g pm2

# Fonts for the quotation PDF (the ₱ sign and Arial-like text). Ubuntu servers ship almost no fonts
sudo apt install -y fonts-liberation fonts-dejavu-core fonts-noto-core

# Caddy (reverse proxy with automatic HTTPS certificates)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 4. Get the code

```bash
cd ~
git clone https://github.com/Pat0616/Casiguro-Backend.git backend
cd backend
npm ci --omit=dev

# Chrome for Puppeteer, plus the Linux libraries it needs (asks for the sudo password)
npx puppeteer browsers install chrome --install-deps
```

If the repo is **private**, `git clone` asks for a username and password: use your GitHub username and a
**personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens, read-only access to this repo)
as the password.

## 5. Configuration (.env and the Aiven certificate)

Copy the Aiven CA certificate from your PC (run this in PowerShell on Windows, in the `backend` folder):

```powershell
ssh deploy@<DROPLET_IP> "mkdir -p ~/backend/certs"
scp certs\ca.pem deploy@<DROPLET_IP>:~/backend/certs/ca.pem
```

Then on the droplet, `cp .env.sample .env && nano .env` and set:

```ini
DB_HOST=<aiven host>
DB_PORT=<aiven port>
DB_USER=avnadmin
DB_PASSWORD=<aiven password>
DB_NAME=<same name you used with db:setup>
DB_SSL_CA=certs/ca.pem
DB_SSL=
DB_TIMEZONE=+08:00

NODE_ENV=production
PORT=5000
HOST=127.0.0.1
TRUST_PROXY=loopback
CLIENT_ORIGIN=<FRONTEND_URL>

# New secret for production, not the one from your PC. Generate it on the droplet with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=<paste the generated value>

# Email through the Gmail API (see "Email with the Gmail API" below)
MAIL_USER=<gmail address>
MAIL_FROM_NAME=Casiguro Enterprises
GMAIL_CLIENT_ID=<...apps.googleusercontent.com>
GMAIL_CLIENT_SECRET=<GOCSPX-...>
GMAIL_REFRESH_TOKEN=<1//... from npm run gmail:auth>
MAIL_APP_PASSWORD=
RESEND_API_KEY=
```

```bash
chmod 600 .env
```

**Aiven:** if the service's **Allowed IP addresses** list is restricted, add `<DROPLET_IP>/32`.

Check the database connection and create the tables (safe if they already exist), then the first admin if there is none:

```bash
npm run db:setup
npm run create-admin
```

## 6. Run it with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs casiguro-api --lines 20     # expect "Server running on 127.0.0.1:5000 ... (production ...)"
curl http://127.0.0.1:5000/api/health   # {"status":"ok"}

# Start again after a reboot
pm2 startup systemd      # prints a "sudo env PATH=... pm2 startup ..." command: copy and run it
pm2 save

# Keep logs from filling the disk
pm2 install pm2-logrotate
```

## 7. HTTPS with Caddy

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the whole file with:

```
<API_DOMAIN> {
	encode gzip
	reverse_proxy 127.0.0.1:5000
}
```

```bash
sudo systemctl reload caddy
curl https://<API_DOMAIN>/api/health    # {"status":"ok"}  (the first request may take a few seconds while Caddy gets the certificate)
```

Caddy renews the certificate by itself and passes WebSocket (live updates) traffic through without extra settings.

## 8. Point the frontend at it

In the frontend's hosting settings (e.g. Vercel → Project → Settings → Environment Variables):

```
VITE_API_URL=https://<API_DOMAIN>
```

Redeploy the frontend (Vite bakes the value in at build time). `CLIENT_ORIGIN` in the backend `.env` must be the exact
frontend URL; after changing it run `pm2 restart casiguro-api`.

## 9. Check everything

- Sign in, then reload the page: still signed in → the cookie works.
- Open the app in two browsers, change an order in one → it updates in the other (WebSocket).
- Open a quotation → **View PDF** shows the logo and ₱ amounts.
- Register with a real email → the code arrives (see Email below).
- Accounts & Audit → your login shows your real IP, not `127.0.0.1`.

## Email with the Gmail API

DigitalOcean blocks outgoing SMTP (ports 25/465/587) on new accounts, so the Gmail App Password (SMTP) doesn't work
from the droplet. The server sends through the **Gmail API** instead: same Gmail account, but over HTTPS. Free, no
domain needed, about 500 emails a day. Sent codes show up in that account's **Sent** folder.

Do steps 1–3 once, **signed in to Google as the Gmail account that sends the emails** (`MAIL_USER`).

**1. Google Cloud project** (console.cloud.google.com)
- Project picker (top bar) → **New project**, name `Casiguro TMS` → Create, and select it.
- **APIs & Services → Library** → search **Gmail API** → **Enable**.

**2. Consent screen** (**Google Auth Platform**, also listed as **APIs & Services → OAuth consent screen**)
- **Get started**: app name `Casiguro TMS`, support email = the Gmail account, audience **External**, contact
  email = the same → Create.
- **Audience → Publish app → Confirm**, so the status says **In production**. Don't skip this: while the app is in
  "Testing", Google expires the token after 7 days and emails stop. No Google review is needed, because only you
  sign in to it.

**3. OAuth client**
- **Clients → Create client**, application type **Desktop app**, name `Casiguro backend` → Create.
- Copy the **Client ID** (`...apps.googleusercontent.com`) and **Client secret** (`GOCSPX-...`).

**4. Get the refresh token (on your PC, which has a browser)**
- In your PC's `backend/.env` set `MAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, then run:
  ```
  npm run gmail:auth
  ```
- The browser opens. Choose the Gmail account. Google warns **"Google hasn't verified this app"**: that's expected
  for your own app. Click **Advanced → Go to Casiguro TMS (unsafe)**, tick **Send email on your behalf**, Continue.
- The terminal prints `GMAIL_REFRESH_TOKEN=1//...`. Paste that line into your PC's `.env` and test a sign-up
  locally: the code should arrive and appear in the account's Sent folder.

**5. On the droplet**: put the same four values (`MAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`) in `.env`, leave `MAIL_APP_PASSWORD` and `RESEND_API_KEY` blank, then
`pm2 restart casiguro-api`.

**If email stops working later**, `pm2 logs casiguro-api` shows the reason. "invalid_grant" means the token was
revoked: this happens if the Gmail account's **password is changed**, its access is removed under Google Account →
Security → Third-party connections, the token goes unused for 6 months, or the app was left in Testing. Fix: run
`npm run gmail:auth` again on your PC and replace `GMAIL_REFRESH_TOKEN` on the droplet. While email is broken,
sign-up and forgot-password show an error; everything else keeps working.

(If the business ever gets its own domain, Resend also works: set `RESEND_API_KEY` and `MAIL_FROM`, see `.env.sample`.)

## Updating after a code change

Push from your PC, then on the droplet:

```bash
cd ~/backend
git pull
npm ci --omit=dev
npm run migrate:<name>      # only if the change added a migration (back up the database first)
pm2 reload casiguro-api
```

## Memory on 1 GB

Typical use: Node ~100–150 MB, Chrome ~150–250 MB while a PDF renders (it closes after 5 idle minutes,
`PDF_BROWSER_IDLE_MS`), Caddy ~30 MB, Ubuntu ~250 MB. That fits, with swap as a safety net. Check with `free -h` and
`pm2 monit`. If swap is used heavily all the time, resize the droplet to 2 GB (DigitalOcean → Resize, takes a minute).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Signed in, but the next request says "Not authorized" | `NODE_ENV=production` missing, or the frontend uses `http://`. The cookie needs HTTPS on both. |
| Browser console: CORS error | `CLIENT_ORIGIN` doesn't exactly match the frontend URL (scheme, no trailing slash). `pm2 restart casiguro-api` after editing. |
| `ETIMEDOUT` to the database | Wrong `DB_PORT`, or the droplet IP isn't in Aiven's allowed IPs. |
| `DB_SSL_CA file not found` | `certs/ca.pem` wasn't copied (step 5). |
| PDF fails: "Could not find Chrome" / missing `.so` library | Re-run `npx puppeteer browsers install chrome --install-deps` as the `deploy` user. |
| Caddy has no certificate | DNS doesn't point at the droplet yet, or ports 80/443 aren't open (`sudo ufw status`). `sudo journalctl -u caddy -n 50`. |
| App stops after a while | `pm2 logs casiguro-api --err`; `dmesg | grep -i kill` shows out-of-memory kills. |
