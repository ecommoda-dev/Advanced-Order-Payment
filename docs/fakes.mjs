// docs/fakes.mjs — شوبيفاي وD1 وهميين مشتركين بين worker-check.mjs و ui-check.mjs
// makeShopify: بيستبدل globalThis.fetch بشوبيفاي وهمية بتتصرّف زي الحقيقية (OAuth · GraphQL · REST capture).
// makeSqliteDB: D1 فوق SQLite حقيقي (node:sqlite — Node 22.5+) فاستعلامات السجل الحقيقية هي اللي بتتجرّب.
import { DatabaseSync } from 'node:sqlite';

function makeShopify(orders) {
  const calls = { captures: [], gql: [], oauth: 0 };
  const state = { failCapture: null, uncertainCapture: false, verifyFails: false, captureAppliesOnUncertain: false, byName404: false };
  const gid = (id) => `gid://shopify/Order/${id}`;
  const orderNode = (o) => ({
    id: gid(o.id), legacyResourceId: o.id, name: o.name, currencyCode: 'EGP',
    cancelledAt: o.cancelledAt || null, canMarkAsPaid: o.canMarkAsPaid !== false,
    displayFinancialStatus: o.financialStatus, displayFulfillmentStatus: 'UNFULFILLED',
    totalOutstandingSet: { shopMoney: { amount: o.outstanding, currencyCode: 'EGP' } },
    totalReceivedSet: { shopMoney: { amount: o.received || '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: o.total || o.outstanding } },
    subtotalPriceSet: { shopMoney: { amount: o.subtotal || o.outstanding } },
    shippingLine: { originalPriceSet: { shopMoney: { amount: o.shipping || '0.00' } } },
    courierMeta: o.courier ? { value: o.courier } : null,
    preRegMeta: o.preReg ? { value: 'Pre-Registered Payment' } : null,
    s1Meta: o.s1 ? { value: o.s1 } : null, s2Meta: o.s2 ? { value: o.s2 } : null,
    lineItems: { nodes: [{ sku: 'SKU-1', name: 'منتج', quantity: 1, currentQuantity: 1,
      originalUnitPriceSet: { shopMoney: { amount: o.outstanding } }, discountedTotalSet: { shopMoney: { amount: o.outstanding } } }] },
  });
  const gqlOk = (data) => new Response(JSON.stringify({ data, extensions: { cost: { requestedQueryCost: 20, actualQueryCost: 12, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 980, restoreRate: 50 } } } }), { status: 200 });

  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.endsWith('/admin/oauth/access_token')) { calls.oauth++; return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }); }
    if (url.includes('/transactions.json')) {
      const id = url.match(/orders\/(\d+)\/transactions/)[1];
      const body = JSON.parse(init.body);
      calls.captures.push({ id, ...body.transaction });
      if (state.uncertainCapture) { if (state.captureAppliesOnUncertain) orders[id].outstanding = '0.00', orders[id].financialStatus = 'PAID'; throw new Error('socket hang up'); }
      if (state.failCapture) return new Response(JSON.stringify({ errors: state.failCapture }), { status: 422 });
      orders[id].outstanding = '0.00'; orders[id].financialStatus = 'PAID';
      return new Response(JSON.stringify({ transaction: { id: 9001 + calls.captures.length } }), { status: 201 });
    }
    if (url.endsWith('/graphql.json')) {
      const { query, variables } = JSON.parse(init.body);
      calls.gql.push(query.match(/query (\w+)|\{ (\w+)/)?.[0] || 'gql');
      if (/currentAppInstallation/.test(query)) return gqlOk({ currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'write_orders' }] } });
      if (/getOrderByNumber/.test(query)) {
        if (state.byName404) return gqlOk({ orders: { nodes: [] } });
        const want = variables.query.replace('name:', '');
        const hits = Object.values(orders).filter(o => o.name === want || o.name.startsWith(want));   // يرجّع قريب كمان (زي بحث شوبيفاي)
        return gqlOk({ orders: { nodes: hits.map(o => ({ id: gid(o.id), name: o.name })) } });
      }
      if (/paymentVerify/.test(query)) {
        if (state.verifyFails) return new Response('boom', { status: 500 });
        const o = orders[variables.id.split('/').pop()];
        return gqlOk({ order: o ? { displayFinancialStatus: o.financialStatus, totalOutstandingSet: { shopMoney: { amount: o.outstanding } } } : null });
      }
      if (/getOrderForPayment/.test(query)) {
        const o = orders[variables.id.split('/').pop()];
        return gqlOk({ order: o ? orderNode(o) : null });
      }
    }
    throw new Error('fake shopify: unexpected ' + url);
  };
  return { calls, state };
}

const baseOrder = (over = {}) => ({ id: '6959895839042', name: '#55001', s1: 'Confirmed', s2: null, outstanding: '1425.00', financialStatus: 'PENDING', courier: null, ...over });

export { makeShopify, baseOrder };

export function makeSqliteDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, tool TEXT NOT NULL, type TEXT NOT NULL, employee TEXT, order_id TEXT, order_name TEXT, sku TEXT, product_title TEXT, delta INTEGER, value_before INTEGER, value_after INTEGER, notes TEXT, extra TEXT);
CREATE TABLE employees (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, pin TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT, last_login TEXT);
CREATE TABLE log_value_alerts (source_tool TEXT, tool TEXT, type TEXT, first_seen TEXT, last_seen TEXT, hits INTEGER, worker_version TEXT, sample_order_name TEXT, sample_employee TEXT, sample_notes TEXT, status TEXT DEFAULT 'open', PRIMARY KEY (source_tool, tool, type));`);
  db.prepare("INSERT INTO employees (username, display_name, pin, is_active) VALUES (?,?,?,1)").run('Test_User', 'Test User', '1234');
  db.prepare("INSERT INTO employees (username, display_name, pin, is_active) VALUES (?,?,?,1)").run('Sara_Ali', 'Sara Ali', '5678');
  const wrap = {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      const mk = (b) => ({
        async first() { return st.get(...b) ?? null; },
        async all() { return { results: st.all(...b) }; },
        async run() { st.run(...b); return {}; },
      });
      return { bind: (...b) => mk(b), ...mk([]) };
    },
  };
  return wrap;
}
