// backend/routes/accountRoutes.js
import express from "express";
import {
  getAccounts,
  getPendingCount,
  approveAccount,
  rejectAccount,
  deactivateAccount,
  reactivateAccount,
  promoteToAdmin,
  getAccountAuditLogs,
  exportAccountAuditLogs,
} from "../controllers/accountController.js";
import { protect, requireAdmin } from "../middleware/authMiddleWare.js";

const accountRouter = express.Router();

// Every account-management endpoint is admin-only on the server, not just hidden in the UI
accountRouter.use(protect, requireAdmin);

accountRouter.get("/", getAccounts);
accountRouter.get("/pending-count", getPendingCount);
accountRouter.patch("/:id/approve", approveAccount);
accountRouter.patch("/:id/reject", rejectAccount);
accountRouter.patch("/:id/deactivate", deactivateAccount);
accountRouter.patch("/:id/reactivate", reactivateAccount);
accountRouter.post("/:id/promote", promoteToAdmin);
accountRouter.get("/:id/audit-logs", getAccountAuditLogs);
accountRouter.get("/:id/audit-logs/export", exportAccountAuditLogs);

export default accountRouter;
