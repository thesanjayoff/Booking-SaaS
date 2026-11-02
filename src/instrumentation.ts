export async function register() {
  // Runs once when the Next server boots. The queue worker lives in the same process by default
  // (RUN_WORKER=0 to disable and run `npm run worker` separately instead).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.RUN_WORKER === "0" || process.env.RUN_WORKER === "false") return;
  try {
    const { startWorker } = await import("./lib/worker");
    startWorker();
  } catch (e) {
    console.error("[worker] failed to start:", e);
  }
}
