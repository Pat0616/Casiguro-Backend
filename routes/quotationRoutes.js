// backend/routes/quotationRoutes.js
import express from "express";
import {
  getQuotations,
  getQuotationById,
  getQuotationPdf,
  createQuotation,
  updateQuotation,
  updateQuotationStatus,
  acceptAndConvertToOrder,
} from "../controllers/quotationController.js";
import { protect } from "../middleware/authMiddleWare.js";

const router = express.Router();

router.get("/", protect, getQuotations);
router.get("/:id", protect, getQuotationById);
router.get("/:id/pdf", protect, getQuotationPdf);
router.post("/", protect, createQuotation);
router.put("/:id", protect, updateQuotation);
router.patch("/:id/status", protect, updateQuotationStatus);
router.post("/:id/accept-and-convert", protect, acceptAndConvertToOrder);

export default router;

