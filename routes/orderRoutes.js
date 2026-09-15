// backend/routes/orderRoutes.js
import express from "express";
import {
  getOrders,
  getOrderById,
  createOrder,
  updateOrder,
  updateItemProduction,
  recordPayment,
} from "../controllers/orderController.js";
import { protect } from "../middleware/authMiddleWare.js";

const orderRouter = express.Router();

orderRouter.use(protect);

orderRouter.get("/", getOrders);
orderRouter.get("/:id", getOrderById);
orderRouter.post("/", createOrder);
orderRouter.put("/:id", updateOrder);
orderRouter.put("/:id/production", updateItemProduction);
orderRouter.post("/:id/payment", recordPayment);

export default orderRouter;
