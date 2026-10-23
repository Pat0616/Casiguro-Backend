import express from "express";

import {
  startRegistration,
  verifyRegistration,
  resendRegistrationCode,
  login,
  logout,
  getMe,
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
export default authRouter;