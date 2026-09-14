/**
 * Prometheus metrics.
 *
 * Exposed on a separate port from the API so the scrape endpoint is never
 * reachable through the Istio Gateway — request rates, latencies and the
 * employee count are operational data, not public.
 */

import client from 'prom-client';

import { config } from './config.js';

export const registry = new client.Registry();

registry.setDefaultLabels({ service: 'employee-api', env: config.env });

if (config.metrics.enabled) {
  client.collectDefaultMetrics({ register: registry, prefix: 'employee_api_' });
}

export const httpRequestDuration = new client.Histogram({
  name: 'employee_api_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  // Tuned for a small CRUD API: most responses land under 100 ms.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'employee_api_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const dbUp = new client.Gauge({
  name: 'employee_api_db_up',
  help: '1 when the last database health check succeeded, 0 otherwise',
  registers: [registry],
});

export const employeeCount = new client.Gauge({
  name: 'employee_api_employees_total',
  help: 'Number of employee records',
  registers: [registry],
});

/** Express middleware that records duration and outcome for every request. */
export function metricsMiddleware(req, res, next) {
  if (!config.metrics.enabled) return next();

  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // Use the matched route pattern, not the raw URL: /api/employees/42
    // would otherwise create a new time series per employee.
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : req.baseUrl || 'unmatched';
    const labels = { method: req.method, route, status: res.statusCode };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  return next();
}
