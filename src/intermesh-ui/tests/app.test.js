// Dependency-free UI wiring tests. Run from the repository root with jsc -m.
import { TransferRequests, describeIntent, userScope } from '../src/js/transfer-requests.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
function equal(a, b) { assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const commit = () => reply(200, { ledgerTransferResponseDTO: { status: 'COMMITTED', transaction_id: 'TX-synthetic' } });
function admission(id, state, code) {
    return reply(code ? 409 : 200, { status: code ? 'REJECTED' : 'RECOVERED', transfer_request_id: id,
        admission_status: code ? 'REJECTED' : 'ADMITTED', rejection_code: code || null,
        transaction_id: code ? null : 'TX-synthetic', transaction_state: code ? null : state,
        new_transaction_created: false, duplicate_pending_approved: false, matching_pending_count: 1 });
}
class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.value = ''; this.textContent = ''; this.innerHTML = ''; this.children = [];
        this.disabled = false; this.hidden = false; this.listeners = {};
        this.classes = new Set();
        this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value ?? ''); this._html = ''; this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = String(value); this._text = ''; this.children = []; }
    replaceChildren(...children) { this._text = ''; this._html = ''; this.children = [...children]; }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    fire(type) { if (!this.disabled || type === 'submit') return this.listeners[type]?.({ target: this, preventDefault() {} }); }
}
function boot(shared = null) {
    const env = shared || { storage: new Map(), calls: [], uuidCount: 0, confirmations: [], confirm: false,
        respond: async () => commit(), claims: { iss: 'https://keycloak.example.invalid/realms/intermesh-bank',
            sub: 'synthetic-a', preferred_username: 'synthetic-owner' } };
    env.readCalls ??= [];
    env.refreshCalls ??= [];
    env.loginCalls ??= 0;
    const intervals = new Map();
    const visibilityListeners = new Set();
    let intervalID = 0;
    const html = readFile('src/intermesh-ui/src/index.html');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
    for (const selector of ['.user-name', '.user-role', '.avatar']) elements.set(selector, new Element());
    const document = {
        getElementById(id) { assert(elements.has(id), 'Missing HTML element ' + id); return elements.get(id); },
        querySelector: selector => elements.get(selector), createElement: tag => new Element(tag),
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
        visibilityState: 'visible',
        addEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.delete(listener); }
    };
    const window = { location: { origin: 'https://bank-network1.example.invalid', reload() {} },
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++env.uuidCount).padStart(12, '0')}` },
        sessionStorage: { getItem: key => env.storage.get(key) ?? null, setItem: (key, value) => env.storage.set(key, value) },
        confirm: text => { env.confirmations.push(text); return env.confirm; } };
    class Keycloak {
        constructor() { this.authenticated = true; this.tokenParsed = env.claims; this.token = 'synthetic-test-token'; env.keycloak = this; }
        async init(options) { equal(options.pkceMethod, 'S256'); return true; }
        async updateToken(minValidity) {
            env.refreshCalls.push(minValidity);
            return env.refresh ? env.refresh(this) : false;
        }
        login() { env.loginCalls++; return Promise.resolve(); }
        clearToken() {
            this.token = undefined; this.tokenParsed = undefined; this.authenticated = false;
            this.onAuthLogout?.();
            this.login(); // The bundled adapter does this for login-required initialization.
        }
        logout() { this.authenticated = false; this.onAuthLogout?.(); return Promise.resolve(); }
    }
    const fetch = async (url, options = {}) => {
        if (!url.includes('/transfers') && !url.includes('/transfer-requests/')) {
            env.readCalls.push({ url, ...options });
            return env.respondAccount ? env.respondAccount(url, options) : reply(404, {});
        }
        const call = { url, ...options }; env.calls.push(call); return env.respond(call);
    };
    const source = '"use strict";\n' + readFile('src/intermesh-ui/src/js/app.js').replace(/^import .*;$/gm, '');
    const run = new Function('Keycloak', 'TransferRequests', 'describeIntent', 'userScope', 'window', 'document',
        'fetch', 'console', 'alert', 'setInterval', 'clearInterval', 'setTimeout', source);
    run(Keycloak, TransferRequests, describeIntent, userScope, window, document, fetch,
        { log() {}, error() {} }, message => { throw new Error(message); },
        callback => { intervals.set(++intervalID, callback); return intervalID; },
        id => intervals.delete(id), () => {});
    return { env, elements, get: id => elements.get(id), window, html, intervals, visibilityListeners,
        tick() { for (const callback of [...intervals.values()]) callback(); },
        visibility(state) {
            document.visibilityState = state;
            for (const listener of [...visibilityListeners]) listener();
        } };
}
function fill(ui, amount = '12.30', target = 'ACC-B') {
    ui.get('sourceAccount').value = 'ACC-A';
    ui.get('targetAccount').value = target;
    ui.get('transferAmount').value = amount;
}

test('the module boots once, binds every control and never submits automatically', async () => {
    const ui = boot(); await settle();
    equal([...ui.html.matchAll(/<script[^>]*src="js\/app.js"/g)].length, 1);
    assert(!ui.get('btnTransfer').disabled);
    assert(ui.get('checkTransfer').disabled);
    equal(ui.env.calls.length, 0);
});

test('double submit uses one UUID, locks immutable inputs and sends exact numeric decimal text', async () => {
    const ui = boot(); await settle();
    let finish;
    ui.env.respond = () => new Promise(resolve => { finish = resolve; });
    fill(ui, '9999999999999.99');
    ui.get('transferForm').fire('submit');
    ui.get('transferForm').fire('submit');
    await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1);
    assert(ui.get('btnTransfer').disabled && ui.get('sourceAccount').readOnly);
    assert(ui.env.calls[0].body.includes('"amount":9999999999999.99}'));
    finish(commit()); await settle();
    assert(ui.get('transferStatus').textContent.includes('APPROVED'));
    assert(ui.get('replayTransfer').disabled);
});

test('duplicate confirmation shows exact details and a cancelled dialog creates no request', async () => {
    const ui = boot(); await settle(); fill(ui);
    ui.env.respond = async call => {
        const body = JSON.parse(call.body);
        return admission(body.transfer_request_id, null,
            body.allowDuplicatePendingTransfer ? 'DUPLICATE_EXCEPTION_USED' : 'DUPLICATE_APPROVAL_REQUIRED');
    };
    ui.get('transferForm').fire('submit'); await settle();
    assert(!ui.get('confirmDuplicate').hidden);
    ui.get('confirmDuplicate').fire('click'); await settle();
    equal(ui.env.uuidCount, 1); equal(ui.env.calls.length, 1);
    assert(ui.env.confirmations[0].includes('Source: ACC-A'));
    assert(ui.env.confirmations[0].includes('Destination: ACC-B'));
    assert(ui.env.confirmations[0].includes('€12.30'));
    ui.env.confirm = true;
    ui.get('confirmDuplicate').fire('click'); await settle();
    equal(ui.env.uuidCount, 2); equal(ui.env.calls.length, 2);
    const ordinary = JSON.parse(ui.env.calls[0].body), approved = JSON.parse(ui.env.calls[1].body);
    assert(ordinary.transfer_request_id !== approved.transfer_request_id);
    assert(!ordinary.allowDuplicatePendingTransfer && approved.allowDuplicatePendingTransfer);
    assert(ui.get('transferStatus').textContent.includes('already been used'));
    assert(ui.get('confirmDuplicate').hidden);
});

test('refresh keeps uncertainty and Check Status performs only GET with snapshot-safe messaging', async () => {
    let ui = boot(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Synthetic network loss'); };
    ui.get('transferForm').fire('submit'); await settle();
    const original = ui.env.calls[0].body;
    ui = boot(ui.env); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1);
    assert(ui.get('transferStatus').textContent.includes('not confirmed'));
    assert(ui.get('sourceAccount').readOnly);
    ui.env.respond = async () => reply(404, { code: 'TRANSFER_REQUEST_NOT_FOUND' });
    ui.get('checkTransfer').fire('click'); await settle();
    equal(ui.env.calls[1].method, 'GET');
    assert(ui.get('transferStatus').textContent.includes('may still complete'));
    ui.env.confirm = true;
    ui.env.respond = async () => {
        const body = await admission(JSON.parse(original).transfer_request_id, 'PENDING').json();
        return reply(200, { ...body, status: 'REPLAYED' });
    };
    ui.get('replayTransfer').fire('click'); await settle();
    equal(ui.env.calls[2].body, original);
    assert(ui.get('transferStatus').textContent.includes('not completed'));
    equal(ui.env.uuidCount, 1);
});

test('logout and a late response cannot expose the previous user details to another identity', async () => {
    const ui = boot(); await settle(); fill(ui);
    let finish;
    ui.env.respond = () => new Promise(resolve => { finish = resolve; });
    ui.get('transferForm').fire('submit'); await settle();
    ui.get('logoutBtn').fire('click'); await settle();
    equal(ui.get('transferDetails').textContent, '');
    assert(ui.get('btnTransfer').disabled);
    ui.env.keycloak.authenticated = true;
    ui.env.keycloak.tokenParsed = { ...ui.env.claims, sub: 'synthetic-b' };
    ui.env.keycloak.onAuthRefreshSuccess(); await settle();
    finish(commit()); await settle();
    equal(ui.get('transferDetails').textContent, '');
    equal(ui.get('savedTransfer').children.length, 1);
    const originalSaved = [...ui.env.storage.values()].map(JSON.parse).find(data => data.intents.length);
    equal(originalSaved.intents[0].outcome, 'UNRESOLVED');
});

test('new transfer details use textContent for untrusted destination strings', async () => {
    const ui = boot(); await settle();
    fill(ui, '12.30', '<svg/onload=alert(1)>');
    ui.env.respond = async () => reply(503, { code: 'COMMIT_OUTCOME_UNKNOWN' });
    ui.get('transferForm').fire('submit'); await settle();
    assert(ui.get('transferDetails').textContent.includes('<svg/onload=alert(1)>'));
    equal(ui.get('transferDetails').innerHTML, '');
    assert(ui.get('transferStatus').textContent.includes('outcome is unknown'));
});

function accountFixture() {
    return { account_id: 'ACC-A', holder_name: 'Synthetic Owner', iban: 'SYNTHETIC-IBAN', balance: 123.45 };
}
function assertNoHTMLParsing(element) {
    if (element.nodeType === 3) return;
    equal(element.innerHTML, '');
    element.children.forEach(assertNoHTMLParsing);
}

test('history renders hostile financial fields as text and preserves table structure and status styling', async () => {
    const ui = boot();
    const hostile = { transaction_id: '<img src=x onerror=alert(1)>', target_iban: '<svg/onload=alert(1)>',
        amount: 12.30, status: 'PENDING\"><img src=x>', timestamp: '<script>alert(1)</script>' };
    ui.env.respondAccount = async url => url.includes('/transactions')
        ? reply(200, [hostile, ...['PENDING', 'APPROVED', 'FAILED'].map(status => ({ ...hostile, status }))])
        : reply(200, accountFixture());
    await settle();
    const table = ui.get('historyTableBody');
    equal(table.children.length, 4);
    const row = table.children[0];
    equal(row.tagName, 'TR');
    equal(row.children.map(cell => cell.tagName), ['TD', 'TD', 'TD', 'TD', 'TD']);
    equal(row.children.map(cell => cell.children[0].tagName), ['STRONG', 'CODE', 'STRONG', 'SPAN', 'SMALL']);
    equal(row.children.map(cell => cell.textContent), [hostile.transaction_id, hostile.target_iban,
        '€12.30', hostile.status, hostile.timestamp]);
    equal(row.children[3].children[0].className, 'status-pill');
    equal(table.children.slice(1).map(item => item.children[3].children[0].className),
        ['status-pill pending', 'status-pill approved', 'status-pill failed']);
    assertNoHTMLParsing(table);
    ui.get('logoutBtn').fire('click'); await settle();
    equal(table.children.length, 1);
    equal(table.children[0].children[0].colSpan, 5);
    equal(table.children[0].children[0].className, 'empty-state');
    assert(table.textContent.includes('No transactions recorded'));
});

test('account summary uses text and labels the balance as a snapshot through transfer and recovery', async () => {
    const ui = boot();
    const account = { ...accountFixture(), holder_name: '<svg/onload=alert(1)>', iban: '<img src=x onerror=alert(1)>' };
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, []) : reply(200, account);
    await settle();
    const summary = ui.get('onboardingTarget');
    assert(summary.textContent.includes(account.holder_name));
    assert(summary.textContent.includes(account.iban));
    assert(summary.textContent.includes('Balance snapshot (reload to update): €123.45'));
    assert(!summary.textContent.includes('Live Balance'));
    assertNoHTMLParsing(summary);
    const snapshot = summary.textContent;
    fill(ui); ui.get('transferForm').fire('submit'); await settle();
    assert(ui.get('transferStatus').textContent.includes('APPROVED'));
    ui.env.respond = async call => admission(call.url.split('/').pop(), 'APPROVED');
    ui.get('checkTransfer').fire('click'); await settle();
    equal(ui.env.calls.map(call => call.method), ['POST', 'GET']);
    equal(summary.textContent, snapshot);
    equal(ui.env.readCalls.filter(call => call.url.includes('/accounts/')).length, 1);
});

test('newly provisioned account identifiers are rendered as text', async () => {
    const ui = boot(); await settle();
    const account = { ...accountFixture(), account_id: '<b>synthetic-account</b>', iban: '<svg/onload=alert(1)>' };
    ui.env.respondAccount = async (url, options) => options.method === 'POST'
        ? reply(201, { account_details: account }) : reply(200, []);
    ui.get('holderName').value = 'Synthetic Owner';
    ui.get('initialDeposit').value = '10.00';
    ui.get('onboardingForm').fire('submit'); await settle();
    const summary = ui.get('onboardingTarget');
    assert(summary.textContent.includes(account.account_id));
    assert(summary.textContent.includes(account.iban));
    assertNoHTMLParsing(summary);
    equal(ui.get('sourceAccount').value, account.account_id);
});

test('a late history response after logout cannot repopulate the cleared view', async () => {
    const ui = boot();
    let finish;
    ui.env.respondAccount = async url => url.includes('/transactions')
        ? new Promise(resolve => { finish = resolve; }) : reply(200, accountFixture());
    await settle();
    assert(typeof finish === 'function');
    ui.get('logoutBtn').fire('click'); await settle();
    const table = ui.get('historyTableBody');
    const cleared = table.textContent;
    finish(reply(200, [{ transaction_id: 'TX-SYNTHETIC', target_iban: '<svg/onload=alert(1)>',
        amount: 12.30, status: 'PENDING', timestamp: 'synthetic' }]));
    await settle();
    equal(table.textContent, cleared);
    equal(ui.get('onboardingTarget').textContent, '');
    assertNoHTMLParsing(table);
});

test('corrupted saved state blocks transfer submission without destroying recovery data', async () => {
    const first = boot(); await settle(); fill(first);
    first.env.respond = async () => { throw new Error('Lost response'); };
    first.get('transferForm').fire('submit'); await settle();
    const key = [...first.env.storage.keys()][0];
    first.env.storage.set(key, '{broken');
    const ui = boot(first.env); await settle();
    assert(ui.get('btnTransfer').disabled);
    assert(ui.get('transferStatus').textContent.includes('Nothing will be sent'));
    equal(ui.env.storage.get(key), '{broken');
    equal(ui.env.calls.length, 1);
});

test('starting another transfer is explicit and retains previous unresolved records', async () => {
    const ui = boot(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Lost response'); };
    ui.get('transferForm').fire('submit'); await settle();
    ui.get('newTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 1);
    assert(!ui.get('sourceAccount').readOnly);
    equal(ui.get('transferAmount').value, '');
    fill(ui, '1.00');
    ui.get('transferForm').fire('submit'); await settle();
    equal(ui.env.uuidCount, 2); equal(ui.env.calls.length, 2);
    const saved = JSON.parse([...ui.env.storage.values()][0]);
    equal(saved.intents.length, 2);
    equal(saved.intents[0].outcome, 'UNRESOLVED');
});

function bootWithAccount() {
    const ui = boot();
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, []) : reply(200, accountFixture());
    return ui;
}

test('account discovery waits for refresh and uses the current token, not the login token', async () => {
    const ui = bootWithAccount(), refresh = deferred();
    ui.env.refresh = () => refresh.promise;
    await settle();
    equal(ui.env.readCalls.length, 0);
    ui.env.keycloak.token = 'synthetic-refreshed-token';
    ui.env.refresh = async () => false;
    refresh.resolve(true); await settle();
    equal(ui.env.readCalls.length, 2);
    assert(ui.env.readCalls.every(call => call.headers.Authorization === 'Bearer synthetic-refreshed-token'));
    assert(ui.env.refreshCalls.every(value => value === 30));
    equal(ui.intervals.size, 1);
});

test('successive polling cycles refresh expiring tokens before sending history requests', async () => {
    const ui = bootWithAccount(); await settle();
    let refreshCount = 0;
    ui.env.refresh = async keycloak => {
        keycloak.token = `synthetic-poll-token-${++refreshCount}`;
        keycloak.onAuthRefreshSuccess();
        return true;
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
        ui.tick(); await settle();
        equal(ui.env.readCalls[ui.env.readCalls.length - 1].headers.Authorization, `Bearer synthetic-poll-token-${cycle}`);
    }
    equal(ui.env.readCalls.filter(call => call.url.includes('/transactions')).length, 4);
    equal(ui.env.refreshCalls.slice(-3), [30, 30, 30]);
    equal(ui.intervals.size, 1);
    equal(ui.env.loginCalls, 0);
});

test('overlapping polling and onboarding share one refresh and never use the earlier token', async () => {
    const ui = bootWithAccount(); await settle();
    const refresh = deferred(), before = ui.env.refreshCalls.length;
    ui.env.refresh = () => refresh.promise;
    ui.tick(); ui.tick();
    ui.get('holderName').value = 'Synthetic Owner';
    ui.get('initialDeposit').value = '10.00';
    ui.env.respondAccount = async (url, options) => options.method === 'POST'
        ? reply(201, { account_details: accountFixture() }) : reply(200, []);
    ui.get('onboardingForm').fire('submit'); await settle();
    equal(ui.env.refreshCalls.length, before + 1);
    equal(ui.env.readCalls.length, 2);
    ui.env.keycloak.token = 'synthetic-shared-refresh';
    ui.env.refresh = async () => false;
    refresh.resolve(true); await settle();
    const calls = ui.env.readCalls.slice(2);
    assert(calls.length >= 2);
    assert(calls.every(call => call.headers.Authorization === 'Bearer synthetic-shared-refresh'));
    equal(calls.filter(call => call.method === 'POST').length, 1);
    equal(ui.visibilityListeners.size, 1);
    equal(ui.intervals.size, 1);
});

test('polling and double transfer submit share a refresh and send exactly one financial POST', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    const refresh = deferred(), before = ui.env.refreshCalls.length;
    ui.env.refresh = () => refresh.promise;
    ui.tick();
    ui.get('transferForm').fire('submit'); ui.get('transferForm').fire('submit');
    await settle();
    equal(ui.env.refreshCalls.length, before + 1);
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 1);
    ui.env.keycloak.token = 'synthetic-shared-transfer-token';
    ui.env.refresh = async () => false;
    refresh.resolve(true); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.calls[0].method, 'POST');
    equal(ui.env.calls[0].headers.Authorization, 'Bearer synthetic-shared-transfer-token');
    equal(ui.env.uuidCount, 1);
    assert(ui.get('transferStatus').textContent.includes('APPROVED'));
});

test('transfer POST and read-only recovery also use the shared refresh path without retries', async () => {
    const ui = boot(); await settle(); fill(ui, '9999999999999.99');
    ui.env.refresh = async keycloak => { keycloak.token = 'synthetic-transfer-token'; return true; };
    ui.env.respond = async () => { throw new Error('Synthetic lost response'); };
    ui.get('transferForm').fire('submit'); await settle();
    equal(ui.env.calls.length, 1);
    equal(ui.env.calls[0].headers.Authorization, 'Bearer synthetic-transfer-token');
    assert(ui.env.calls[0].body.includes('"amount":9999999999999.99}'));
    ui.env.refresh = async keycloak => { keycloak.token = 'synthetic-recovery-token'; return true; };
    ui.env.respond = async call => admission(call.url.split('/').pop(), 'PENDING');
    ui.get('checkTransfer').fire('click'); await settle();
    equal(ui.env.calls.map(call => call.method), ['POST', 'GET']);
    equal(ui.env.calls[1].headers.Authorization, 'Bearer synthetic-recovery-token');
    equal(ui.env.uuidCount, 1);
    assert(ui.env.refreshCalls.every(value => value === 30));
});

test('transient refresh failure stops polling and blocks APIs while retaining view and pending recovery data', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Synthetic lost response'); };
    ui.get('transferForm').fire('submit'); await settle();
    const saved = [...ui.env.storage.entries()];
    const details = ui.get('transferDetails').textContent, summary = ui.get('onboardingTarget').textContent;
    const calls = ui.env.readCalls.length, refreshCalls = ui.env.refreshCalls.length;
    ui.env.refresh = async keycloak => {
        keycloak.onAuthRefreshError();
        throw new Error('Synthetic transient network error');
    };
    ui.tick(); await settle();
    equal(ui.intervals.size, 0); equal(ui.visibilityListeners.size, 0);
    equal(ui.env.readCalls.length, calls);
    equal(ui.get('transferDetails').textContent, details);
    equal(ui.get('onboardingTarget').textContent, summary);
    equal([...ui.env.storage.entries()], saved);
    assert(ui.get('transferStatus').textContent.includes('reload to sign in again'));
    assert(ui.get('transferStatus').textContent.includes('not confirmed'));
    assert(ui.env.keycloak.authenticated);
    equal(ui.env.loginCalls, 0);
    assert(ui.get('btnTransfer').disabled && ui.get('checkTransfer').disabled && ui.get('replayTransfer').disabled);
    ui.visibility('hidden'); ui.visibility('visible'); ui.tick();
    ui.get('onboardingForm').fire('submit');
    ui.get('transferForm').fire('submit');
    ui.get('checkTransfer').fire('click');
    await settle();
    equal(ui.env.readCalls.length, calls); equal(ui.env.calls.length, 1);
    equal(ui.env.refreshCalls.length, refreshCalls + 1);
    equal([...ui.env.storage.entries()], saved);

    // Reloading may restore authentication, but must never replay a financial POST.
    ui.env.refresh = async () => false;
    const reloaded = boot(ui.env); await settle();
    assert(!reloaded.get('checkTransfer').disabled);
    equal(reloaded.env.calls.length, 1);
    equal([...reloaded.env.storage.entries()], saved);
});

test('explicit session termination uses the adapter login once and preserves saved requests', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Synthetic lost response'); };
    ui.get('transferForm').fire('submit'); await settle();
    const saved = [...ui.env.storage.entries()], calls = ui.env.readCalls.length;
    ui.env.refresh = async keycloak => {
        keycloak.clearToken();
        keycloak.onAuthRefreshError();
        throw new Error('Synthetic invalid_grant');
    };
    ui.tick(); await settle();
    equal(ui.env.loginCalls, 1);
    equal(ui.intervals.size, 0); equal(ui.visibilityListeners.size, 0);
    equal(ui.env.readCalls.length, calls);
    equal(ui.get('transferDetails').textContent, '');
    equal([...ui.env.storage.entries()], saved);
    ui.visibility('visible'); ui.tick();
    ui.get('transferForm').fire('submit'); await settle();
    equal(ui.env.loginCalls, 1); equal(ui.env.calls.length, 1);
});

for (const operation of ['history', 'onboarding', 'transfer']) {
    test(`logout during awaited ${operation} refresh prevents the request even if a late token has the same subject`, async () => {
        const ui = bootWithAccount(); await settle();
        const refresh = deferred();
        ui.env.refresh = () => refresh.promise;
        if (operation === 'history') ui.tick();
        if (operation === 'onboarding') ui.get('onboardingForm').fire('submit');
        if (operation === 'transfer') {
            fill(ui); ui.get('transferForm').fire('submit');
        }
        await settle();
        const reads = ui.env.readCalls.length;
        ui.get('logoutBtn').fire('click');
        ui.env.keycloak.authenticated = true;
        ui.env.keycloak.tokenParsed = { ...ui.env.claims };
        ui.env.keycloak.token = 'synthetic-late-token';
        ui.env.keycloak.onAuthRefreshSuccess();
        refresh.resolve(true); await settle();
        equal(ui.env.readCalls.length, reads); equal(ui.env.calls.length, 0);
        equal(ui.intervals.size, 0);
        equal(ui.get('onboardingTarget').textContent, '');
        equal(ui.get('transferDetails').textContent, '');
        assert(ui.get('btnTransfer').disabled);
    });
}

for (const operation of ['lookup', 'history', 'onboarding', 'transfer']) {
    test(`identity change during ${operation} refresh cannot send the previous identity's request`, async () => {
        const ui = ['lookup', 'history'].includes(operation) ? bootWithAccount() : boot();
        if (operation !== 'lookup') await settle();
        const refresh = deferred();
        ui.env.refresh = () => refresh.promise;
        if (operation === 'history') ui.tick();
        if (operation === 'onboarding') ui.get('onboardingForm').fire('submit');
        if (operation === 'transfer') { fill(ui); ui.get('transferForm').fire('submit'); }
        await settle();
        const reads = ui.env.readCalls.length;
        ui.env.keycloak.tokenParsed = { ...ui.env.claims, sub: 'synthetic-b', preferred_username: 'synthetic-other' };
        ui.env.keycloak.token = 'synthetic-other-token';
        ui.env.keycloak.onAuthRefreshSuccess();
        ui.env.refresh = async () => false;
        refresh.resolve(true); await settle();
        equal(ui.env.calls.length, 0);
        assert(ui.env.readCalls.slice(reads).every(call => call.url.endsWith('/accounts/synthetic-other')
            || call.url.includes('/transactions')));
        assert(ui.env.readCalls.slice(reads).every(call => call.headers.Authorization === 'Bearer synthetic-other-token'));
        equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 0);
        equal(ui.get('transferDetails').textContent, '');
    });
}

