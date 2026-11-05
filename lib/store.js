// lib/store.js
// Tiny persistence layer. The project only ever holds a handful of pending
// requests, so a single JSON file with atomic writes is enough and avoids a
// native database dependency.
const fs = require('fs');
const path = require('path');

const MAX_REQUESTS = 500;
const MAX_SEEN_INBOUND = 300;

class Store {
  constructor(file, log = console) {
    this.file = file;
    this.log = log;
    this.state = { requests: [], seenInbound: [] };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.requests)) {
        this.state = {
          requests: parsed.requests,
          seenInbound: Array.isArray(parsed.seenInbound) ? parsed.seenInbound : [],
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`⚠️  Could not read state file ${this.file}: ${err.message}`);
      }
    }
  }

  // Write to a temp file first so a crash never leaves a half-written state.
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  trim() {
    if (this.state.requests.length > MAX_REQUESTS) {
      this.state.requests = this.state.requests.slice(-MAX_REQUESTS);
    }
    if (this.state.seenInbound.length > MAX_SEEN_INBOUND) {
      this.state.seenInbound = this.state.seenInbound.slice(-MAX_SEEN_INBOUND);
    }
  }
}

module.exports = { Store };
