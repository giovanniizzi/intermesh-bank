// Dependency-free UI wiring tests. Run from the repository root with jsc -m.
import { TransferRequests, describeIntent, userScope, exactAmount } from '../src/js/transfer-requests.js';
import { validateIban, formatIban, italianIbanParts } from '../src/js/iban.js';

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
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value ?? ''); this._html = ''; this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = String(value); this._text = ''; this.children = []; }
    replaceChildren(...children) { this._text = ''; this._html = ''; this.children = [...children]; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = value;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() { this.onFocus?.(); }
    showModal() { this.open = true; this.onShowModal?.(); }
    close() { if (this.open) { this.open = false; this.fire('close'); } }
    cancel() { if (this.open) { this.fire('cancel'); this.close(); } }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    fire(type, details = {}) { if (!this.disabled || type === 'submit') return this.listeners[type]?.({ target: this, preventDefault() {}, ...details }); }
}
function boot(shared = null, initialHash = '') {
    const env = shared || { storage: new Map(), calls: [], uuidCount: 0, confirmations: [], confirm: false,
        respond: async () => commit(), claims: { iss: 'https://keycloak.example.invalid/realms/intermesh-bank',
            sub: 'synthetic-a', preferred_username: 'synthetic-owner' } };
    env.readCalls ??= [];
    env.refreshCalls ??= [];
    env.loginCalls ??= 0;
    env.initCalls ??= 0;
    env.clipboardWrites ??= [];
    const intervals = new Map();
    const visibilityListeners = new Set();
    let intervalID = 0;
    const html = readFile('src/intermesh-ui/src/index.html');
    const elements = new Map();
    for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const element = new Element(match[1]);
        for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
        element.hidden = /\bhidden(?:\s|$)/.test(match[2]);
        element.disabled = /\bdisabled(?:\s|$)/.test(match[2]);
        elements.set(match[3], element);
    }
    for (const selector of ['.user-name', '.user-role', '.avatar']) elements.set(selector, new Element());
    const document = {
        activeElement: null,
        getElementById(id) { assert(elements.has(id), 'Missing HTML element ' + id); return elements.get(id); },
        querySelector: selector => elements.get(selector), createElement: tag => new Element(tag),
        querySelectorAll: selector => [...elements.values()].filter(element => selector === '.nav-item' && element.classes.has('nav-item')),
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
        visibilityState: 'visible',
        addEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.delete(listener); }
    };
    for (const element of elements.values()) element.onFocus = () => { document.activeElement = element; };
    elements.get('transferReview').onShowModal = () => elements.get('editTransfer').focus();
    elements.get('transferHelp').onShowModal = () => elements.get('closeTransferHelp').focus();
    const windowListeners = new Map();
    const window = { location: { origin: 'https://bank-network1.example.invalid', hash: initialHash, reload() {} },
        addEventListener: (event, callback) => windowListeners.set(event, callback),
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++env.uuidCount).padStart(12, '0')}` },
        sessionStorage: { getItem: key => env.storage.get(key) ?? null, setItem: (key, value) => env.storage.set(key, value) },
        confirm: text => { env.confirmations.push(text); return env.confirm; }, scrollTo() {} };
    const entries = [window.location.hash];
    let entry = 0;
    const traverse = offset => {
        const next = entry + offset;
        if (next < 0 || next >= entries.length) return;
        entry = next; window.location.hash = entries[entry]; windowListeners.get('hashchange')?.();
    };
    window.history = { back: () => traverse(-1), forward: () => traverse(1) };
    const navigate = hash => {
        entries.splice(++entry); entries.push(hash);
        window.location.hash = hash; windowListeners.get('hashchange')?.();
    };
    const navigator = { clipboard: { writeText: async text => {
        env.clipboardWrites.push(text); if (env.copy) await env.copy();
    } } };
    class Keycloak {
        constructor() { this.authenticated = true; this.tokenParsed = env.claims; this.token = 'synthetic-test-token'; env.keycloak = this; }
        async init(options) { env.initCalls++; equal(options.pkceMethod, 'S256'); return true; }
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
    const run = new Function('Keycloak', 'TransferRequests', 'describeIntent', 'userScope', 'exactAmount', 'validateIban', 'formatIban', 'italianIbanParts', 'window', 'document',
        'navigator', 'fetch', 'console', 'alert', 'setInterval', 'clearInterval', 'setTimeout', source);
    run(Keycloak, TransferRequests, describeIntent, userScope, exactAmount, validateIban, formatIban, italianIbanParts, window, document, navigator, fetch,
        { log() {}, error() {} }, message => { throw new Error(message); },
        callback => { intervals.set(++intervalID, callback); return intervalID; },
        id => intervals.delete(id), () => {});
    return { env, elements, get: id => elements.get(id), document, window, navigator, html, intervals, visibilityListeners,
        navigate,
        tick() { for (const callback of [...intervals.values()]) callback(); },
        visibility(state) {
            document.visibilityState = state;
            for (const listener of [...visibilityListeners]) listener();
        } };
}
const recipientIban = 'DE89370400440532013000';
function fill(ui, amount = '12.30', target = recipientIban) {
    ui.get('sourceAccount').value = 'ACC-A';
    ui.get('targetAccount').value = target;
    ui.get('transferAmount').value = amount;
}

function confirmSubmission(ui) {
    ui.get('transferForm').fire('submit');
    if (ui.get('transferReview').open) ui.get('confirmTransfer').fire('click');
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
    confirmSubmission(ui);
    confirmSubmission(ui);
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
    confirmSubmission(ui); await settle();
    assert(!ui.get('confirmDuplicate').hidden);
    ui.get('confirmDuplicate').fire('click'); await settle();
    equal(ui.env.uuidCount, 1); equal(ui.env.calls.length, 1);
    assert(ui.env.confirmations[0].includes('Source: ACC-A'));
    assert(ui.env.confirmations[0].includes('Destination: ' + recipientIban));
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
    confirmSubmission(ui); await settle();
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
    confirmSubmission(ui); await settle();
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

test('untrusted destination markup is rejected without creating or sending a transfer', async () => {
    const ui = boot(); await settle();
    fill(ui, '12.30', '<svg/onload=alert(1)>');
    ui.env.respond = async () => reply(503, { code: 'COMMIT_OUTCOME_UNKNOWN' });
    confirmSubmission(ui); await settle();
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 0);
    assert(!ui.get('targetAccountError').hidden);
    equal(ui.get('transferDetails').innerHTML, '');
    assert(!ui.get('transferReview').open);
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
    equal(table.textContent, 'Load or open an account to view its transactions.');
});

test('account summary uses text and labels the balance as a snapshot through transfer and recovery', async () => {
    const ui = boot();
    const account = { ...accountFixture(), holder_name: '<svg/onload=alert(1)>', iban: '<img src=x onerror=alert(1)>' };
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, []) : reply(200, account);
    await settle();
    const summary = ui.get('onboardingTarget');
    assert(!summary.textContent.includes(account.holder_name));
    assert(summary.textContent.includes(account.iban));
    assert(summary.textContent.includes('Available balance€123.45'));
    assert(summary.textContent.includes('Your balance when this account was loaded.'));
    assert(!summary.textContent.includes('Live Balance'));
    assertNoHTMLParsing(summary);
    const snapshot = summary.textContent;
    fill(ui); confirmSubmission(ui); await settle();
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
    confirmSubmission(first); await settle();
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
    confirmSubmission(ui); await settle();
    ui.get('newTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 1);
    assert(!ui.get('sourceAccount').readOnly);
    equal(ui.get('transferAmount').value, '');
    fill(ui, '1.00');
    confirmSubmission(ui); await settle();
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

test('a loaded account prevents another onboarding POST while a poll refresh is pending', async () => {
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
    equal(calls.length, 1);
    assert(calls.every(call => call.headers.Authorization === 'Bearer synthetic-shared-refresh'));
    equal(calls.filter(call => call.method === 'POST').length, 0);
    assert(ui.get('onboardingForm').classes.has('hidden'));
    assert(ui.get('btnOnboard').disabled);
    equal(ui.visibilityListeners.size, 1);
    equal(ui.intervals.size, 1);
});

test('polling and double transfer submit share a refresh and send exactly one financial POST', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    const refresh = deferred(), before = ui.env.refreshCalls.length;
    ui.env.refresh = () => refresh.promise;
    ui.tick();
    confirmSubmission(ui); confirmSubmission(ui);
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
    confirmSubmission(ui); await settle();
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
    confirmSubmission(ui); await settle();
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
    confirmSubmission(ui);
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
    confirmSubmission(ui); await settle();
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
    confirmSubmission(ui); await settle();
    equal(ui.env.loginCalls, 1); equal(ui.env.calls.length, 1);
});

for (const operation of ['history', 'onboarding', 'transfer']) {
    test(`logout during awaited ${operation} refresh prevents the request even if a late token has the same subject`, async () => {
        const ui = operation === 'onboarding' ? boot() : bootWithAccount(); await settle();
        const refresh = deferred();
        ui.env.refresh = () => refresh.promise;
        if (operation === 'history') ui.tick();
        if (operation === 'onboarding') ui.get('onboardingForm').fire('submit');
        if (operation === 'transfer') {
            fill(ui); confirmSubmission(ui);
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
        if (operation === 'transfer') { fill(ui); confirmSubmission(ui); }
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
    confirmSubmission(ui); await settle();
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
    confirmSubmission(ui); await settle();
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
    confirmSubmission(ui); await settle();
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 1);
    const saved = JSON.parse([...ui.env.storage.values()][0]);
    equal(saved.intents[0].outcome, 'UNRESOLVED');
    equal(saved.intents[0].amount, '12.30');
    assert(ui.get('transferDetails').textContent.includes(saved.intents[0].transfer_request_id));
    confirmSubmission(ui); ui.get('checkTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 1);
});

test('dashboard headings, navigation targets and contextual recovery help are meaningful', async () => {
    const ui = boot(); await settle();
    assert(/<h1[^>]*>Dashboard<\/h1>/.test(ui.html));
    assert(ui.html.includes('>New Transfer</h2>'));
    assert(ui.html.includes('>Transaction History</h2>'));
    assert(!ui.html.includes('href="#"'));
    for (const [linkID, sectionID] of [['dashboardLink', 'dashboard'], ['accountLink', 'accountOverview'],
        ['transfersLink', 'transfers'], ['historyLink', 'transactions']]) {
        equal(ui.get(linkID).getAttribute('href'), '#' + sectionID);
        assert(ui.get(sectionID));
        ui.navigate('#' + sectionID);
        equal(ui.get(linkID).getAttribute('aria-current'), 'page');
        equal([...ui.elements.values()].filter(element => element.getAttribute('aria-current') === 'page').length, 1);
        assert(ui.get(linkID).classes.has('active'));
    }
    ui.navigate('#unknown');
    equal(ui.get('dashboardLink').getAttribute('aria-current'), 'page');
    assert(!ui.html.includes('About transfers and recovery'));
    equal(ui.get('transferHelpButton').getAttribute('aria-controls'), 'transferHelp');
    assert(/<details class="request-details">[\s\S]*id="transferDetails"/.test(ui.html));
});

test('account loading and no-account states never display a placeholder balance', async () => {
    const ui = boot(), response = deferred();
    ui.env.respondAccount = () => response.promise;
    await settle();
    equal(ui.get('accountStatus').textContent, 'Loading your account…');
    equal(ui.get('accountOverview').getAttribute('aria-busy'), 'true');
    assert(ui.get('onboardingForm').classes.has('hidden'));
    assert(ui.get('onboardingTarget').classes.has('hidden'));
    equal(ui.get('onboardingTarget').textContent, '');
    assert(ui.get('btnOnboard').disabled);
    response.resolve(reply(404, {})); await settle();
    equal(ui.get('accountTitle').textContent, 'Open your account');
    assert(!ui.get('onboardingForm').classes.has('hidden'));
    assert(!ui.get('btnOnboard').disabled);
    equal(ui.get('accountOverview').getAttribute('aria-busy'), 'false');
    equal(ui.get('onboardingTarget').textContent, '');
    equal(ui.env.calls.length, 0);
});

test('account failures stay distinct from no account and allow only an explicit read-only retry', async () => {
    const ui = boot();
    ui.env.respondAccount = async () => reply(503, {});
    await settle();
    assert(ui.get('accountStatus').textContent.includes('couldn’t load'));
    assert(ui.get('onboardingForm').classes.has('hidden'));
    assert(!ui.get('retryAccount').hidden);
    equal(ui.get('onboardingTarget').textContent, '');
    equal(ui.env.readCalls.length, 1);
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, []) : reply(200, accountFixture());
    ui.get('retryAccount').fire('click'); await settle();
    equal(ui.env.readCalls.filter(call => call.url.includes('/accounts/')).length, 2);
    assert(ui.env.readCalls.every(call => !call.method));
    equal(ui.get('accountTitle').textContent, 'Account Overview');
    assert(!ui.get('onboardingTarget').classes.has('hidden'));
    assert(ui.get('retryAccount').hidden);
});

test('loaded account uses a real zero balance and presents the customer name only in the profile', async () => {
    const ui = bootWithAccount();
    ui.env.keycloak.tokenParsed = { ...ui.env.claims, given_name: 'Synthetic', family_name: 'Customer' };
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, [])
        : reply(200, { ...accountFixture(), holder_name: 'Synthetic Customer', balance: 0 });
    await settle();
    equal(ui.elements.get('.user-name').textContent, 'Synthetic Customer');
    equal(ui.elements.get('.avatar').textContent, 'SC');
    const summary = ui.get('onboardingTarget');
    assert(summary.textContent.includes('Available balance€0.00'));
    assert(summary.textContent.includes('Account numberACC-A'));
    assert(summary.textContent.includes('IBANSYNTHETIC-IBAN'));
    assert(!summary.textContent.includes('Synthetic Customer'));
    assert(summary.textContent.includes('updated snapshot'));
    assert(ui.get('accountStatus').hidden);
    assertNoHTMLParsing(summary);
});

test('missing account balance is not coerced to a real zero balance', async () => {
    const ui = boot();
    ui.env.respondAccount = async () => reply(200, { ...accountFixture(), balance: null });
    await settle();
    equal(ui.get('onboardingTarget').textContent, '');
    assert(ui.get('onboardingForm').classes.has('hidden'));
    assert(ui.get('accountStatus').textContent.includes('couldn’t load'));
    equal(ui.intervals.size, 0);
});

test('opening an account has a busy state, ignores double submit and shows the returned balance', async () => {
    const ui = boot(); await settle();
    const response = deferred();
    ui.env.respondAccount = () => response.promise;
    ui.get('holderName').value = 'Synthetic Owner';
    ui.get('initialDeposit').value = '20.00';
    ui.get('onboardingForm').fire('submit'); ui.get('onboardingForm').fire('submit'); await settle();
    assert(ui.get('btnOnboard').disabled);
    equal(ui.get('btnOnboard').textContent, 'Opening account…');
    equal(ui.get('accountOverview').getAttribute('aria-busy'), 'true');
    equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 1);
    equal(ui.get('onboardingTarget').textContent, '');
    ui.env.respondAccount = async () => reply(200, []);
    response.resolve(reply(201, { account_details: { ...accountFixture(), balance: 20 } })); await settle();
    equal(ui.get('accountTitle').textContent, 'Account Overview');
    assert(ui.get('onboardingForm').classes.has('hidden'));
    assert(ui.get('onboardingTarget').textContent.includes('€20.00'));
    equal(ui.get('accountOverview').getAttribute('aria-busy'), 'false');
});

test('an unconfirmed account creation requires a read-only check and never automatically retries the POST', async () => {
    const ui = boot(); await settle();
    ui.env.respondAccount = async () => { throw new Error('Synthetic lost response'); };
    ui.get('holderName').value = 'Synthetic Owner'; ui.get('initialDeposit').value = '20.00';
    ui.get('onboardingForm').fire('submit'); await settle();
    assert(ui.get('accountStatus').textContent.includes('creation was not confirmed'));
    assert(ui.get('onboardingForm').classes.has('hidden'));
    assert(!ui.get('retryAccount').hidden);
    equal(ui.get('onboardingTarget').textContent, '');
    ui.get('onboardingForm').fire('submit'); await settle();
    equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 1);
    ui.env.respondAccount = async () => reply(404, {});
    ui.get('retryAccount').fire('click'); await settle();
    equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 1);
    assert(!ui.get('onboardingForm').classes.has('hidden'));
    assert(!ui.get('btnOnboard').disabled);
});

test('a refresh failure during account opening preserves form inputs and pending transfer recovery', async () => {
    const ui = boot(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Synthetic lost transfer response'); };
    confirmSubmission(ui); await settle();
    ui.navigate('#transfers');
    const saved = [...ui.env.storage.entries()], details = ui.get('transferDetails').textContent;
    ui.get('holderName').value = 'Synthetic Owner'; ui.get('initialDeposit').value = '20.00';
    ui.env.refresh = async () => { throw new Error('Synthetic transient refresh failure'); };
    ui.get('onboardingForm').fire('submit'); await settle();
    equal(ui.get('holderName').value, 'Synthetic Owner'); equal(ui.get('initialDeposit').value, '20.00');
    equal([...ui.env.storage.entries()], saved); equal(ui.get('transferDetails').textContent, details);
    assert(ui.get('btnOnboard').disabled);
    assert(ui.get('accountStatus').textContent.includes('Requests are paused'));
    equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 0);
    equal(ui.env.calls.length, 1);
});

test('a late account creation response after logout cannot restore the previous customer view', async () => {
    const ui = boot(); await settle();
    const response = deferred(); ui.env.respondAccount = () => response.promise;
    ui.get('holderName').value = 'Synthetic Owner'; ui.get('initialDeposit').value = '20.00';
    ui.get('onboardingForm').fire('submit'); await settle();
    equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 1);
    ui.get('logoutBtn').fire('click'); await settle();
    response.resolve(reply(201, { account_details: accountFixture() })); await settle();
    equal(ui.get('onboardingTarget').textContent, '');
    equal(ui.get('sourceAccount').value, '');
    assert(ui.get('btnOnboard').disabled);
    equal(ui.get('accountStatus').textContent, 'Sign in to view your account.');
    equal(ui.intervals.size, 0);
});

for (const history of [[], null]) {
    test(`an owned account with ${history === null ? 'null' : 'empty'} history uses the exact account empty message`, async () => {
        const ui = bootWithAccount();
        ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, history) : reply(200, accountFixture());
        await settle();
        equal(ui.get('historyTableBody').textContent, 'No transactions found for this account.');
        assert(ui.get('historyTable').classes.has('is-empty'));
        assert(ui.get('tableHelp').hidden);
        ui.get('logoutBtn').fire('click'); await settle();
        equal(ui.get('historyTableBody').textContent, 'Load or open an account to view its transactions.');
    });
}

test('a successful but empty HTTP body is a history error, while a JSON empty array is the empty state', async () => {
    const ui = bootWithAccount(), response = deferred();
    ui.env.respondAccount = async url => url.includes('/transactions') ? response.promise : reply(200, accountFixture());
    await settle();
    equal(ui.get('historyTableBody').textContent, 'Loading transactions…');
    response.resolve({ status: 200, ok: true, json: async () => JSON.parse('') });
    await settle();
    assert(ui.get('historyTableBody').textContent.includes('history is unavailable'));
    assert(ui.get('recentTransactionsStatus').textContent.includes('history is unavailable'));
    ui.env.respondAccount = async () => ({ status: 200, ok: true, json: async () => JSON.parse('[]') });
    ui.tick(); await settle(); ui.navigate('#transactions');
    equal(ui.get('historyTableBody').textContent, 'No transactions found for this account.');
    equal(ui.get('recentTransactionsStatus').textContent, 'No recent transactions yet. Make a transfer to see activity here.');
    equal(ui.intervals.size, 1); equal(ui.env.calls.length, 0);
});

test('transaction history has distinct loading and error states and preserves data on later failures', async () => {
    const ui = bootWithAccount(), response = deferred();
    ui.env.respondAccount = async url => url.includes('/transactions') ? response.promise : reply(200, accountFixture());
    await settle();
    equal(ui.get('historyTableBody').textContent, 'Loading transactions…');
    response.resolve(reply(503, {})); await settle();
    assert(ui.get('historyTableBody').textContent.includes('history is unavailable'));
    ui.env.respondAccount = async () => reply(200, [{ transaction_id: 'TX-SYNTHETIC', target_iban: 'SYNTHETIC-IBAN',
        amount: 1234.5, status: 'PENDING', timestamp: '2026-03-08 14:07:23.123456' }]);
    ui.tick(); await settle();
    const table = ui.get('historyTableBody');
    equal(table.children[0].children.map(cell => cell.textContent),
        ['TX-SYNTHETIC', 'SYNTHETIC-IBAN', '€1,234.50', 'Pending', '08 Mar 2026, 14:07']);
    equal(table.children[0].children[2].className, 'amount-cell');
    assert(!ui.get('historyTable').classes.has('is-empty'));
    assert(!ui.get('tableHelp').hidden);
    const previous = table.textContent;
    ui.env.respondAccount = async () => reply(503, {});
    ui.tick(); await settle();
    equal(table.textContent, previous);
    const calls = ui.env.readCalls.length;
    ui.visibility('hidden');
    equal(ui.intervals.size, 0);
    ui.tick(); await settle();
    equal(ui.env.readCalls.length, calls);
    ui.visibility('visible'); await settle();
    equal(ui.intervals.size, 1);
    equal(ui.env.readCalls.length, calls + 1);
});

test('invalid monetary input shows an inline error without creating an intent or financial request', async () => {
    const ui = boot(); await settle(); fill(ui, '12.345');
    confirmSubmission(ui); await settle();
    assert(!ui.get('transferError').hidden);
    assert(ui.get('transferError').textContent.includes('two decimal places'));
    equal(ui.env.uuidCount, 0); equal(ui.env.calls.length, 0);
    ui.get('transferAmount').value = '12.30'; ui.get('transferAmount').fire('input');
    assert(ui.get('transferError').hidden);
    const response = deferred(); ui.env.respond = () => response.promise;
    confirmSubmission(ui); await settle();
    equal(ui.get('btnTransfer').textContent, 'Processing…');
    equal(ui.get('transferForm').getAttribute('aria-busy'), 'true');
    response.resolve(commit()); await settle();
    equal(ui.get('btnTransfer').textContent, 'Review transfer');
    equal(ui.get('transferForm').getAttribute('aria-busy'), 'false');
    equal(ui.env.calls.length, 1);
});

test('native form validation exposes accessible inline feedback and clears it on editing', async () => {
    const ui = boot(); await settle();
    const field = ui.get('targetAccount');
    field.validationMessage = 'Please fill out this field.';
    ui.get('transferForm').fire('invalid', { target: field });
    equal(field.getAttribute('aria-invalid'), 'true');
    equal(ui.get('transferError').textContent, 'Please fill out this field.');
    field.fire('input');
    equal(field.getAttribute('aria-invalid'), null);
    assert(ui.get('transferError').hidden);
    equal(ui.env.calls.length, 0);
    for (const id of ['holderName', 'initialDeposit', 'sourceAccount', 'targetAccount', 'transferAmount']) {
        assert(ui.html.includes(`for="${id}"`));
    }
    assert(ui.html.includes('class="skip-link"'));
    assert(!ui.html.includes('fonts.googleapis.com'));
});

test('transfer help opens a labelled dialog, focuses its close control and makes no API requests', async () => {
    const ui = bootWithAccount(); await settle();
    ui.navigate('#transfers');
    const button = ui.get('transferHelpButton'), dialog = ui.get('transferHelp');
    const calls = ui.env.readCalls.length, refreshes = ui.env.refreshCalls.length;
    equal(button.getAttribute('type'), 'button');
    equal(button.getAttribute('aria-label'), 'Help with transfers and recovery');
    equal(button.getAttribute('aria-haspopup'), 'dialog');
    equal(button.getAttribute('aria-controls'), 'transferHelp');
    equal(dialog.tagName, 'DIALOG');
    equal(dialog.getAttribute('aria-labelledby'), 'transferHelpTitle');
    equal(dialog.getAttribute('aria-describedby'), 'transferHelpDescription');
    assert(ui.html.includes('type="button" autofocus>Got it'));
    assert(!dialog.open);
    button.focus(); button.fire('click'); button.fire('click'); await settle();
    assert(dialog.open);
    equal(ui.document.activeElement, ui.get('closeTransferHelp'));
    equal(ui.env.readCalls.length, calls); equal(ui.env.refreshCalls.length, refreshes);
    equal(ui.env.calls.length, 0); equal(ui.intervals.size, 1);
    ui.get('closeTransferHelp').fire('click');
    assert(!dialog.open);
    equal(ui.document.activeElement, button);
});

test('native dialog cancellation returns focus to the help control without affecting transfers', async () => {
    const ui = boot(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Synthetic lost response'); };
    confirmSubmission(ui); await settle();
    ui.navigate('#transfers');
    const saved = [...ui.env.storage.entries()], details = ui.get('transferDetails').textContent;
    ui.get('transferHelpButton').focus(); ui.get('transferHelpButton').fire('click');
    // Model the browser's default Escape/cancel behavior; real keyboard handling is browser-tested.
    ui.get('transferHelp').cancel(); await settle();
    assert(!ui.get('transferHelp').open);
    equal(ui.document.activeElement, ui.get('transferHelpButton'));
    equal([...ui.env.storage.entries()], saved);
    equal(ui.get('transferDetails').textContent, details);
    equal(ui.env.calls.length, 1);
});

test('customer help and nearby copy omit infrastructure details and the polling notice', async () => {
    const ui = boot(); await settle();
    const help = ui.html.match(/<dialog id="transferHelp"[^>]*>([\s\S]*?)<\/dialog>/)[1];
    assert(help.includes('check the saved transfer’s status before sending another payment'));
    assert(help.includes('Transfers are never resent automatically'));
    assert(help.includes('confirming a separate duplicate requests another payment'));
    assert(!/network[12]|browser storage|UUID|service mesh|OpenShift|demo|Ledger|Orchestrator/i.test(ui.html));
    assert(!ui.html.includes('sidebar-footer'));
    assert(!ui.html.includes('context-help'));
    assert(!ui.html.includes('historyUpdateNote'));
    assert(!readFile('src/intermesh-ui/src/js/app.js').includes('Updates every 15 seconds'));
});


function visibleViews(ui) {
    return ['dashboard', 'accountOverview', 'transfers', 'transactions'].filter(id => !ui.get(id).hidden);
}

test('each view changes heading and focus without another API request, refresh, login or polling loop', async () => {
    const ui = bootWithAccount(); await settle();
    equal(visibleViews(ui), ['dashboard']);
    const reads = ui.env.readCalls.length, refreshes = ui.env.refreshCalls.length;
    const summary = ui.get('onboardingTarget').textContent;
    for (const [id, title] of [['transfers', 'Transfers'], ['transactions', 'History'], ['accountOverview', 'My Account'], ['dashboard', 'Dashboard']]) {
        ui.navigate('#' + id);
        equal(visibleViews(ui), [id]); equal(ui.get('pageTitle').textContent, title);
        equal(ui.document.title, `${title} · InterMesh Bank`);
        equal(ui.document.activeElement, ui.get('pageTitle'));
        equal(ui.intervals.size, 1); equal(ui.visibilityListeners.size, 1);
    }
    equal(ui.env.readCalls.length, reads); equal(ui.env.refreshCalls.length, refreshes);
    equal(ui.env.initCalls, 1); equal(ui.env.loginCalls, 0); equal(ui.env.calls.length, 0);
    equal(ui.get('onboardingTarget').textContent, summary);
    for (const [link, target] of [['dashboardAccountLink', 'accountOverview'], ['dashboardTransferLink', 'transfers'],
        ['dashboardHistoryLink', 'transactions'], ['dashboardRecentLink', 'transactions']]) {
        equal(ui.get(link).getAttribute('href'), '#' + target);
    }
});

test('Back and Forward restore views while preserving the draft, balance and shared polling', async () => {
    const ui = bootWithAccount(); await settle();
    ui.navigate('#transfers'); fill(ui, '9999999999999.99', 'SYNTHETIC-DESTINATION');
    ui.navigate('#transactions'); ui.navigate('#accountOverview');
    ui.window.history.back(); equal(visibleViews(ui), ['transactions']);
    ui.window.history.back(); equal(visibleViews(ui), ['transfers']);
    equal(ui.get('transferAmount').value, '9999999999999.99');
    equal(ui.get('targetAccount').value, 'SYNTHETIC-DESTINATION');
    ui.window.history.forward(); equal(visibleViews(ui), ['transactions']);
    ui.window.history.forward(); equal(visibleViews(ui), ['accountOverview']);
    equal(ui.intervals.size, 1); equal(ui.env.readCalls.length, 2); equal(ui.env.calls.length, 0);
});

for (const section of ['dashboard', 'accountOverview', 'transfers', 'transactions', 'unknown']) {
    test(`direct fragment #${section} selects a view after one authentication initialization`, async () => {
        const ui = boot(null, '#' + section); await settle();
        equal(visibleViews(ui), [section === 'unknown' ? 'dashboard' : section]);
        equal(ui.document.activeElement, ui.get('pageTitle'));
        equal(ui.env.initCalls, 1); equal(ui.env.loginCalls, 0);
    });
}

