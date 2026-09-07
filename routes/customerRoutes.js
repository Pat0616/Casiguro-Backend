// backend/routes/customerRoutes.js
import express from "express";
import { getCustomers } from "../controllers/customerController.js";
import { protect } from "../middleware/authMiddleWare.js";

const customerRouter = express.Router();

customerRouter.use(protect);

customerRouter.get("/", getCustomers);

export default customerRouter;
