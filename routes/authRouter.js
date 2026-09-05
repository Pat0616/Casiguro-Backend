import express from "express";

import {
  register,
  login,
  logout,
  getMe,
} from "../controllers/authController.js";


import { protect } from "../middleware/authMiddleWare.js";
const authRouter = express.Router();
authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/logout", logout);
authRouter.get("/me", protect, getMe);
export default authRouter;