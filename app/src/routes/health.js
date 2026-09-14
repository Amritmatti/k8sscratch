/**
 * Health endpoints for Kubernetes probes.
 *
 * The split matters:
 *
 *  - `/healthz` (liveness) checks only that the event loop is responsive. It
 *    deliberately does NOT touch the database: if Postgres goes down, killing
 *    every API pod turns an outage into a CrashLoopBackOff, and the pods come
 *    back no healthier than they left.
 *  - `/readyz` (readiness) DOES check the database, so a pod that cannot serve
 *    is removed from the Service endpoints while staying alive to recover.
 *  - `/startupz` (startup) gives a slow first connection time to settle
 *    without the liveness probe killing the pod mid-boot.
 */

import { Router } from 'express';

import { ping } from '../db/pool.js';
import { logger } from '../logger.js';
import { dbUp } from '../metrics.js';

export const healthRouter = Router();

/** Flipped by the shutdown handler so readiness fails before the pod dies. */
const state = { shuttingDown: false, started: false };

export function markStarted() {
  state.started = true;
}

export function beginShutdown() {
  state.shuttingDown = true;
}

export function isShuttingDown() {
  return state.shuttingDown;
}

/** Liveness: process is up. No dependencies. */
healthRouter.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

/** Readiness: this pod can serve traffic right now. */
healthRouter.get('/readyz', async (req, res) => {
  if (state.shuttingDown) {
    // Tell kube-proxy and the Istio sidecar to stop sending new requests.
    return res.status(503).json({ status: 'shutting_down' });
  }

  try {
    await ping();
    dbUp.set(1);
    return res.json({ status: 'ready', checks: { database: 'ok' } });
  } catch (err) {
    dbUp.set(0);
    logger.warn({ err: err.message }, 'Readiness check failed: database unreachable');
    return res.status(503).json({
      status: 'not_ready',
      checks: { database: 'unreachable' },
    });
  }
});

/** Startup: has the app finished booting? */
healthRouter.get('/startupz', (req, res) => {
  if (!state.started) {
    return res.status(503).json({ status: 'starting' });
  }
  return res.json({ status: 'started' });
});
