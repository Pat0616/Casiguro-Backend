# Casiguro Transaction Management System — Backend

REST API and real-time server for the Casiguro Enterprises Transaction Management System. It tracks a printing /
products-and-services business from quotation to a paid, completed order.

**Stack:** Node.js · Express 5 · MySQL / MariaDB (`mysql2`) · Socket.IO · JWT cookie auth · Puppeteer (quotation PDFs) ·
ExcelJS (sales export) · Nodemailer (sign-up verification codes)

The frontend lives in its own repository, [`casiguro-app`](../casiguro-app).

## Requirements

- **Node.js 20+** (developed on Node 24)
- **MySQL 8 or MariaDB 10.4+**. Locally this is XAMPP's MySQL.
- The server should use **Manila time (UTC+8)**. SOA numbers and dates come from the database's `CURDATE()`.

## Setup

```bash
npm install
cp .env.sample .env              # then fill it in (see the comments in the file)
npm run db:setup                 # creates the database named in DB_NAME and all tables
npm run create-admin             # creates the first admin account (asks for details)
npx puppeteer browsers install chrome   # one time, needed for quotation PDFs
npm start                        # http://localhost:5000 (restarts on file changes)
```

Then start the frontend (see its README) and sign in with the admin you just created. Everyone else signs up on the
**Register** page and waits for an admin to approve them under **Accounts & Audit**.

> On Windows without `cp`, copy `.env.sample` to `.env` by hand.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the API with nodemon on `PORT` (default 5000). |
| `npm run db:setup` | Creates `DB_NAME` and applies `schema.sql`. Safe to re-run: existing tables and data are left alone. No demo data. |
| `npm run create-admin` | Creates an active admin. Needed once on a fresh install, because sign-up only creates pending employees. Optional flags: `--name`, `--email`, `--contact`. The password is always asked for. |
| `npm run migrate:*` | One-time upgrades for databases created **before** a feature existed. All of them are idempotent. **Back up the database first.** A fresh `db:setup` database doesn't need them. |
| `node scripts/seed.js` | Inserts fake demo orders, but only into an empty `orders` table. **Never run it on real data.** |

## Environment variables

All of them are listed with explanations in [`.env.sample`](.env.sample):

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Database connection |
| `PORT` | API port (default 5000) |
| `JWT_SECRET` | Signs login tokens. A long random value, different for every environment |
| `CLIENT_ORIGIN` | Frontend URL allowed by CORS and Socket.IO (default `http://localhost:5173`) |
| `MAIL_USER`, `MAIL_APP_PASSWORD`, `MAIL_FROM_NAME` | Gmail + App Password for sign-up codes. If empty, codes are printed to the console |

## Project layout

```
server.js            Express app, route mounting, Socket.IO start-up
database/db.js       MySQL connection pool (dateStrings: true)
routes/              URL → controller wiring, one file per area
controllers/         Request handlers (orders, quotations, catalog, accounts, auth, reports, …)
middleware/          protect (JWT + active-account check), requireAdmin
utils/               Shared logic: SOA numbers & document fields, payments, audit log, account rules,
                     PDF renderer, sales workbook, mailer
templates/           Quotation PDF HTML template
websocket/socket.js  Real-time events (orders, notifications, account changes)
scripts/             db:setup, create-admin, migrations, demo seed
schema.sql           Full database schema (SampleSchema.sql is an identical copy, keep them in sync)
```

API routes are mounted under `/api`: `auth`, `catalog`, `quotations`, `orders`, `notifications`, `customers`,
`accounts` (admin only) and `reports`.

## Good to know

- **Audit logs are append-only.** Database triggers block `UPDATE` and `DELETE` on `audit_logs`, so entries can't be
  cleaned up afterwards. Test risky changes against a copy database, e.g. `DB_NAME=casiguro_test npm run db:setup`.
- **Payments are never deleted.** Mistakes are voided by an admin, with a reason. An order's paid amount, balance and
  payment status are always recalculated from the payment log.
- **Quotation PDF logo.** The logo is read from the sibling frontend repo
  (`../casiguro-app/public/CasiguroEnterpriseLogo.png`). If it's missing, the company name prints as text instead.
- **Backups.** Before a migration, dump the database (e.g. with `mysqldump`) into `backups/`, which is git-ignored.

## Deploying

The current code targets a local MySQL. Before deploying (e.g. database on Aiven, API on DigitalOcean, frontend on
Vercel), these still need to change:

- connection **port and SSL** support for hosted MySQL;
- forcing the database session to **UTC+8**;
- a cross-site login cookie (`sameSite: "none"`, `secure: true`) when the frontend is on another domain;
- a copy of the **logo** inside this repo;
- **Chrome** available for Puppeteer on the server.

The setup steps are the same against the hosted database: point `.env` at it, then run `npm run db:setup` and
`npm run create-admin` once.
