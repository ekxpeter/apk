import { Router, type IRouter } from "express";
import healthRouter from "./health";
import facebookRouter from "./facebook";
import authRouter from "./auth";
import accountsRouter from "./accounts";
import actionsRouter from "./actions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(accountsRouter);
router.use(actionsRouter);
router.use(facebookRouter);

export default router;
