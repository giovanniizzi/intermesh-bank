const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(['UNRESOLVED', 'PENDING', 'APPROVED', 'FAILED', 'REJECTED']);
export const REJECTION_MESSAGES = Object.freeze({
    DUPLICATE_APPROVAL_REQUIRED: 'An identical transfer is already pending. A separate duplicate requires explicit confirmation.',
    DUPLICATE_APPROVAL_NOT_ELIGIBLE: 'Duplicate approval is not eligible for this transfer. Check the pending transfers before starting another intent.',
    DUPLICATE_EXCEPTION_USED: 'The duplicate exception for this pending cycle has already been used, even if the approved duplicate has finished.',
    ACTIVE_CYCLE_BLOCKED: 'An active transfer cycle blocks another identical transfer.',
    ACTIVE_CYCLE_CONFLICT: 'The active transfer cycle conflicts with this request.',
    INSUFFICIENT_FUNDS: 'The transfer was rejected because available funds were insufficient.'
});
const ERROR_MESSAGES = Object.freeze({
    REQUEST_INTENT_CONFLICT: 'This UUID is registered with different transfer parameters. Keep the original intent and check its status.',
    TRANSFER_REQUEST_NOT_FOUND: 'Not found or inaccessible at this snapshot. An earlier in-flight POST may still complete; keep this UUID.',
    COMMIT_OUTCOME_UNKNOWN: 'The admission outcome is unknown. Check status using this UUID.',
    TRANSFER_PERSISTENCE_UNAVAILABLE: 'Transfer persistence is unavailable. The financial outcome is not confirmed.'
});

export function userScope(claims) {
    if (!claims || !['iss', 'sub'].every(key => typeof claims[key] === 'string' && claims[key].trim())) {
        throw new Error('An authenticated user is required.');
    }
    return JSON.stringify([claims.iss, claims.sub]);
}

// Keep decimal digits intact; Number/parseFloat would round some valid amounts.
export function exactAmount(raw) {
    if (typeof raw !== 'string' || raw.length > 256) throw new Error('Enter a positive amount with at most two decimal places.');
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);
    if (!match) throw new Error('Enter a positive numeric amount.');
    const exponent = Number(match[3] || '0');
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 1024) throw new Error('Amount exponent is out of range.');
    let cents = (match[1] + (match[2] || '')).replace(/^0+/, '') || '0';
    const shift = exponent - (match[2] || '').length + 2;
    if (shift >= 0) {
        cents += '0'.repeat(shift);
    } else {
        const end = cents.length + shift;
        if (end <= 0 || /[1-9]/.test(cents.slice(end))) throw new Error('Amount must have at most two decimal places.');
        cents = cents.slice(0, end);
    }
    cents = cents.replace(/^0+/, '') || '0';
    if (cents === '0' || cents.length > 15 || (cents.length === 15 && cents > '999999999999999')) {
        throw new Error('Amount must be positive and no greater than 9999999999999.99.');
    }
    cents = cents.padStart(3, '0');
    return cents.slice(0, -2) + '.' + cents.slice(-2);
}

function accountText(value, maximum, source = false) {
    return typeof value === 'string' && value.trim() !== '' && [...value].length <= maximum
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && (!source || !/\s/.test(value));
}

function validTransactionId(value) {
    return accountText(value, 50, true);
}

export function transferBody(intent) {
    if (exactAmount(intent.amount) !== intent.amount) throw new Error('Invalid saved amount.');
    const fields = JSON.stringify({
        transfer_request_id: intent.transfer_request_id,
        source_account: intent.source_account,
        target_account: intent.target_account,
        allowDuplicatePendingTransfer: intent.allowDuplicatePendingTransfer
    });
    return fields.slice(0, -1) + ',"amount":' + intent.amount + '}';
}

