'use strict';

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

  // Block providers that fail too much
  return h.score > -5;
}

function getScore(name) {
  return (health.get(name)?.score) || 0;
}

module.exports = {
  markSuccess,
  markFailure,
  isHealthy,
  getScore
};