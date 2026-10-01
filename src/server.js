const JOB_PRIORITY = {
  send: 1,
  history: 2,
  preview: 3,
  failure: 4,
  batch: 5,
};

const schedulerMetrics = {
  total: 0,
  processed: 0,
  failed: 0,
  retries: 0,
  byType: {},
  byTypeFailed: {},
  latency: {},
};

function recordSchedulerMetric(type, durationMs, ok) {
  schedulerMetrics.total += 1;
  schedulerMetrics.byType[type] = (schedulerMetrics.byType[type] || 0) + 1;
  schedulerMetrics.latency[type] = schedulerMetrics.latency[type] || { count: 0, total: 0 };
  schedulerMetrics.latency[type].count += 1;
  schedulerMetrics.latency[type].total += durationMs;

  if (!ok) {
    schedulerMetrics.failed += 1;
    schedulerMetrics.byTypeFailed[type] = (schedulerMetrics.byTypeFailed[type] || 0) + 1;
  } else {
    schedulerMetrics.processed += 1;
  }
}

const schedulerWorkers = {
  send: [],
  history: [],
  preview: [],
  failure: [],
  batch: [],
};

const schedulerQueue = {
  send: [],
  history: [],
  preview: [],
  failure: [],
  batch: [],
};

const schedulerState = {
  running: { send: false, history: false, preview: false, failure: false, batch: false },
};

function enqueueJob(type, jobId, jobFn, payload = {}, priority = JOB_PRIORITY[type] || 99) {
  const item = { id: jobId, type, fn: jobFn, payload, priority, retries: 0, createdAt: Date.now() };
  schedulerQueue[type].push(item);
  schedulerQueue[type].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  if (!schedulerState.running[type]) {
    schedulerState.running[type] = true;
    startSchedulerWorker(type);
  }
}

function getBackoffDelay(retries) {
  return Math.min(1000 * Math.pow(2, retries), 20000);
}

function startSchedulerWorker(type) {
  const worker = async () => {
    while (schedulerQueue[type].length) {
      const job = schedulerQueue[type].shift();
      if (!job) continue;

      try {
        const existing = await getJobDedup(job.id);
        if (existing && existing.status === 'completed') continue;

        if (!checkRateLimit(`job:${type}`, 50, 60)) {
          schedulerQueue[type].push(job);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        await recordJobDedup(job.id, type, job.payload, 'processing');
        const start = Date.now();
        await job.fn();
        const duration = Date.now() - start;
 
        await recordJobDedup(job.id, type, job.payload, 'completed');
        recordSchedulerMetric(type, duration, true);
      } catch (e) {
        const duration = Date.now() - job.createdAt;
        recordSchedulerMetric(type, duration, false);

        if (job.retries < 3) {
          job.retries += 1;
          schedulerMetrics.retries += 1;
          await incrementJobRetry(job.id);
          await new Promise(r => setTimeout(r, getBackoffDelay(job.retries)));
          schedulerQueue[type].push(job);
        } else {
          await recordJobDedup(job.id, type, job.payload, 'failed');
        }
      }
    }

    schedulerState.running[type] = false;

    if (schedulerQueue[type].length && !schedulerState.running[type]) {
      schedulerState.running[type] = true;
      setTimeout(worker, 0);
    }
  };

  schedulerWorkers[type].push(worker);
  setTimeout(worker, 0);
}

app.get('/api/scheduler-metrics', (req, res) => {
  const latencySnapshot = {};
  for (const [type, entry] of Object.entries(schedulerMetrics.latency || {})) {
    latencySnapshot[type] = {
      count: entry.count,
      avgMs: entry.count ? Math.round(entry.total / entry.count) : 0,
    };
  }

  res.json({
    total: schedulerMetrics.total,
    processed: schedulerMetrics.processed,
    failed: schedulerMetrics.failed,
    retries: schedulerMetrics.retries,
    byType: schedulerMetrics.byType,
    byTypeFailed: schedulerMetrics.byTypeFailed,
    latency: latencySnapshot,
    queue: {
      send: schedulerQueue.send.length,
      history: schedulerQueue.history.length,
      preview: schedulerQueue.preview.length,
      failure: schedulerQueue.failure.length,
      batch: schedulerQueue.batch.length,
    }
  });
});
