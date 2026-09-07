// backend/routes/notificationRoutes.js
import express from "express";
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
} from "../controllers/notificationController.js";
import { protect } from "../middleware/authMiddleWare.js";

const notificationRouter = express.Router();

notificationRouter.use(protect);

notificationRouter.get("/", getNotifications);
notificationRouter.get("/unread-count", getUnreadCount);
notificationRouter.patch("/:id/read", markAsRead);
notificationRouter.patch("/read-all", markAllAsRead);

export default notificationRouter;

