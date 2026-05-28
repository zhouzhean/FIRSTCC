// index_recorder.js — Records 上证/深证/北证50 intraday prices every 60s during trading hours
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../config');

const DATA_DIR = path.join(config.DATA_DIR, 'simfolio');

const INDEX_URL = 'https://hq.sinajs.cn/list=s_sh000001,s_sz399001,s_bj899050';
const RECORD_INTERVAL_MS = 60000;

class IndexRecorder {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._recordAndSchedule();
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  get isRunning() { return this._running; }

  _recordAndSchedule() {
    if (!this._running) return;
    const now = new Date();
    if (this._isInTradingWindow(now)) {
      this._record(now);
    }
    this._timer = setTimeout(() => this._recordAndSchedule(), RECORD_INTERVAL_MS);
  }

  _isInTradingWindow(date) {
    const day = date.getDay();
    if (day === 0 || day === 6) return false;
    const h = date.getHours();
    const m = date.getMinutes();
    const t = h * 60 + m;
    return (t >= 9 * 60 + 25 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60 + 5);
  }

  _record(now) {
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    https.get(INDEX_URL, { headers: { 'Referer': 'https://finance.sina.com.cn' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const prices = this._parseSinaIndices(body);
          if (prices.sh === null && prices.sz === null && prices.bj === null) return;
          const point = { time: timeStr, sh: prices.sh, sz: prices.sz, bj: prices.bj };
          this._appendToFile(dateStr, point);
        } catch (e) { /* silent */ }
      });
    }).on('error', () => { /* silent */ });
  }

  _parseSinaIndices(raw) {
    const result = { sh: null, sz: null, bj: null };
    const lines = raw.split('\n');
    for (const line of lines) {
      const m = line.match(/"([^"]*)"/);
      if (!m) continue;
      const values = m[1].split(',');
      const price = parseFloat(values[1]);
      if (isNaN(price)) continue;
      if (line.indexOf('sh000001') >= 0) result.sh = price;
      else if (line.indexOf('sz399001') >= 0) result.sz = price;
      else if (line.indexOf('bj899050') >= 0) result.bj = price;
    }
    return result;
  }

  _appendToFile(dateStr, point) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const filePath = path.join(DATA_DIR, 'index_history_' + dateStr + '.json');
      let data = [];
      if (fs.existsSync(filePath)) {
        try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { data = []; }
      }
      // Deduplicate by time
      for (const p of data) {
        if (p.time === point.time) return;
      }
      data.push(point);
      fs.writeFileSync(filePath, JSON.stringify(data));
    } catch (e) { /* silent */ }
  }

  cleanupOldFiles() {
    try {
      if (!fs.existsSync(DATA_DIR)) return;
      const today = new Date().toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const files = fs.readdirSync(DATA_DIR);
      for (const f of files) {
        const m = f.match(/^index_history_(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < cutoff && m[1] !== today) {
          try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (e) { /* silent */ }
        }
      }
    } catch (e) { /* silent */ }
  }
}

module.exports = { IndexRecorder };
