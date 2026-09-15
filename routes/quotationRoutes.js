// backend/routes/quotationRoutes.js
import express from "express";
import {
  getQuotations,
  getQuotationById,
  createQuotation,
  updateQuotation,
  updateQuotationStatus,
  acceptAndConvertToOrder,
} from "../controllers/quotationController.js";
import { protect } from "../middleware/authMiddleWare.js";

const router = express.Router();

router.get("/", protect, getQuotations);
router.get("/:id", protect, getQuotationById);
router.post("/", protect, createQuotation);
router.put("/:id", protect, updateQuotation);
router.patch("/:id/status", protect, updateQuotationStatus);
router.post("/:id/accept-and-convert", protect, acceptAndConvertToOrder);

export default router;