test('navigation preserves an in-flight financial POST, exact amount, UUID and busy state', async () => {
    const ui = bootWithAccount(); await settle();
    const pending = deferred(); ui.env.respond = () => pending.promise;
    ui.navigate('#transfers'); fill(ui, '12.30'); confirmSubmission(ui); await settle();
    const saved = [...ui.env.storage.entries()], body = ui.env.calls[0].body;
    for (const view of ['transactions', 'accountOverview', 'dashboard', 'transfers']) {
        ui.navigate('#' + view);
        equal(ui.get('transferAmount').value, '12.30'); assert(ui.get('btnTransfer').disabled);
        assert(ui.get('targetAccount').readOnly);
    }
    confirmSubmission(ui); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1); equal([...ui.env.storage.entries()], saved);
    pending.resolve(commit()); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.calls[0].body, body);
    assert(ui.get('transferStatus').textContent.includes('APPROVED'));
    ui.navigate('#dashboard'); ui.navigate('#transfers');
    equal(ui.env.calls.length, 1); assert(ui.get('transferStatus').textContent.includes('APPROVED'));
});

test('account loading, onboarding draft and creation busy state survive view changes', async () => {
    const ui = boot(), lookup = deferred(), creation = deferred();
    ui.env.respondAccount = () => lookup.promise; await settle();
    ui.navigate('#accountOverview'); ui.navigate('#dashboard');
    assert(ui.get('dashboardAccountSummary').hidden);
    equal(ui.get('dashboardAccountStatus').textContent, 'Loading your account…');
    lookup.resolve(reply(404, {})); await settle();
    ui.navigate('#accountOverview');
    ui.get('holderName').value = 'Synthetic customer'; ui.get('initialDeposit').value = '42.00';
    ui.navigate('#transfers'); ui.navigate('#accountOverview');
    equal(ui.get('holderName').value, 'Synthetic customer'); equal(ui.get('initialDeposit').value, '42.00');
    ui.env.respondAccount = (url, options) => options.method === 'POST' ? creation.promise : reply(200, []);
    ui.get('onboardingForm').fire('submit'); await settle();
    ui.navigate('#dashboard'); assert(ui.get('dashboardAccountSummary').hidden);
    assert(ui.get('dashboardAccountStatus').textContent.includes('Opening your account'));
    ui.navigate('#accountOverview'); ui.get('onboardingForm').fire('submit'); await settle();
    equal(ui.env.readCalls.filter(call => call.method === 'POST').length, 1);
    creation.resolve(reply(200, { account_details: accountFixture() })); await settle();
    assert(!ui.get('onboardingTarget').classes.has('hidden'));
    assert(!ui.get('dashboardAccountSummary').hidden); equal(ui.intervals.size, 1);
});

