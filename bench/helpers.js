import { Trend, Counter } from "k6/metrics";
import { RUN_ID } from "./config.js";

// Generate a unique room name per VU and scenario
export function roomName(scenario, vuId) {
  return `bench-${RUN_ID}-${scenario}-vu${vuId}`;
}

// Generate a unique sender name per VU and scenario
export function senderName(scenario, vuId) {
  return `bench-sender-${scenario}-vu${vuId}`;
}

// Simple UUID v4 generator (good enough for bench IDs)
export function uuid() {
  const hex = "0123456789abcdef";
  let id = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      id += "-";
    } else if (i === 14) {
      id += "4";
    } else if (i === 19) {
      id += hex[(Math.random() * 4) | 8];
    } else {
      id += hex[(Math.random() * 16) | 0];
    }
  }
  return id;
}

// Custom metric factories
export function createTrend(name) {
  return new Trend(name, true);
}

export function createCounter(name) {
  return new Counter(name);
}
