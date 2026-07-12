// Small leveled logger. Quiet by default in production, chatty in
// development. Timestamps are added in production so platform log viewers
// (Koyeb, journald, etc.) show useful lines.
const chalk = require('chalk');
const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] != null ? LEVELS[config.logLevel] : LEVELS.info;

function emit(level, colorFn, args) {
  if (LEVELS[level] > threshold) return;
  const label = config.isProduction
    ? `${new Date().toISOString()} [${level.toUpperCase()}]`
    : colorFn(`[${level}]`);
  const sink = level === 'error' ? console.error : console.log;
  sink(label, ...args);
}

module.exports = {
  error: (...a) => emit('error', chalk.red, a),
  warn: (...a) => emit('warn', chalk.yellow, a),
  info: (...a) => emit('info', chalk.cyan, a),
  debug: (...a) => emit('debug', chalk.gray, a),
  // For the startup banner, which is intentionally formatted by hand.
  print: (...a) => console.log(...a),
};