test('Dashboard shares real balance and only three safe recent rows with History and one polling loop', async () => {
    const ui = bootWithAccount();
    const hostile = '<img src=x onerror=alert(1)>';
    let rows = Array.from({ length: 5 }, (_, index) => ({ transaction_id: 'TX-' + index,
        target_iban: index === 0 ? hostile : 'SYNTHETIC-' + index, amount: 12.30,
        timestamp: '2026-11-23 12:30:00', status: index === 0 ? hostile : 'APPROVED' }));
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, rows) : reply(200, accountFixture());
    await settle();
    const summary = ui.get('dashboardAccountSummary'), recent = ui.get('recentTransactionsList');
    assert(summary.textContent.includes('€123.45')); assert(summary.textContent.includes('Balance snapshot'));
    assert(!summary.textContent.includes('SYNTHETIC-IBAN'));
    equal(recent.children.length, 3); equal(ui.get('historyTableBody').children.length, 5);
    assert(recent.textContent.includes(hostile)); assert(recent.textContent.includes('23 Nov 2026, 12:30'));
    assert(recent.textContent.includes('€12.30')); assertNoHTMLParsing(recent);
    rows = []; ui.navigate('#transfers'); ui.tick(); await settle();
    equal(recent.children.length, 0); assert(recent.hidden);
    equal(ui.get('recentTransactionsStatus').textContent, 'No recent transactions yet. Make a transfer to see activity here.');
    equal(ui.get('historyTableBody').textContent, 'No transactions found for this account.');
    equal(ui.intervals.size, 1); equal(ui.env.readCalls.length, 3);
});