test('a final API 401 pauses polling without retries or erasing unresolved financial state', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    ui.env.respond = async () => reply(401, {});
    ui.get('transferForm').fire('submit'); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1);
    equal(ui.intervals.size, 0); equal(ui.visibilityListeners.size, 0);
    const saved = JSON.parse([...ui.env.storage.values()][0]);
    equal(saved.intents[0].outcome, 'UNRESOLVED');
    equal(saved.intents[0].transfer_request_id, JSON.parse(ui.env.calls[0].body).transfer_request_id);
    assert(ui.get('transferStatus').textContent.includes('Requests are paused'));
    ui.tick(); ui.visibility('visible'); ui.get('replayTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 1);
    equal(ui.env.loginCalls, 0);
});

test('a history 401 cannot restart a repeated unauthorized polling loop', async () => {
    const ui = bootWithAccount(); await settle();
    ui.env.respondAccount = async () => reply(401, {});
    ui.tick(); await settle();
    const calls = ui.env.readCalls.length, refreshes = ui.env.refreshCalls.length;
    equal(ui.intervals.size, 0); equal(ui.visibilityListeners.size, 0);
    ui.tick(); ui.visibility('hidden'); ui.visibility('visible'); await settle();
    equal(ui.env.readCalls.length, calls); equal(ui.env.refreshCalls.length, refreshes);
});

