"use strict";
// Health Module
// 2026 Refactored for Robustness, Clarity, and Performance
// Implements a simple health tracking system for providers with auto-recovery after cooldown
// This allows the aggregator to deprioritize consistently failing providers while giving them a chance to recover without manual intervention, improving overall reliability and user experience

const health = new Map();

function markSuccess(name) {
  const h = health.get(name) || { score: 0 };
  h.score += 1;
  h.lastSuccess = Date.now();
  health.set(name, h);
}

function markFailure(name) {
  const h = health.get(name) || { score: 0 };
  h.score -= 2;
  h.lastFail = Date.now();
  health.set(name, h);
}

function isHealthy(name) {
  const h = health.get(name);
  if (!h) return true;

  // Auto-recover after 5 minutes since last failure
  if (h.score <= -5 && h.lastFail && Date.now() - h.lastFail > 5 * 60 * 1000) {
    console.log(`♻️  Health reset for ${name} after cooldown`);
    h.score = 0;
    health.set(name, h);
    return true;
  }

  return h.score > -5;
}

function getScore(name) {
  return health.get(name)?.score || 0;
}

module.exports = {
  markSuccess,
  markFailure,
  isHealthy,
  getScore,
};