test('Dashboard copy and full-card quick actions retain their existing navigation without extra requests', async () => {
    const ui = bootWithAccount(); await settle();
    equal(ui.get('pageTitle').textContent, 'Dashboard');
    equal(ui.get('pageSubtitle').textContent, 'Welcome back. Your everyday banking, all in one place.');
    assert(ui.html.includes('<p class="eyebrow">Everyday banking</p>'));
    assert(ui.html.includes('href="#accountOverview">View account</a>'));
    assert(ui.html.includes('href="#transactions">View all transactions</a>'));
    const reads = ui.env.readCalls.length, refreshes = ui.env.refreshCalls.length;
    for (const [id, view, description] of [
        ['dashboardTransferLink', 'transfers', 'Send money from your account'],
        ['dashboardHistoryLink', 'transactions', 'Review recent account activity']
    ]) {
        const link = ui.get(id);
        equal(link.tagName, 'A'); equal(link.getAttribute('href'), '#' + view);
        assert(link.classes.has('quick-action')); assert(link.getAttribute('tabindex') !== '-1');
        const markup = ui.html.match(new RegExp(`<a id="${id}"[^>]*>(.*?)</a>`))[1];
        assert(markup.includes(`<small>${description}</small>`));
        assert(!/<button|<a\b/.test(markup));
        ui.navigate(link.getAttribute('href')); equal(visibleViews(ui), [view]);
    }
    equal(ui.env.readCalls.length, reads); equal(ui.env.refreshCalls.length, refreshes);
    equal(ui.env.calls.length, 0); equal(ui.env.initCalls, 1);
});

