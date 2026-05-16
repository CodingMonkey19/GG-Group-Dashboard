/**
 * pino logger with line-item redaction.
 *
 * Constitution Data Integration Constraints: "the backend MUST NOT log raw
 * invoice line items at INFO level". The redaction policy below strips
 * known PII-bearing fields before they reach any sink. DEBUG level retains
 * the full payload — operators get a one-time warning that DEBUG is
 * PII-bearing the first time it's seen.
 */

import { pino, type LoggerOptions } from 'pino';

const REDACT_PATHS = [
  '*.line_items',
  '*.line_items[*].*',
  '*.amount',
  '*.native_amount',
  '*.eur_amount',
  '*.price',
  '*.invoice_total',
  '*.payer',
  '*.payee',
  'invoice.*',
  'invoices[*].native_amount',
  'invoices[*].eur_amount',
  'invoices[*].artifact_ref',
];

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
    remove: false,
  },
  base: {
    app: 'gg-spend-dashboard-backend',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const isDevPretty = process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY !== '0';

export const logger = pino(
  isDevPretty
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
        },
      }
    : baseOptions,
);

let warnedDebugPii = false;

/**
 * Wrap logger.debug to emit a one-time warning that DEBUG-level logs may
 * carry PII (raw invoice fields). Operators acknowledge the risk by
 * choosing the level explicitly.
 */
export function debug(message: string, payload?: Record<string, unknown>): void {
  if (!warnedDebugPii) {
    warnedDebugPii = true;
    logger.warn(
      'DEBUG-level logging is enabled — payloads may include raw invoice fields ' +
        '(line items, amounts, artifact refs). PII redaction does NOT apply at DEBUG.',
    );
  }
  logger.debug(payload ?? {}, message);
}