test('a concurrent refresh failure does not discard the result of an already sent financial POST', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    const response = deferred();
    ui.env.respond = () => response.promise;
    ui.get('transferForm').fire('submit'); await settle();
    equal(ui.env.calls.length, 1);
    ui.env.refresh = async () => { throw new Error('Synthetic transient error'); };
    ui.tick(); await settle();
    assert(ui.get('transferStatus').textContent.includes('Requests are paused'));
    response.resolve(commit()); await settle();
    const saved = JSON.parse([...ui.env.storage.values()][0]);
    equal(saved.intents[0].outcome, 'APPROVED');
    assert(ui.get('transferStatus').textContent.includes('APPROVED'));
    assert(ui.get('transferStatus').textContent.includes('Requests are paused'));
    equal(ui.env.calls.length, 1);
    equal(ui.intervals.size, 0);
});

test('a late 401 from the previous identity cannot pause the new identity polling', async () => {
    const ui = bootWithAccount(); await settle();
    const response = deferred();
    ui.env.respondAccount = () => response.promise;
    ui.tick(); await settle();
    ui.env.keycloak.tokenParsed = { ...ui.env.claims, sub: 'synthetic-b', preferred_username: 'synthetic-other' };
    ui.env.keycloak.token = 'synthetic-other-token';
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, []) : reply(200, accountFixture());
    ui.env.keycloak.onAuthRefreshSuccess(); await settle();
    equal(ui.intervals.size, 1);
    response.resolve(reply(401, {})); await settle();
    assert(!ui.get('btnTransfer').disabled);
    equal(ui.intervals.size, 1);
    assert(!ui.get('transferStatus').textContent.includes('Requests are paused'));
    const before = ui.env.readCalls.length;
    ui.tick(); await settle();
    equal(ui.env.readCalls.length, before + 1);
    equal(ui.env.readCalls[before].headers.Authorization, 'Bearer synthetic-other-token');
});

