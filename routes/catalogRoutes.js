// backend/routes/catalogRoutes.js
import express from "express";
import {
  getCatalogItems,
  createCatalogItem,
  updateCatalogItem,
  toggleCatalogItemStatus,
} from "../controllers/catalogController.js";
import { protect, requireAdmin } from "../middleware/authMiddleWare.js";

const router = express.Router();

router.get("/", protect, getCatalogItems);
router.post("/", protect, requireAdmin, createCatalogItem);
router.put("/:id", protect, requireAdmin, updateCatalogItem);
router.patch("/:id/status", protect, requireAdmin, toggleCatalogItemStatus);

export default router;

