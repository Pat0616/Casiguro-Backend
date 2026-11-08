import express from "express";

import {
  startRegistration,
  verifyRegistration,
  resendRegistrationCode,
  login,
  logout,
  getMe,
  changePassword,
  startPasswordReset,
  resetPassword,
} from "../controllers/authController.js";


import { protect } from "../middleware/authMiddleWare.js";
const authRouter = express.Router();
// Registration: email a code first; the pending account is created only after the code is verified
authRouter.post("/register/start", startRegistration);
authRouter.post("/register/verify", verifyRegistration);
authRouter.post("/register/resend", resendRegistrationCode);
authRouter.post("/login", login);
authRouter.post("/logout", logout);
authRouter.get("/me", protect, getMe);
// Passwords: change your own while signed in, or reset a forgotten one with an emailed code (start also resends)
authRouter.post("/change-password", protect, changePassword);
authRouter.post("/forgot-password/start", startPasswordReset);
authRouter.post("/forgot-password/reset", resetPassword);
export default authRouter;
