import "./load-env";
import { startWorker } from "@/lib/worker";

// Standalone worker: run this alongside `next start` with RUN_WORKER=0 on the web process.
startWorker();
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
// keep the event loop alive (the interval is unref'd so the web server can exit cleanly)
setInterval(() => undefined, 1 << 30);