test('a refresh that leaves no access token fails closed before any API request', async () => {
    const ui = boot();
    ui.env.refresh = async keycloak => { keycloak.token = undefined; return true; };
    await settle();
    equal(ui.env.readCalls.length, 0); equal(ui.env.calls.length, 0);
    equal(ui.env.loginCalls, 0);
    assert(ui.get('btnTransfer').disabled);
    assert(ui.get('transferStatus').textContent.includes('Requests are paused'));
});

test('refresh failure before a financial POST retains its UUID and never sends or retries it', async () => {
    const ui = boot(); await settle(); fill(ui);
    ui.env.refresh = async () => { throw new Error('Synthetic transient error'); };
    ui.get('transferForm').fire('submit'); await settle();
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 1);
    const saved = JSON.parse([...ui.env.storage.values()][0]);
    equal(saved.intents[0].outcome, 'UNRESOLVED');
    equal(saved.intents[0].amount, '12.30');
    assert(ui.get('transferDetails').textContent.includes(saved.intents[0].transfer_request_id));
    ui.get('transferForm').fire('submit'); ui.get('checkTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 1);
});

let failed = 0;
for (const { name, run } of tests) {
    try { await run(); print('PASS ' + name); }
    catch (error) { failed++; print('FAIL ' + name + ': ' + error.message); }
}
print(`${tests.length - failed}/${tests.length} UI wiring tests passed`);
if (failed) throw new Error(`${failed} UI wiring tests failed`);
