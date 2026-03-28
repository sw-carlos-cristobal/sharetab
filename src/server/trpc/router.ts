import { createTRPCRouter } from "./init";
import { authRouter } from "./routers/auth";
import { groupsRouter } from "./routers/groups";
import { expensesRouter } from "./routers/expenses";
import { balancesRouter } from "./routers/balances";
import { settlementsRouter } from "./routers/settlements";
import { activityRouter } from "./routers/activity";
import { receiptsRouter } from "./routers/receipts";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  groups: groupsRouter,
  expenses: expensesRouter,
  balances: balancesRouter,
  settlements: settlementsRouter,
  activity: activityRouter,
  receipts: receiptsRouter,
});

export type AppRouter = typeof appRouter;
