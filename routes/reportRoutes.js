// backend/routes/reportRoutes.js
import express from "express";
import { exportSalesExcel } from "../controllers/reportController.js";
import { protect } from "../middleware/authMiddleWare.js";

const reportRouter = express.Router();

reportRouter.use(protect);

reportRouter.get("/sales.xlsx", exportSalesExcel);

export default reportRouter;