function resultFor(status, body, intent, recovery) {
    const unknown = { notice: 'UNCONFIRMED' };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return unknown;
    if (!recovery && status === 200 && body.ledgerTransferResponseDTO?.status === 'COMMITTED'
            && validTransactionId(body.ledgerTransferResponseDTO.transaction_id)) {
        return { outcome: 'APPROVED', notice: '', transaction_id: body.ledgerTransferResponseDTO.transaction_id };
    }
    if (body.transfer_request_id?.toLowerCase?.() === intent.transfer_request_id.toLowerCase()
            && typeof body.new_transaction_created === 'boolean'
            && typeof body.duplicate_pending_approved === 'boolean'
            && Number.isSafeInteger(body.matching_pending_count) && body.matching_pending_count >= 0) {
        const envelope = recovery ? status === 200 && body.status === 'RECOVERED' && !body.new_transaction_created
            : (body.status === 'REPLAYED' && !body.new_transaction_created)
                || (body.status === 'FROZEN' && body.new_transaction_created && body.transaction_state === 'PENDING');
        if (body.admission_status === 'ADMITTED' && status === 200 && envelope
                && ['PENDING', 'APPROVED', 'FAILED'].includes(body.transaction_state)
                && validTransactionId(body.transaction_id) && body.rejection_code == null
                && (recovery || body.duplicate_pending_approved === intent.allowDuplicatePendingTransfer)) {
            return { outcome: body.transaction_state, notice: '', transaction_id: body.transaction_id };
        }
        const rejectionStatus = recovery ? envelope
            : body.status === 'REJECTED' && status === (body.rejection_code === 'INSUFFICIENT_FUNDS' ? 422 : 409);
        if (body.admission_status === 'REJECTED' && rejectionStatus && !body.new_transaction_created
                && !body.duplicate_pending_approved && body.transaction_id === null && body.transaction_state === null
                && Object.hasOwn(REJECTION_MESSAGES, body.rejection_code)) {
            return { outcome: 'REJECTED', notice: '', rejection_code: body.rejection_code, transaction_id: null };
        }
    }
    if (Object.hasOwn(ERROR_MESSAGES, body.code)) {
        const expected = { REQUEST_INTENT_CONFLICT: 409, TRANSFER_REQUEST_NOT_FOUND: 404,
            COMMIT_OUTCOME_UNKNOWN: 503, TRANSFER_PERSISTENCE_UNAVAILABLE: 503 };
        if (status === expected[body.code]) return { notice: body.code };
    }
    if (recovery && status === 404) return { notice: 'TRANSFER_REQUEST_NOT_FOUND' };
    if (status === 401 || status === 403) return { notice: 'AUTH_REQUIRED' };
    // Orchestrator's top-level FAILED describes workflow failure, not persisted financial state.
    return unknown;
}

export function describeIntent(intent) {
    const outcome = {
        UNRESOLVED: 'Financial outcome is not confirmed. Check status before replacing this request.',
        PENDING: 'Admitted and PENDING. This transfer is not completed.',
        APPROVED: 'Ledger reported APPROVED.',
        FAILED: 'Ledger reported FAILED.',
        REJECTED: 'Admission rejected; this request has no financial transaction. '
            + (REJECTION_MESSAGES[intent.rejection_code] || '')
    }[intent.outcome];
    const notice = ERROR_MESSAGES[intent.notice] || ({
        UNCONFIRMED: 'The latest response was unavailable or unusable. Keep this UUID and check status.',
        AUTH_REQUIRED: 'Authentication or session authorization failed. Check status again as the original user; reauthenticate if needed.',
        STORAGE_ERROR: 'The latest result could not be saved. Keep this tab open and check status.'
    }[intent.notice] || '');
    return outcome + (notice ? ' ' + notice : '');
}

export class TransferRequests {
    constructor({ storage, crypto, fetch, getClaims, getToken, onChange = () => {} }) {
        this.storage = storage;
        this.crypto = crypto;
        this.fetch = fetch;
        this.getClaims = getClaims;
        this.getToken = getToken;
        this.onChange = onChange;
        this.scope = userScope(getClaims());
        this.key = 'intermesh.transfer-intents.v1:' + this.scope;
        this.busy = false;
        this.detached = false;
        this.storageFailed = false;
        this.data = { version: 1, activeId: null, intents: [] };
        const saved = storage.getItem(this.key);
        if (saved !== null) {
            const data = JSON.parse(saved);
            if (data?.version !== 1 || !Array.isArray(data.intents)
                    || !(data.activeId === null || typeof data.activeId === 'string')) throw new Error('Saved transfer data is unreadable; preserve sessionStorage for recovery.');
            const ids = new Set();
            for (const intent of data.intents) {
                if (!this.validSavedIntent(intent) || ids.has(intent.transfer_request_id)) throw new Error('Saved transfer data is unreadable; preserve sessionStorage for recovery.');
                ids.add(intent.transfer_request_id);
            }
            if (data.activeId !== null && !ids.has(data.activeId)) throw new Error('Saved transfer selection is invalid.');
            this.data = data;
        }
    }

    validSavedIntent(intent) {
        try {
            const fields = ['transfer_request_id', 'source_account', 'target_account', 'amount',
                'allowDuplicatePendingTransfer', 'outcome', 'notice', 'transaction_id', 'rejection_code',
                'created_at', 'confirmation_request_id'];
            return intent && Object.keys(intent).every(key => fields.includes(key)) && UUID.test(intent.transfer_request_id)
                && accountText(intent.source_account, 50, true) && accountText(intent.target_account, 34)
                && typeof intent.allowDuplicatePendingTransfer === 'boolean' && exactAmount(intent.amount) === intent.amount
                && OUTCOMES.has(intent.outcome) && typeof intent.notice === 'string'
                && (intent.transaction_id === null || validTransactionId(intent.transaction_id))
                && (intent.rejection_code === null || Object.hasOwn(REJECTION_MESSAGES, intent.rejection_code))
                && (intent.outcome !== 'REJECTED' || Object.hasOwn(REJECTION_MESSAGES, intent.rejection_code))
                && typeof intent.created_at === 'string' && !Number.isNaN(Date.parse(intent.created_at))
                && (intent.confirmation_request_id === null || UUID.test(intent.confirmation_request_id));
        } catch { return false; }
    }