for (const failure of ['HTTP error', 'network error']) {
    test(`Dashboard recent activity distinguishes loading, ${failure}, empty and populated responses`, async () => {
        const ui = boot(), account = deferred(), history = deferred();
        const emptyMessage = 'No recent transactions yet. Make a transfer to see activity here.';
        ui.env.respondAccount = url => url.includes('/transactions') ? history.promise : account.promise;
        await settle();
        equal(ui.get('dashboardAccountStatus').textContent, 'Loading your account…');
        assert(ui.get('dashboardAccountSummary').hidden);
        assert(ui.get('recentTransactionsStatus').textContent !== emptyMessage);
        account.resolve(reply(200, accountFixture())); await settle();
        equal(ui.get('recentTransactionsStatus').textContent, 'Loading transactions…');
        if (failure === 'HTTP error') history.resolve(reply(503, []));
        else history.reject(new Error('Synthetic network failure'));
        await settle();
        assert(ui.get('recentTransactionsStatus').textContent.includes('history is unavailable'));
        assert(!ui.get('recentTransactionsStatus').hidden);
        assert(ui.get('recentTransactionsList').hidden);
        ui.env.respondAccount = async () => reply(200, []); ui.tick(); await settle();
        equal(ui.get('recentTransactionsStatus').textContent, emptyMessage);
        equal(ui.get('historyTableBody').textContent, 'No transactions found for this account.');
        ui.env.respondAccount = async () => reply(200, [{ transaction_id: 'TX-SYNTHETIC',
            target_iban: 'SYNTHETIC-IBAN', amount: 12.30, status: 'APPROVED', timestamp: '2026-11-23 12:30:00' }]);
        ui.tick(); await settle();
        equal(ui.get('recentTransactionsList').children.length, 1);
        assert(!ui.get('recentTransactionsList').hidden); assert(ui.get('recentTransactionsStatus').hidden);
        assert(ui.get('recentTransactionsList').textContent.includes('€12.30'));
        equal(ui.intervals.size, 1); equal(ui.env.calls.length, 0);
    });
}

