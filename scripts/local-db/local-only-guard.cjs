// Loaded with `node --require` in front of scripts/migrate.mjs by setup.sh.
// Second safety net next to the address check in setup.sh: every pg connection
// in this process is refused unless it goes to localhost/127.0.0.1. So even if
// migrate.mjs ever started letting .env win over SUPABASE_DB_URL, it could not
// reach the production database from here.
const pg = require('pg');

const LOCAL = new Set(['localhost', '127.0.0.1']);
const connect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function guardedConnect(...args) {
  if (!LOCAL.has(this.host)) {
    const err = new Error(`local-db guard: verbinding met "${this.host}" geweigerd (alleen localhost/127.0.0.1)`);
    const cb = args.find((a) => typeof a === 'function');
    if (cb) return void process.nextTick(cb, err);
    return Promise.reject(err);
  }
  return connect.apply(this, args);
};
