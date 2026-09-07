// backend/routes/orderRoutes.js
import express from "express";
import { getOrders, getOrderById, createOrder, updateOrder } from "../controllers/orderController.js";
import { protect } from "../middleware/authMiddleWare.js";

const orderRouter = express.Router();

orderRouter.use(protect);

orderRouter.get("/", getOrders);
orderRouter.get("/:id", getOrderById);
orderRouter.post("/", createOrder);
orderRouter.put("/:id", updateOrder);

export default orderRouter;