for (const status of [404, 503]) {
    test(`an account ${status} response does not invent a Dashboard transaction empty state`, async () => {
        const ui = boot(); ui.env.respondAccount = async () => reply(status, {}); await settle();
        assert(ui.get('dashboardAccountSummary').hidden);
        equal(ui.get('dashboardAccountSummary').textContent, '');
        equal(ui.get('recentTransactionsStatus').textContent, 'Load or open an account to see recent activity.');
        assert(ui.get('recentTransactionsList').hidden); equal(ui.intervals.size, 0);
    });
}

test('Dashboard abbreviates only the returned IBAN while the Account view and clipboard retain its full value', async () => {
    const ui = bootWithAccount();
    const iban = 'IT99X0306905000000100004001';
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, [])
        : reply(200, { ...accountFixture(), iban });
    await settle();
    const summary = ui.get('dashboardAccountSummary');
    assert(summary.textContent.includes('IBAN IT99 … 4001')); assert(!summary.textContent.includes(iban));
    assert(summary.textContent.includes('€123.45')); assert(summary.textContent.includes('Balance snapshot'));
    assertNoHTMLParsing(summary);
    ui.navigate('#accountOverview'); assert(ui.get('onboardingTarget').textContent.includes(formatIban(iban)));
    ui.get('copyIban').fire('click'); await settle(); equal(ui.env.clipboardWrites, [iban]);
    equal(ui.env.readCalls.length, 2); equal(ui.env.calls.length, 0);
});

test('Dashboard omits an IBAN abbreviation when the supplied value is too short to abbreviate', async () => {
    const ui = bootWithAccount();
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, [])
        : reply(200, { ...accountFixture(), iban: 'SHORT' });
    await settle();
    const summary = ui.get('dashboardAccountSummary');
    assert(!summary.children.some(child => child.classes.has('dashboard-iban')));
    assert(summary.textContent.includes('Account ACC-A')); assert(summary.textContent.includes('€123.45'));
});

test('IBAN copying gives accessible success feedback without API calls and survives navigation', async () => {
    const ui = bootWithAccount(); await settle(); ui.navigate('#accountOverview');
    const pending = deferred(); ui.env.copy = () => pending.promise;
    ui.get('copyIban').fire('click'); await settle();
    equal(ui.env.clipboardWrites, ['SYNTHETIC-IBAN']);
    assert(ui.get('copyIban').disabled); equal(ui.get('ibanCopyStatus').textContent, 'Copying IBAN…');
    ui.navigate('#dashboard'); ui.navigate('#accountOverview');
    pending.resolve(); await settle();
    equal(ui.get('ibanCopyStatus').textContent, 'IBAN copied.'); assert(!ui.get('copyIban').disabled);
    equal(ui.get('ibanCopyStatus').getAttribute('role'), 'status');
    equal(ui.env.readCalls.length, 2); equal(ui.env.calls.length, 0);
});

for (const failure of ['denied', 'unavailable']) {
    test(`clipboard ${failure} preserves selectable IBAN and provides an accessible manual fallback`, async () => {
        const ui = bootWithAccount(); await settle();
        if (failure === 'denied') ui.env.copy = async () => { throw new Error('Synthetic permission denial'); };
        else ui.navigator.clipboard = undefined;
        ui.get('copyIban').fire('click'); await settle();
        assert(ui.get('ibanCopyStatus').textContent.includes('copy it manually'));
        assert(ui.get('onboardingTarget').textContent.includes('SYNTHETIC-IBAN'));
        assert(!ui.get('copyIban').disabled); equal(ui.env.calls.length, 0);
    });
}

for (const change of ['logout', 'identity']) {
    test(`${change} clears dashboard data and prevents an awaited clipboard write restoring old feedback`, async () => {
        const ui = bootWithAccount(); await settle();
        const pending = deferred(); ui.env.copy = () => pending.promise;
        ui.get('copyIban').fire('click'); await settle();
        if (change === 'logout') ui.get('logoutBtn').fire('click');
        else {
            ui.env.respondAccount = async () => reply(404, {});
            ui.env.keycloak.tokenParsed = { ...ui.env.claims, sub: 'synthetic-b', preferred_username: 'synthetic-b' };
            ui.env.keycloak.onAuthRefreshSuccess();
        }
        await settle(); pending.resolve(); await settle();
        equal(ui.get('dashboardAccountSummary').textContent, ''); equal(ui.get('recentTransactionsList').children.length, 0);
        equal(ui.get('ibanCopyStatus').textContent, ''); assert(ui.get('ibanCopyControls').hidden);
    });
}

test('authentication pause is visible in every view while retaining the shared account and draft', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    ui.env.refresh = async () => { throw new Error('Synthetic transient failure'); };
    ui.tick(); await settle();
    for (const view of ['dashboard', 'accountOverview', 'transfers', 'transactions']) {
        ui.navigate('#' + view);
        assert(!ui.get('authenticationStatus').hidden);
        assert(ui.get('authenticationStatus').textContent.includes('Requests are paused'));
        assert(ui.get('dashboardAccountSummary').textContent.includes('€123.45'));
        equal(ui.get('transferAmount').value, '12.30');
    }
    equal(ui.intervals.size, 0); assert(ui.get('copyIban').disabled);
    equal(ui.env.calls.length, 0);
});

test('leaving Transfers closes its dialog without returning focus to a hidden control', async () => {
    const ui = bootWithAccount(); await settle(); ui.navigate('#transfers');
    ui.get('transferHelpButton').fire('click'); assert(ui.get('transferHelp').open);
    ui.window.history.back();
    equal(visibleViews(ui), ['dashboard']); assert(!ui.get('transferHelp').open);
    equal(ui.document.activeElement, ui.get('pageTitle'));
    ui.window.history.forward(); equal(visibleViews(ui), ['transfers']);
    ui.get('skipToContent').fire('click');
    equal(ui.document.activeElement, ui.get('pageTitle')); equal(ui.window.location.hash, '#transfers');
});

