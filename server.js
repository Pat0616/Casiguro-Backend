import express from "express";
import http from "http";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRouter from "./routes/authRoutes.js";
import orderRouter from "./routes/orderRoutes.js";
import notificationRouter from "./routes/notificationRoutes.js";
import customerRouter from "./routes/customerRoutes.js";
import { initSocket } from "./websocket/socket.js";

dotenv.config();
const app = express();
const httpServer = http.createServer(app);

const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";

// Initialize WebSocket server
initSocket(httpServer, clientOrigin);

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: clientOrigin,
    credentials: true,
  })
);

app.use("/api/auth", authRouter);
app.use("/api/orders", orderRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/customers", customerRouter);

app.get("/", (req, res) => {
  res.send("CASIGURO Enterprises API is running...");
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT} with WebSocket enabled`));