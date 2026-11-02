// Dependency-free UI wiring tests. Run from the repository root with jsc -m.
import { TransferRequests, describeIntent, userScope } from '../src/js/transfer-requests.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
function equal(a, b) { assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const commit = () => reply(200, { ledgerTransferResponseDTO: { status: 'COMMITTED', transaction_id: 'TX-synthetic' } });
function admission(id, state, code) {
    return reply(code ? 409 : 200, { status: code ? 'REJECTED' : 'RECOVERED', transfer_request_id: id,
        admission_status: code ? 'REJECTED' : 'ADMITTED', rejection_code: code || null,
        transaction_id: code ? null : 'TX-synthetic', transaction_state: code ? null : state,
        new_transaction_created: false, duplicate_pending_approved: false, matching_pending_count: 1 });
}
class Element {
    constructor() {
        this.value = ''; this.textContent = ''; this.innerHTML = ''; this.children = [];
        this.disabled = false; this.hidden = false; this.listeners = {};
        this.classes = new Set();
        this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    }
    replaceChildren() { this.children = []; }
    append(child) { this.children.push(child); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    fire(type) { if (!this.disabled || type === 'submit') return this.listeners[type]?.({ target: this, preventDefault() {} }); }
}
function boot(shared = null) {
    const env = shared || { storage: new Map(), calls: [], uuidCount: 0, confirmations: [], confirm: false,
        respond: async () => commit(), claims: { iss: 'https://keycloak.example.invalid/realms/intermesh-bank',
            sub: 'synthetic-a', preferred_username: 'synthetic-owner' } };
    const html = readFile('intermesh-ui/src/index.html');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
    for (const selector of ['.user-name', '.user-role', '.avatar']) elements.set(selector, new Element());
    const document = {
        getElementById(id) { assert(elements.has(id), 'Missing HTML element ' + id); return elements.get(id); },
        querySelector: selector => elements.get(selector), createElement: () => new Element(),
        visibilityState: 'visible', addEventListener() {}, removeEventListener() {}
    };
    const window = { location: { origin: 'https://bank-network1.example.invalid', reload() {} },
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++env.uuidCount).padStart(12, '0')}` },
        sessionStorage: { getItem: key => env.storage.get(key) ?? null, setItem: (key, value) => env.storage.set(key, value) },
        confirm: text => { env.confirmations.push(text); return env.confirm; } };
    class Keycloak {
        constructor() { this.authenticated = true; this.tokenParsed = env.claims; this.token = 'synthetic-test-token'; env.keycloak = this; }
        async init(options) { equal(options.pkceMethod, 'S256'); return true; }
        async updateToken() { return false; }
        logout() { this.authenticated = false; this.onAuthLogout?.(); return Promise.resolve(); }
    }
    const fetch = async (url, options = {}) => {
        if (!url.includes('/transfers') && !url.includes('/transfer-requests/')) return reply(404, {});
        const call = { url, ...options }; env.calls.push(call); return env.respond(call);
    };
    const source = '"use strict";\n' + readFile('intermesh-ui/src/js/app.js').replace(/^import .*;$/gm, '');
    const run = new Function('Keycloak', 'TransferRequests', 'describeIntent', 'userScope', 'window', 'document',
        'fetch', 'console', 'alert', 'setInterval', 'clearInterval', 'setTimeout', source);
    run(Keycloak, TransferRequests, describeIntent, userScope, window, document, fetch,
        { log() {}, error() {} }, message => { throw new Error(message); }, () => 1, () => {}, () => {});
    return { env, elements, get: id => elements.get(id), window, html };
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

let failed = 0;
for (const { name, run } of tests) {
    try { await run(); print('PASS ' + name); }
    catch (error) { failed++; print('FAIL ' + name + ': ' + error.message); }
}
print(`${tests.length - failed}/${tests.length} UI wiring tests passed`);
if (failed) throw new Error(`${failed} UI wiring tests failed`);