test('navigation retains an uncertain saved transfer without replaying or allocating another request', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui);
    ui.env.respond = async () => { throw new Error('Synthetic lost response'); };
    confirmSubmission(ui); await settle();
    const saved = [...ui.env.storage.entries()], details = ui.get('transferDetails').textContent;
    const reads = ui.env.readCalls.length;
    for (const view of ['dashboard', 'transactions', 'accountOverview', 'transfers']) ui.navigate('#' + view);
    equal([...ui.env.storage.entries()], saved); equal(ui.get('transferDetails').textContent, details);
    equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1); equal(ui.env.readCalls.length, reads);
    assert(ui.get('sourceAccount').readOnly); assert(ui.get('transferStatus').textContent.includes('not confirmed'));
    assert(!ui.get('checkTransfer').disabled);
});

test('logout clears recent activity and a late poll cannot restore Dashboard data', async () => {
    const ui = bootWithAccount();
    const transaction = { transaction_id: 'TX-A', target_iban: 'SYNTHETIC-PRIVATE-RECIPIENT',
        amount: 12.30, status: 'PENDING', timestamp: '2026-11-23 12:00:00' };
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, [transaction]) : reply(200, accountFixture());
    await settle(); assert(ui.get('recentTransactionsList').textContent.includes(transaction.target_iban));
    const pending = deferred(); ui.env.respondAccount = () => pending.promise;
    ui.tick(); await settle(); ui.get('logoutBtn').fire('click'); await settle();
    pending.resolve(reply(200, [transaction])); await settle();
    for (const view of ['dashboard', 'transactions', 'accountOverview', 'transfers']) ui.navigate('#' + view);
    equal(ui.get('recentTransactionsList').textContent, ''); equal(ui.get('dashboardAccountSummary').textContent, '');
    assert(!ui.get('historyTableBody').textContent.includes(transaction.target_iban)); equal(ui.intervals.size, 0);
});

test('review shows exact validated details and allocates no request until explicit confirmation', async () => {
    const ui = bootWithAccount(); await settle(); ui.navigate('#transfers');
    fill(ui, '12.3', ' de89 3704 0044 0532 0130 00 ');
    ui.get('transferForm').fire('submit'); await settle();
    assert(ui.get('transferReview').open); equal(ui.document.activeElement, ui.get('editTransfer'));
    equal(ui.get('targetAccount').value, recipientIban);
    equal(ui.get('transferReviewDetails').textContent, 'From accountACC-ARecipient IBANDE89 3704 0044 0532 0130 00Amount€12.30');
    assertNoHTMLParsing(ui.get('transferReviewDetails'));
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 0); equal(ui.env.storage.size, 0);
    ui.get('confirmTransfer').fire('click'); ui.get('confirmTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1);
    const sent = JSON.parse(ui.env.calls[0].body);
    equal(sent.target_account, recipientIban); equal(sent.amount, 12.3);
    equal(sent.allowDuplicatePendingTransfer, false);
    assert(ui.get('transferDetails').textContent.includes('TX-synthetic'));
    equal(ui.get('transferLifecycle').textContent, 'Completed');
});

for (const exit of ['edit', 'escape', 'navigation']) {
    test(`review ${exit} preserves the draft without creating or sending a transfer`, async () => {
        const ui = boot(); await settle(); ui.navigate('#transfers'); fill(ui);
        ui.get('transferForm').fire('submit');
        if (exit === 'edit') ui.get('editTransfer').fire('click');
        if (exit === 'escape') ui.get('transferReview').cancel();
        if (exit === 'navigation') ui.navigate('#transactions');
        ui.get('confirmTransfer').fire('click'); await settle();
        assert(!ui.get('transferReview').open); equal(ui.env.uuidCount, 0); equal(ui.env.calls.length, 0);
        equal(ui.get('transferAmount').value, '12.30'); equal(ui.get('targetAccount').value, recipientIban);
        if (exit !== 'navigation') equal(ui.document.activeElement, ui.get('btnTransfer'));
        else equal(ui.document.activeElement, ui.get('pageTitle'));
        ui.navigate('#transfers'); ui.get('transferForm').fire('submit');
        assert(ui.get('transferReview').open); equal(ui.env.calls.length, 0);
    });
}

for (const change of ['logout', 'identity']) {
    test(`${change} while reviewing invalidates confirmation without discarding persistent recovery records`, async () => {
        const ui = boot(); await settle(); ui.navigate('#transfers'); fill(ui);
        ui.get('transferForm').fire('submit');
        if (change === 'logout') ui.get('logoutBtn').fire('click');
        else {
            ui.env.keycloak.tokenParsed = { ...ui.env.claims, sub: 'synthetic-other' };
            ui.env.keycloak.onAuthRefreshSuccess();
        }
        ui.get('confirmTransfer').fire('click'); await settle();
        equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 0); assert(!ui.get('transferReview').open);
    });
}

test('same-subject token refresh during review uses the current token after confirmation', async () => {
    const ui = boot(); await settle(); fill(ui); ui.get('transferForm').fire('submit');
    ui.env.refresh = async keycloak => { keycloak.token = 'synthetic-refreshed-token'; return true; };
    ui.env.keycloak.onAuthRefreshSuccess();
    ui.get('confirmTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.calls[0].headers.Authorization, 'Bearer synthetic-refreshed-token');
});

for (const amount of ['0', '-1', '1.001', '1.000', 'NaN', 'Infinity', '1e2', '1,20', '', '10000000000000']) {
    test(`amount ${JSON.stringify(amount)} is rejected before confirmation or any financial call`, async () => {
        const ui = boot(); await settle(); fill(ui, amount);
        ui.get('transferForm').fire('submit'); ui.get('confirmTransfer').fire('click'); await settle();
        equal(ui.get('transferAmount').getAttribute('aria-invalid'), 'true');
        assert(!ui.get('transferAmountError').hidden); equal(ui.document.activeElement, ui.get('transferAmount'));
        assert(!ui.get('transferReview').open); equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 0);
        ui.get('transferAmount').value = '0.01'; ui.get('transferAmount').fire('input');
        assert(ui.get('transferAmountError').hidden);
    });
}

for (const [iban, message] of [['DE89370400440532013001', 'check digits'], ['DE8937040044053201300', '22 characters'],
    ['ZZ89370400440532013000', 'country code'], ['<img src=x onerror=alert(1)>', 'country code']]) {
    test(`recipient ${JSON.stringify(iban)} has field-specific format feedback without a recipient lookup`, async () => {
        const ui = boot(); await settle(); fill(ui, '12.30', iban);
        const reads = ui.env.readCalls.length; ui.get('transferForm').fire('submit'); await settle();
        assert(ui.get('targetAccountError').textContent.includes(message));
        equal(ui.get('targetAccount').getAttribute('aria-invalid'), 'true');
        equal(ui.document.activeElement, ui.get('targetAccount')); equal(ui.env.readCalls.length, reads);
        equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 0);
    });
}

test('source account validation happens before review and does not rely on a session account value', async () => {
    const ui = boot(); await settle(); fill(ui); ui.get('sourceAccount').value = 'invalid source';
    ui.get('transferForm').fire('submit');
    equal(ui.get('sourceAccount').getAttribute('aria-invalid'), 'true');
    assert(!ui.get('sourceAccountError').hidden); equal(ui.env.uuidCount, 0);
});

