// backend/routes/orderRoutes.js
import express from "express";
import {
  getOrders,
  getOrderById,
  createOrder,
  updateOrder,
  updateOrderDocuments,
  updateItemProduction,
  getOrderPayments,
  recordPayment,
  voidPayment,
  cancelOrder,
} from "../controllers/orderController.js";
import { protect, requireAdmin } from "../middleware/authMiddleWare.js";

const orderRouter = express.Router();

orderRouter.use(protect);

orderRouter.get("/", getOrders);
orderRouter.get("/:id", getOrderById);
orderRouter.post("/", createOrder);
orderRouter.put("/:id", updateOrder);
orderRouter.put("/:id/documents", updateOrderDocuments);
orderRouter.put("/:id/production", updateItemProduction);
orderRouter.get("/:id/payments", getOrderPayments);
orderRouter.post("/:id/payments", recordPayment);
orderRouter.patch("/:id/payments/:paymentId/void", requireAdmin, voidPayment);
orderRouter.post("/:id/cancel", requireAdmin, cancelOrder);

export default orderRouter;
