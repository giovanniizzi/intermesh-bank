// Run with: jsc -m intermesh-ui/tests/transfer-requests.test.js
import { TransferRequests, exactAmount, transferBody, describeIntent, REJECTION_MESSAGES, userScope } from '../src/js/transfer-requests.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
function equal(a, b) { assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(run) { let caught = false; try { run(); } catch { caught = true; } assert(caught, 'Expected rejection'); }
const values = () => ({ source_account: 'ACC-A', target_account: 'ACC-B', amount: '12.30' });
const reply = (status, body) => ({ status, json: async () => body });
const committed = () => reply(200, { ledgerTransferResponseDTO: { status: 'COMMITTED', transaction_id: 'TX-IM-synthetic' } });
function state(id, outcome = 'PENDING', kind = 'RECOVERED', approval = false) {
    return { status: kind, transfer_request_id: id, admission_status: 'ADMITTED',
        transaction_id: 'TX-IM-synthetic', transaction_state: outcome,
        new_transaction_created: kind === 'FROZEN', duplicate_pending_approved: approval, matching_pending_count: 1 };
}
function rejected(id, code, recovery = false) {
    return reply(recovery ? 200 : code === 'INSUFFICIENT_FUNDS' ? 422 : 409,
        { status: recovery ? 'RECOVERED' : 'REJECTED', transfer_request_id: id, admission_status: 'REJECTED',
            rejection_code: code, transaction_id: null, transaction_state: null,
            new_transaction_created: false, duplicate_pending_approved: false, matching_pending_count: 1 });
}
function fixture() {
    const memory = new Map();
    const env = { claims: { iss: 'https://keycloak.example.invalid/realms/intermesh-bank', sub: 'synthetic-a' },
        calls: [], notifications: 0, uuidCount: 0, failSave: false,
        respond: async () => committed(), token: async () => 'synthetic-test-token' };
    env.storage = {
        getItem: key => memory.get(key) ?? null,
        setItem(key, value) { if (env.failSave) throw new Error('Synthetic quota failure'); memory.set(key, value); }
    };
    env.options = { storage: env.storage,
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++env.uuidCount).padStart(12, '0')}` },
        getClaims: () => env.claims, getToken: () => env.token(),
        fetch: async (url, options) => { env.calls.push({ url, ...options }); return env.respond(url, options); },
        onChange: () => env.notifications++ };
    env.open = () => new TransferRequests(env.options);
    env.client = env.open();
    env.memory = memory;
    return env;
}

test('exact decimal normalization and numeric wire representation preserve FIN-04 limits', () => {
    for (const [input, output] of [['1', '1.00'], ['12.3', '12.30'], ['12.3000', '12.30'], ['0.01', '0.01'],
        ['1e0', '1.00'], ['123e-1', '12.30'], ['100e-4', '0.01'], ['9999999999999.99', '9999999999999.99']]) {
        equal(exactAmount(input), output);
        const env = fixture();
        const intent = env.client.create({ ...values(), amount: input });
        assert(transferBody(intent).includes('"amount":' + output + '}'));
        assert(!transferBody(intent).includes('"amount":"'));
        equal(env.client.active.amount, output);
    }
    for (const input of ['', '0', '0.00', '-0', '-1', '-0.01', '12.345', '1.00000000000000001',
        '9999999999999.9901', '10000000000000', '1e-3', '1e13', '1e1025', '1e-1025', 'NaN', 'Infinity',
        '"12.30"', 'true', 'null', '01', '.1', '1.', ' 1', '1 ', '1'.repeat(257), null, true, 12.3]) {
        throws(() => exactAmount(input));
    }
});

test('intent is durable before POST; only actual Java fields and bearer authorization are sent', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    env.respond = async () => {
        const stored = JSON.parse(env.storage.getItem(env.client.key));
        equal(stored.intents[0].transfer_request_id, intent.transfer_request_id);
        return committed();
    };
    await env.client.send(intent.transfer_request_id);
    equal(env.uuidCount, 1);
    equal(env.calls.length, 1);
    equal(Object.keys(JSON.parse(env.calls[0].body)).sort(), ['allowDuplicatePendingTransfer', 'amount', 'source_account', 'target_account', 'transfer_request_id'].sort());
    equal(env.calls[0].redirect, 'error');
    equal(env.calls[0].headers, { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/json' });
    assert(!env.storage.getItem(env.client.key).includes('synthetic-test-token'));
    equal(env.client.active.outcome, 'APPROVED');
});

test('double-clicks cannot allocate another intent or issue concurrent POSTs', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    let finish;
    env.respond = () => new Promise(resolve => { finish = resolve; });
    const first = env.client.send(intent.transfer_request_id);
    const second = env.client.send(intent.transfer_request_id);
    throws(() => env.client.create(values()));
    await Promise.resolve();
    equal(env.calls.length, 1);
    equal(await second, false);
    finish(committed());
    await first;
    equal(env.uuidCount, 1);
});

test('lost response survives refresh and manual replay retains the exact original body', async () => {
    const env = fixture();
    const input = { ...values(), amount: '9999999999999.99' };
    const intent = env.client.create(input);
    env.respond = async () => { throw new Error('Synthetic lost response'); };
    await env.client.send(intent.transfer_request_id);
    equal(env.calls.length, 1);
    equal(env.client.active.outcome, 'UNRESOLVED');
    const firstBody = env.calls[0].body;
    env.client = env.open();
    equal(env.client.active.transfer_request_id, intent.transfer_request_id);
    input.amount = '1';
    const external = env.client.active;
    external.amount = '2.00';
    env.respond = async () => reply(200, state(intent.transfer_request_id, 'PENDING', 'REPLAYED'));
    await env.client.send(intent.transfer_request_id);
    equal(env.calls[1].body, firstBody);
    equal(env.uuidCount, 1);
    equal(env.client.active.outcome, 'PENDING');
    assert(describeIntent(env.client.active).includes('not completed'));
});

test('status recovery sends only GET and a 404 never erases an unresolved intent', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    env.respond = async () => reply(404, { code: 'TRANSFER_REQUEST_NOT_FOUND' });
    await env.client.recover(intent.transfer_request_id);
    equal(env.calls.map(call => call.method), ['GET']);
    equal(env.calls[0].url, '/api/v1/transfer-requests/' + intent.transfer_request_id);
    equal(env.calls[0].cache, 'no-store');
    assert(!('body' in env.calls[0]));
    equal(env.client.active.outcome, 'UNRESOLVED');
    assert(describeIntent(env.client.active).includes('may still complete'));
    env.client = env.open();
    for (const outcome of ['PENDING', 'APPROVED', 'FAILED']) {
        env.respond = async () => reply(200, state(intent.transfer_request_id, outcome));
        await env.client.recover(intent.transfer_request_id);
        equal(env.client.active.outcome, outcome);
    }
    assert(env.calls.every(call => call.method === 'GET'));
});

test('top-level workflow FAILED, invalid JSON and unknown commit outcomes stay uncertain', async () => {
    for (const response of [reply(504, { status: 'FAILED', reason: 'Unfreeze acknowledged' }),
        reply(503, { code: 'COMMIT_OUTCOME_UNKNOWN' }), reply(503, { code: 'TRANSFER_PERSISTENCE_UNAVAILABLE' }),
        reply(200, {}), { status: 200, json: async () => { throw new Error('Malformed JSON'); } }]) {
        const env = fixture();
        const intent = env.client.create(values());
        env.respond = async () => response;
        await env.client.send(intent.transfer_request_id);
        equal(env.calls.length, 1);
        equal(env.client.active.outcome, 'UNRESOLVED');
        equal(env.uuidCount, 1);
        assert(env.storage.getItem(env.client.key));
    }
});

test('duplicate approval requires persisted rejection and creates one linked UUID with unchanged values', async () => {
    const env = fixture();
    const ordinary = env.client.create(values());
    throws(() => env.client.approveDuplicate(ordinary.transfer_request_id));
    env.respond = async () => rejected(ordinary.transfer_request_id, 'DUPLICATE_APPROVAL_REQUIRED');
    await env.client.send(ordinary.transfer_request_id);
    equal(env.calls.length, 1); // A rejection never auto-submits a duplicate.
    equal(env.uuidCount, 1);
    const approved = env.client.approveDuplicate(ordinary.transfer_request_id);
    assert(approved.transfer_request_id !== ordinary.transfer_request_id);
    equal(approved.source_account, ordinary.source_account);
    equal(approved.target_account, ordinary.target_account);
    equal(approved.amount, ordinary.amount);
    equal(approved.allowDuplicatePendingTransfer, true);
    equal(env.calls.length, 1); // Confirmation creation itself does not send.
    const stored = JSON.parse(env.storage.getItem(env.client.key));
    equal(stored.intents[0].confirmation_request_id, approved.transfer_request_id);
    equal(stored.intents[0].outcome, 'REJECTED');
    env.respond = async () => rejected(approved.transfer_request_id, 'DUPLICATE_EXCEPTION_USED');
    await env.client.send(approved.transfer_request_id);
    equal(JSON.parse(env.calls[1].body).allowDuplicatePendingTransfer, true);
    equal(env.client.active.rejection_code, 'DUPLICATE_EXCEPTION_USED');
    env.client = env.open();
    const same = env.client.approveDuplicate(ordinary.transfer_request_id);
    equal(same.transfer_request_id, approved.transfer_request_id);
    equal(env.uuidCount, 2);
    throws(() => env.client.approveDuplicate(approved.transfer_request_id));
});

test('every persisted rejection code is mapped without trusting free-form reason text', async () => {
    for (const code of Object.keys(REJECTION_MESSAGES)) {
        const env = fixture();
        const intent = env.client.create(values());
        env.respond = async () => rejected(intent.transfer_request_id, code);
        await env.client.send(intent.transfer_request_id);
        equal(env.client.active.outcome, 'REJECTED');
        assert(describeIntent(env.client.active).includes(REJECTION_MESSAGES[code]));
        env.client = env.open();
        env.respond = async () => rejected(intent.transfer_request_id, code, true);
        await env.client.recover(intent.transfer_request_id);
        equal(env.client.active.rejection_code, code);
        equal(env.calls.length, 2);
    }
});

test('intent conflict is not a financial rejection and never changes the saved request', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    env.respond = async () => reply(409, { code: 'REQUEST_INTENT_CONFLICT' });
    await env.client.send(intent.transfer_request_id);
    equal(env.client.active.outcome, 'UNRESOLVED');
    equal(env.client.active.notice, 'REQUEST_INTENT_CONFLICT');
    equal(env.client.active.amount, intent.amount);
    equal(env.uuidCount, 1);
});

test('unrelated, malformed or incoherent admission metadata is never treated as success', async () => {
    const changes = [{ transfer_request_id: '00000000-0000-4000-8000-999999999999' },
        { new_transaction_created: 'false' }, { transaction_state: 'COMMITTED' }, { transaction_id: null },
        { matching_pending_count: -1 }, { duplicate_pending_approved: 'false' },
        { status: 'RECOVERED' }, { new_transaction_created: true }];
    for (const change of changes) {
        const env = fixture();
        const intent = env.client.create(values());
        env.respond = async () => reply(200, { ...state(intent.transfer_request_id, 'PENDING', 'REPLAYED'), ...change });
        await env.client.send(intent.transfer_request_id);
        equal(env.client.active.outcome, 'UNRESOLVED');
        equal(env.calls.length, 1);
    }
});

test('logout and issuer/subject changes hide previous intents without deleting them', async () => {
    const env = fixture();
    const original = env.client.create(values());
    const old = env.client;
    env.claims = { ...env.claims, sub: 'synthetic-b' };
    const other = env.open();
    equal(other.intents.length, 0);
    throws(() => old.create(values()));
    await old.send(original.transfer_request_id).then(() => { throw new Error('Expected identity rejection'); }, () => {});
    equal(env.calls.length, 0);
    env.claims = { ...env.claims, sub: 'synthetic-a', iss: 'https://other.example.invalid/realms/intermesh-bank' };
    equal(env.open().intents.length, 0);
    env.claims = { iss: 'https://keycloak.example.invalid/realms/intermesh-bank', sub: 'synthetic-a' };
    env.client = env.open();
    equal(env.client.active.transfer_request_id, original.transfer_request_id);
    env.client.detach();
    assert(!env.client.isCurrent());
    equal(env.open().intents.length, 1);
    assert(![...env.memory.values()].join('').includes('synthetic-test-token'));
    equal(userScope(env.claims), JSON.stringify([env.claims.iss, env.claims.sub]));
});

test('identity changes during token refresh prevent the POST', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    let refresh;
    env.token = () => new Promise(resolve => { refresh = resolve; });
    const pending = env.client.send(intent.transfer_request_id);
    env.claims = { ...env.claims, sub: 'synthetic-b' };
    refresh('synthetic-test-token');
    await pending;
    equal(env.calls.length, 0);
    equal(JSON.parse(env.storage.getItem(env.client.key)).intents[0].outcome, 'UNRESOLVED');
});

test('late responses after logout cannot update another user view or erase old uncertainty', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    let finish;
    env.respond = () => new Promise(resolve => { finish = resolve; });
    const pending = env.client.send(intent.transfer_request_id);
    await Promise.resolve();
    env.client.detach();
    env.claims = { ...env.claims, sub: 'synthetic-b' };
    const notifications = env.notifications;
    finish(committed());
    await pending;
    equal(env.notifications, notifications);
    equal(env.open().intents.length, 0);
    equal(JSON.parse(env.storage.getItem(env.client.key)).intents[0].outcome, 'UNRESOLVED');
});

test('storage failure blocks POST and corrupted data is never overwritten', async () => {
    const env = fixture();
    env.failSave = true;
    throws(() => env.client.create(values()));
    equal(env.calls.length, 0);
    await env.client.send(env.client.active.transfer_request_id).then(() => { throw new Error('Expected storage rejection'); }, () => {});
    equal(env.calls.length, 0);
    env.failSave = false;
    env.storage.setItem(env.client.key, '{broken');
    throws(() => env.open());
    equal(env.storage.getItem(env.client.key), '{broken');
});

test('secure UUID availability is required for creation but not for recovery', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    env.options.crypto = {};
    const refreshed = env.open();
    env.respond = async () => reply(200, state(intent.transfer_request_id));
    await refreshed.recover(intent.transfer_request_id);
    equal(refreshed.active.outcome, 'PENDING');
    refreshed.startNew();
    throws(() => refreshed.create(values()));
    equal(env.calls.length, 1);
});

test('an explicit new intention retains prior records and uses a new UUID', async () => {
    const env = fixture();
    const a = env.client.create(values());
    env.client.startNew();
    const b = env.client.create(values());
    assert(a.transfer_request_id !== b.transfer_request_id);
    equal(env.client.intents.length, 2);
    equal(env.client.intents[0].outcome, 'UNRESOLVED');
    equal(env.calls.length, 0);
});

test('terminal outcomes prevent manual POST while read-only recovery remains available', async () => {
    for (const outcome of ['APPROVED', 'FAILED', 'REJECTED']) {
        const env = fixture();
        const intent = env.client.create(values());
        env.respond = async () => outcome === 'REJECTED' ? rejected(intent.transfer_request_id, 'INSUFFICIENT_FUNDS', true)
            : reply(200, state(intent.transfer_request_id, outcome));
        await env.client.recover(intent.transfer_request_id);
        await env.client.send(intent.transfer_request_id).then(() => { throw new Error('Expected terminal rejection'); }, () => {});
        equal(env.calls.map(call => call.method), ['GET']);
        equal(env.open().intents[0].outcome, outcome);
    }
});

test('a finished approved duplicate never opens another exception for the same rejected request', async () => {
    const env = fixture();
    const ordinary = env.client.create(values());
    env.respond = async () => rejected(ordinary.transfer_request_id, 'DUPLICATE_APPROVAL_REQUIRED');
    await env.client.send(ordinary.transfer_request_id);
    const approved = env.client.approveDuplicate(ordinary.transfer_request_id);
    env.respond = async () => committed();
    await env.client.send(approved.transfer_request_id);
    equal(env.client.active.outcome, 'APPROVED');
    const previous = env.client.approveDuplicate(ordinary.transfer_request_id);
    equal(previous.transfer_request_id, approved.transfer_request_id);
    equal(env.uuidCount, 2);
    await env.client.send(previous.transfer_request_id).then(() => { throw new Error('Expected terminal rejection'); }, () => {});
    equal(env.calls.length, 2);
});

test('a failed status check preserves a previously reported financial outcome', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    await env.client.send(intent.transfer_request_id);
    env.respond = async () => { throw new Error('Lost recovery response'); };
    await env.client.recover(intent.transfer_request_id);
    equal(env.client.active.outcome, 'APPROVED');
    equal(env.open().active.outcome, 'APPROVED');
    assert(describeIntent(env.client.active).includes('latest response was unavailable'));
    equal(env.calls.map(call => call.method), ['POST', 'GET']);
});

test('failure to persist a result retains the saved UUID and blocks further POSTs', async () => {
    const env = fixture();
    const intent = env.client.create(values());
    env.respond = async () => { env.failSave = true; return committed(); };
    await env.client.send(intent.transfer_request_id);
    equal(env.client.active.notice, 'STORAGE_ERROR');
    equal(JSON.parse(env.storage.getItem(env.client.key)).intents[0].outcome, 'UNRESOLVED');
    equal(env.calls.length, 1);
    await env.client.send(intent.transfer_request_id).then(() => { throw new Error('Expected blocked POST'); }, () => {});
    env.failSave = false;
    const refreshed = env.open();
    equal(refreshed.active.transfer_request_id, intent.transfer_request_id);
    equal(refreshed.active.outcome, 'UNRESOLVED');
});

let failed = 0;
for (const { name, run } of tests) {
    try { await run(); print('PASS ' + name); }
    catch (error) { failed++; print('FAIL ' + name + ': ' + error.message); }
}
print(`${tests.length - failed}/${tests.length} tests passed`);
if (failed) throw new Error(`${failed} frontend tests failed`);