test('a snapshot balance warns without pretending to know current available funds', async () => {
    const ui = bootWithAccount(); await settle(); fill(ui, '1000');
    ui.get('transferForm').fire('submit');
    assert(ui.get('transferReview').open); assert(!ui.get('transferBalanceWarning').hidden);
    equal(ui.env.calls.length, 0);
    ui.env.respond = async call => { const id = JSON.parse(call.body).transfer_request_id;
        return { ...admission(id, null, 'INSUFFICIENT_FUNDS'), status: 422, ok: false }; };
    ui.get('confirmTransfer').fire('click'); await settle();
    equal(ui.get('transferLifecycle').textContent, 'Request rejected');
    assert(ui.get('transferStatus').textContent.includes('insufficient'));
});

for (const result of ['network', 'timeout', '400', '403', '500', '503', '504', 'malformed']) {
    test(`${result} response keeps a saved transfer without false success, failure or automatic retries`, async () => {
        const ui = boot(); await settle(); fill(ui);
        ui.env.respond = async () => {
            if (result === 'network' || result === 'timeout') throw new Error('Synthetic interruption');
            if (result === 'malformed') return { status: 200, ok: true, json: async () => { throw new Error('Malformed JSON'); } };
            return reply(Number(result), { status: 'FAILED' });
        };
        confirmSubmission(ui); await settle();
        equal(ui.env.calls.length, 1); equal(ui.env.uuidCount, 1);
        assert(!/Completed|Reported failed|Request rejected/.test(ui.get('transferLifecycle').textContent));
        assert(ui.get('transferStatus').textContent.includes('not confirmed'));
        const record = JSON.parse([...ui.env.storage.values()][0]).intents[0]; equal(record.outcome, 'UNRESOLVED');
        ui.navigate('#transactions'); ui.navigate('#transfers'); await settle(); equal(ui.env.calls.length, 1);
    });
}

test('a known persistence outage is unavailable with an unconfirmed financial outcome', async () => {
    const ui = boot(); await settle(); fill(ui);
    ui.env.respond = async () => reply(503, { code: 'TRANSFER_PERSISTENCE_UNAVAILABLE' });
    confirmSubmission(ui); await settle();
    assert(ui.get('transferLifecycle').textContent.includes('Temporarily unavailable'));
    assert(ui.get('transferStatus').textContent.includes('not confirmed')); equal(ui.env.calls.length, 1);
});

test('Account formats Italian IBAN components while preserving the original clipboard and Dashboard', async () => {
    const ui = bootWithAccount(); const iban = 'IT60X0542811101000000123456';
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, []) : reply(200, { ...accountFixture(), iban });
    await settle();
    const summary = ui.get('onboardingTarget');
    assert(summary.textContent.includes('IT 60 X 05428 11101 000000123456'));
    const description = summary.children[1].children[1].children[1];
    assert(description.getAttribute('aria-label').includes('CIN: X, ABI: 05428, CAB: 11101, Account number: 000000123456'));
    assert(summary.textContent.includes('updated snapshot'));
    assert(ui.get('dashboardAccountSummary').textContent.includes('IBAN IT60 … 3456'));
    ui.get('copyIban').fire('click'); await settle(); equal(ui.env.clipboardWrites, [iban]);
});

test('History empty transfer action appears only after a successful empty list for a loaded account', async () => {
    const ui = boot(); await settle(); assert(ui.get('historyTransferLink').hidden);
    const owned = bootWithAccount(); await settle();
    equal(owned.get('historyTableBody').textContent, 'No transactions found for this account.');
    assert(!owned.get('historyTransferLink').hidden); equal(owned.get('historyTransferLink').getAttribute('href'), '#transfers');
    owned.env.respondAccount = async () => reply(503, {}); owned.tick(); await settle();
    assert(!owned.get('historyNotice').hidden); assert(owned.get('historyTransferLink').hidden);
    owned.env.respondAccount = async () => reply(200, []); owned.tick(); await settle();
    assert(owned.get('historyNotice').hidden); assert(!owned.get('historyTransferLink').hidden);
    owned.get('logoutBtn').fire('click'); await settle(); assert(owned.get('historyTransferLink').hidden);
});

test('History preserves server order and supported fields, with a separate notice when refresh fails', async () => {
    const ui = bootWithAccount();
    const rows = [{ transaction_id: 'TX-NEW', target_iban: recipientIban, amount: 12.30, status: 'PENDING', timestamp: '2026-11-24 12:30:00' },
        { transaction_id: 'TX-OLD', target_iban: recipientIban, amount: 1, status: 'APPROVED', timestamp: '2026-11-23 12:30:00' }];
    ui.env.respondAccount = async url => url.includes('/transactions') ? reply(200, rows) : reply(200, accountFixture());
    await settle();
    const table = ui.get('historyTableBody'); equal(table.children.length, 2);
    assert(table.children[0].textContent.includes('TX-NEW')); assert(table.children[1].textContent.includes('TX-OLD'));
    assert(table.children[0].textContent.includes('DE89 3704 0044 0532 0130 00'));
    assert(table.children[0].textContent.includes('€12.30')); assert(table.children[0].textContent.includes('24 Nov 2026, 12:30'));
    const snapshot = table.textContent;
    ui.env.respondAccount = async () => reply(500, {}); ui.tick(); await settle();
    equal(table.textContent, snapshot); assert(!ui.get('historyNotice').hidden); assert(ui.get('historyTransferLink').hidden);
    ui.env.respondAccount = async () => reply(200, rows); ui.tick(); await settle(); assert(ui.get('historyNotice').hidden);
    equal(ui.intervals.size, 1);
});

test('legacy saved destination values remain safely visible and recoverable without creating a replacement intent', async () => {
    let ui = boot(); await settle();
    const hostile = '<svg/onload=alert(1)>';
    const requests = new TransferRequests({ storage: ui.window.sessionStorage, crypto: ui.window.crypto,
        fetch: async () => { throw new Error('No implicit request allowed'); },
        getClaims: () => ui.env.claims, getToken: async () => 'synthetic-test-token' });
    const intent = requests.create({ source_account: 'ACC-A', target_account: hostile, amount: '12.30' });
    ui = boot(ui.env); await settle();
    assert(ui.get('transferDetails').textContent.includes(hostile)); assertNoHTMLParsing(ui.get('transferDetails'));
    equal(ui.env.calls.length, 0); equal(ui.env.uuidCount, 1);
    ui.env.respond = async () => admission(intent.transfer_request_id, 'PENDING');
    ui.get('checkTransfer').fire('click'); await settle();
    equal(ui.env.calls.length, 1); equal(ui.env.calls[0].method, 'GET');
    equal(ui.env.uuidCount, 1); assert(ui.get('transferStatus').textContent.includes('PENDING'));
});

test('a malformed history response is an error and cannot replace the last valid rows or affect Dashboard state', async () => {
    const ui = bootWithAccount(); await settle();
    ui.env.respondAccount = async () => reply(200, { unexpected: 'response' });
    ui.tick(); await settle();
    assert(!ui.get('historyNotice').hidden);
    equal(ui.get('historyTableBody').textContent, 'No transactions found for this account.');
    assert(ui.get('recentTransactionsStatus').textContent.includes('No recent transactions yet.'));
    assert(ui.get('historyTransferLink').hidden);
});

let failed = 0;
for (const { name, run } of tests) {
    try { await run(); print('PASS ' + name); }
    catch (error) { failed++; print('FAIL ' + name + ': ' + error.message); }
}
print(`${tests.length - failed}/${tests.length} UI wiring tests passed`);
if (failed) throw new Error(`${failed} UI wiring tests failed`);
