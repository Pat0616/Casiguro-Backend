import express from "express";
import http from "http";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRouter from "./routes/authRoutes.js";
import orderRouter from "./routes/orderRoutes.js";
import notificationRouter from "./routes/notificationRoutes.js";
import customerRouter from "./routes/customerRoutes.js";
import catalogRouter from "./routes/catalogRoutes.js";
import categoryRouter from "./routes/categoryRoutes.js";
import quotationRouter from "./routes/quotationRoutes.js";
import accountRouter from "./routes/accountRoutes.js";
import reportRouter from "./routes/reportRoutes.js";
import { initSocket } from "./websocket/socket.js";
import pool from "./database/db.js";
import { closePdfBrowser } from "./utils/pdfRenderer.js";
import { clientOrigins, isProduction, trustProxySetting } from "./utils/runtimeConfig.js";

dotenv.config();
const app = express();
const httpServer = http.createServer(app);

app.set("trust proxy", trustProxySetting());
app.disable("x-powered-by");

// Initialize WebSocket server
initSocket(httpServer, clientOrigins);

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: clientOrigins,
    credentials: true,
  })
);

app.use("/api/auth", authRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/categories", categoryRouter);
app.use("/api/quotations", quotationRouter);
app.use("/api/orders", orderRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/customers", customerRouter);
app.use("/api/accounts", accountRouter);
app.use("/api/reports", reportRouter);

app.get("/", (req, res) => {
  res.send("CASIGURO Enterprises API is running...");
});

// Health check for uptime monitors: also confirms the database answers
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "database unavailable" });
  }
});

const PORT = process.env.PORT || 5000;
// HOST=127.0.0.1 in production keeps the API reachable only through the reverse proxy
const HOST = process.env.HOST || undefined;
httpServer.listen(PORT, HOST, () =>
  console.log(
    `Server running on ${HOST || "all interfaces"}:${PORT} with WebSocket enabled` +
      ` (${isProduction ? "production" : "development"}; allowed origins: ${clientOrigins.join(", ")})`
  )
);

// pm2 restarts and deploys send SIGINT/SIGTERM: finish open requests, then close Chrome and the database pool
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  httpServer.close();
  await Promise.allSettled([closePdfBrowser(), pool.end()]);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));