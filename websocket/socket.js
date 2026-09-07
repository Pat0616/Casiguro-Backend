// backend/websocket/socket.js
import { Server } from "socket.io";

let io = null;

export function initSocket(httpServer, clientOrigin) {
  io = new Server(httpServer, {
    cors: {
      origin: clientOrigin || "http://localhost:5173",
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    console.log(`[WebSocket] Client connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[WebSocket] Client disconnected (${socket.id}): ${reason}`);
    });

    socket.on("ping:client", () => {
      socket.emit("pong:server", { timestamp: Date.now() });
    });
  });

  return io;
}

export function getIO() {
  if (!io) {
    console.warn("[WebSocket] io has not been initialized yet!");
  }
  return io;
}

export function emitNotification(notification) {
  if (io) {
    io.emit("notification:new", notification);
  }
}

export function emitOrderCreated(order) {
  if (io) {
    io.emit("order:created", order);
  }
}

export function emitOrderUpdated(order) {
  if (io) {
    io.emit("order:updated", order);
  }
}