    isCurrent() {
        try { return !this.detached && this.scope === userScope(this.getClaims()); } catch { return false; }
    }
    assertCurrent() {
        if (!this.isCurrent()) throw new Error('User changed. Sign in as the original user to recover this request.');
    }
    notify() { if (this.isCurrent()) this.onChange(); }
    get active() {
        const intent = this.data.intents.find(item => item.transfer_request_id === this.data.activeId);
        return intent ? { ...intent } : null;
    }
    get intents() { return this.data.intents.map(intent => ({ ...intent })); }
    detach() { this.detached = true; }
    save() {
        this.assertCurrent();
        try { this.storage.setItem(this.key, JSON.stringify(this.data)); }
        catch { this.storageFailed = true; throw new Error('Transfer data could not be saved. No further POST will be sent from this view.'); }
    }
    select(id) {
        this.assertCurrent();
        if (this.busy) return;
        if (id !== null && !this.data.intents.some(intent => intent.transfer_request_id === id)) throw new Error('Unknown transfer request.');
        this.data.activeId = id;
        this.save();
        this.notify();
    }
    startNew() { this.select(null); }

    create(values, approval = false) {
        this.assertCurrent();
        if (this.busy || this.active || this.storageFailed) throw new Error('Finish selecting the existing intent before creating another.');
        const intent = this.newIntent(values, approval);
        this.data.intents.push(intent);
        this.data.activeId = intent.transfer_request_id;
        this.save(); // Persist before any financial POST.
        this.notify();
        return { ...intent };
    }

    newIntent(values, approval) {
        if (!accountText(values.source_account, 50, true) || !accountText(values.target_account, 34)
                || typeof approval !== 'boolean') throw new Error('Enter a valid source account and destination.');
        const amount = exactAmount(values.amount);
        if (typeof this.crypto?.randomUUID !== 'function') throw new Error('Secure UUID generation requires a supported browser and HTTPS.');
        const id = this.crypto.randomUUID();
        if (!UUID.test(id) || this.data.intents.some(intent => intent.transfer_request_id === id)) throw new Error('Could not create a unique request UUID.');
        return { transfer_request_id: id, source_account: values.source_account,
            target_account: values.target_account, amount, allowDuplicatePendingTransfer: approval,
            outcome: 'UNRESOLVED', notice: '', transaction_id: null, rejection_code: null,
            created_at: new Date().toISOString(), confirmation_request_id: null };
    }

    approveDuplicate(id) {
        this.assertCurrent();
        if (this.busy || this.storageFailed) throw new Error('A request is in progress or cannot be saved.');
        const original = this.data.intents.find(intent => intent.transfer_request_id === id);
        if (!original || original.outcome !== 'REJECTED' || original.rejection_code !== 'DUPLICATE_APPROVAL_REQUIRED'
                || original.allowDuplicatePendingTransfer) throw new Error('This request cannot authorize a duplicate.');
        if (original.confirmation_request_id) {
            this.select(original.confirmation_request_id);
            return { ...this.active };
        }
        const approved = this.newIntent(original, true);
        this.data.intents.push(approved);
        this.data.activeId = approved.transfer_request_id;
        original.confirmation_request_id = approved.transfer_request_id;
        this.save(); // Persist the rejected UUID, new intent and their link in one write.
        this.notify();
        return { ...approved };
    }

    async send(id) { return this.request(id, false); }
    async recover(id) { return this.request(id, true); }
    async request(id, recovery) {
        this.assertCurrent();
        if (this.busy) return false;
        const intent = this.data.intents.find(item => item.transfer_request_id === id);
        if (!intent) throw new Error('Unknown transfer request.');
        if (!recovery && (this.storageFailed || ['APPROVED', 'FAILED', 'REJECTED'].includes(intent.outcome))) {
            throw new Error('Use status recovery for this intent; a new transfer requires a new UUID.');
        }
        this.busy = true;
        this.notify();
        try {
            if (!recovery) this.save();
            const token = await this.getToken();
            this.assertCurrent();
            if (typeof token !== 'string' || !token) throw new Error('Authentication required.');
            const options = { method: recovery ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
                headers: { Authorization: `Bearer ${token}` } };
            if (!recovery) {
                options.headers['Content-Type'] = 'application/json';
                options.body = transferBody(intent);
            }
            const response = await this.fetch('/api/v1/' + (recovery ? 'transfer-requests/' + encodeURIComponent(id) : 'transfers'), options);
            let body;
            try { body = await response.json(); } catch { body = null; }
            this.assertCurrent();
            const result = resultFor(response.status, body, intent, recovery);
            // A failed check does not erase a previously observed financial decision.
            Object.assign(intent, result);
            this.save();
            return true;
        } catch {
            if (this.isCurrent()) {
                intent.notice = this.storageFailed ? 'STORAGE_ERROR' : 'UNCONFIRMED';
                try { this.save(); } catch { /* Keep the original persisted intent for recovery. */ }
            }
            return false;
        } finally {
            this.busy = false;
            this.notify();
        }
    }
}
