import Keycloak from './libs/keycloak.js';
import { TransferRequests, describeIntent, userScope } from './transfer-requests.js';

// --- MODULE-LEVEL VARIABLES ---
const GATEWAY_URL = window.location.origin; 
let activeAccountID = null;
let pollingInterval = null;
let pollingVisibilityHandler = null;
let historyRequest = null;
let tokenRefresh = null;
let authenticationGeneration = 0;
let authenticationBlocked = false;
let sessionEnded = false;
const AUTHENTICATION_PAUSED = 'Authentication is unavailable. Requests are paused; reload to sign in again. Saved transfer requests are retained.';

// HTML element references (declared here, initialized at startup)
let sourceAccountInput, onboardingTarget, historyTableBody, toast, logoutBtn;
let transferRequests = null;
let transferLoadError = false;
let accountState = 'loading';
let onboardingBusy = false;
let historyLoaded = false;

const keycloak = new Keycloak({
    url: 'PLACEHOLDER_KEYCLOAK_URL',
    realm: 'intermesh-bank',
    clientId: 'intermesh-frontend'
});

keycloak.onAuthLogout = endAuthenticationSession;
keycloak.onAuthRefreshError = () => {
    if (!sessionEnded) pauseAuthenticatedRequests();
};
keycloak.onAuthRefreshSuccess = () => {
    if (sessionEnded) return;
    if (sourceAccountInput && (!transferRequests || !transferRequests.isCurrent())) {
        suspendTransferView();
        initializeTransfers();
        populateUserProfile();
        const userID = keycloak.tokenParsed?.preferred_username;
        if (userID) checkExistingAccount(userID);
    }
};

// Enforce modern authentication loop
keycloak.init({ 
    onLoad: 'login-required',
    checkLoginIframe: false,
    pkceMethod: 'S256'
}).then((authenticated) => {
    if (authenticated) {
        console.log("[Keycloak] Boundary Token Verified. Launching core systems...");
        
        // STEP 1: Bind HTML elements before any other initialization
        bindUIElements();
        
        // STEP 2: Populate the user profile (name and avatar)
        populateUserProfile();
        
        // STEP 3: Attach form submission listeners
        setupEventListeners();
        initializeTransfers();
        
        // STEP 4: Look up the account once sourceAccountInput is initialized
        const userID = keycloak.tokenParsed.preferred_username;
        if (userID) {
            checkExistingAccount(userID);
        } else {
            renderAccountState('error', 'Your account could not be loaded. Sign in again to continue.');
        }
    } else {
        window.location.reload();
    }
}).catch(() => {
    console.error("[Keycloak] Authentication initialization failed.");
    alert("Critical Identity Error: The Security perimeter rejected the handshake link.");
});

function bindUIElements() {
    sourceAccountInput = document.getElementById('sourceAccount');
    onboardingTarget = document.getElementById('onboardingTarget');
    historyTableBody = document.getElementById('historyTableBody');
    toast = document.getElementById('notificationToast');
    logoutBtn = document.getElementById('logoutBtn');
}

function populateUserProfile() {
    const firstName = keycloak.tokenParsed.given_name || "";
    const lastName = keycloak.tokenParsed.family_name || "";

    document.querySelector('.user-name').textContent = 
    (firstName || lastName) 
        ? `${firstName} ${lastName}`.trim() 
        : (keycloak.tokenParsed.preferred_username || "Authenticated User");
    document.querySelector('.user-role').textContent = 'Personal banking';
    document.querySelector('.avatar').textContent = document.querySelector('.user-name').textContent
        .trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

function renderAccountState(state, message) {
    accountState = state;
    const canOpen = state === 'empty' || state === 'creating';
    const messages = {
        loading: 'Loading your account…',
        empty: 'Open an account to start banking with InterMesh.',
        creating: 'Opening your account. Please wait…',
        error: 'We couldn’t load your account. Please try again.',
        'signed-out': 'Sign in to view your account.'
    };
    document.getElementById('accountTitle').textContent = canOpen ? 'Open your account' : 'Account Overview';
    const status = document.getElementById('accountStatus');
    status.textContent = message || messages[state] || '';
    status.hidden = state === 'ready';
    status.className = state === 'error' ? 'account-status error' : 'account-status';
    document.getElementById('accountOverview').setAttribute('aria-busy', String(state === 'loading' || onboardingBusy));
    document.getElementById('onboardingForm').classList[canOpen ? 'remove' : 'add']('hidden');
    onboardingTarget.classList[state === 'ready' ? 'remove' : 'add']('hidden');
    document.getElementById('retryAccount').hidden = state !== 'error' || authenticationBlocked;
    document.getElementById('btnOnboard').disabled = state !== 'empty' || onboardingBusy || authenticationBlocked;
    document.getElementById('btnOnboard').textContent = onboardingBusy ? 'Opening account…' : 'Open account';
}

function showAccount(account) {
    if (!account || typeof account.account_id !== 'string' || !account.account_id.trim()
            || typeof account.iban !== 'string' || !account.iban.trim() || !Number.isFinite(account.balance)) {
        throw new Error('Account information is unavailable.');
    }
    activeAccountID = account.account_id;
    sourceAccountInput.value = activeAccountID;
    const balance = document.createElement('div');
    balance.className = 'account-balance';
    const label = textElement('span', 'Available balance');
    label.className = 'balance-label';
    const value = textElement('strong', formatMoney(account.balance));
    value.className = 'balance-value';
    const note = textElement('p', 'Balance snapshot at account load. Reload to update.');
    note.className = 'balance-note';
    balance.append(label, value, note);
    const details = document.createElement('dl');
    details.className = 'account-details';
    for (const [title, text] of [['Account number', activeAccountID], ['IBAN', account.iban]]) {
        const item = document.createElement('div');
        const description = textElement('dd', text);
        if (title === 'IBAN') description.className = 'iban';
        item.append(textElement('dt', title), description);
        details.append(item);
    }
    onboardingTarget.replaceChildren(balance, details);
    renderAccountState('ready');
    historyLoaded = false;
    renderHistoryMessage('Loading transactions…');
    renderTransferState();
    startLedgerPolling(activeAccountID);
}

// --- ACCOUNT DISCOVERY ON PAGE RELOAD ---
async function checkExistingAccount(userID) {
    const context = requestContext();
    renderAccountState('loading');
    try {
        console.log("[Account Lookup] Checking for an existing account.");
        const response = await authenticatedFetch(`${GATEWAY_URL}/api/v1/accounts/${userID}`, {}, context);
        
        if (response.status === 200) {
            const accountData = await response.json();
            if (!isCurrentRequest(context)) return;
            
            showAccount(accountData);
        } else if (isCurrentRequest(context)) {
            renderAccountState(response.status === 404 ? 'empty' : 'error',
                authenticationBlocked ? AUTHENTICATION_PAUSED : undefined);
        }
    } catch {
        if (isCurrentRequest(context)) renderAccountState('error', authenticationBlocked ? AUTHENTICATION_PAUSED : undefined);
        console.error("[Account Lookup] Account discovery failed.");
    }
}

function startLedgerPolling(accountId) {
    stopLedgerPolling();
    if (authenticationBlocked || sessionEnded) return;
    const context = requestContext();
    const runPolling = () => {
        if (authenticationBlocked || !isCurrentRequest(context) || accountId !== activeAccountID) return;
        document.getElementById('historyUpdateNote').textContent = 'Updates every 15 seconds while this tab is visible';
        if (pollingInterval) clearInterval(pollingInterval);
        
        fetchLedgerHistory(accountId);

        pollingInterval = setInterval(() => {
            fetchLedgerHistory(accountId);
        }, 15000);
    };

    const stopPolling = () => {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
        document.getElementById('historyUpdateNote').textContent = 'Updates paused while this tab is hidden';
    };

    pollingVisibilityHandler = () => {
        if (document.visibilityState === 'visible') {
            runPolling();
        } else {
            stopPolling();
        }
    };

    document.addEventListener('visibilitychange', pollingVisibilityHandler);

    if (document.visibilityState === 'visible') {
        runPolling();
    }
}

function stopLedgerPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = null;
    if (pollingVisibilityHandler) document.removeEventListener('visibilitychange', pollingVisibilityHandler);
    pollingVisibilityHandler = null;
    document.getElementById('historyUpdateNote').textContent = activeAccountID
        ? 'Updates paused' : 'Load an account to view activity';
}

async function fetchLedgerHistory(accountId) {
    const context = requestContext();
    if (authenticationBlocked || !isCurrentRequest(context) || accountId !== activeAccountID) return;
    if (historyRequest?.generation === context.generation) return;
    historyRequest = context;
    try {
        const response = await authenticatedFetch(`${GATEWAY_URL}/api/v1/account/${accountId}/transactions`, {}, context);
        if (!response.ok) throw new Error('History unavailable');

        const transactions = await response.json();
        if (isCurrentRequest(context) && accountId === activeAccountID) {
            renderHistoryTable(transactions);
            historyLoaded = true;
        }
    } catch {
        if (isCurrentRequest(context) && accountId === activeAccountID && !historyLoaded) {
            renderHistoryMessage(authenticationBlocked ? 'Sign in again to load transaction history.'
                : 'Transaction history is unavailable. We’ll check again on the next update.');
        }
    } finally {
        if (historyRequest === context) historyRequest = null;
    }
}

function setupEventListeners() {
    const onboardingForm = document.getElementById('onboardingForm');
    const transferForm = document.getElementById('transferForm');
    const navigation = [...document.querySelectorAll('.nav-item')];
    const updateNavigation = () => {
        const selected = navigation.find(link => link.getAttribute('href') === window.location.hash) || navigation[0];
        for (const link of navigation) {
            link.classList[link === selected ? 'add' : 'remove']('active');
            if (link === selected) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        }
    };
    window.addEventListener('hashchange', updateNavigation);
    updateNavigation();
    document.getElementById('retryAccount').addEventListener('click', () => {
        const userID = keycloak.tokenParsed?.preferred_username;
        if (!authenticationBlocked && userID) checkExistingAccount(userID);
    });
    for (const id of ['sourceAccount', 'targetAccount', 'transferAmount']) {
        document.getElementById(id).addEventListener('input', () => {
            document.getElementById(id).removeAttribute('aria-invalid');
            showTransferError('');
        });
    }
    transferForm.addEventListener('invalid', event => {
        event.target.setAttribute('aria-invalid', 'true');
        showTransferError(event.target.validationMessage);
    }, true);

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            console.log("[Keycloak Perimeter] Terminating user session link...");
            
            endAuthenticationSession();
            
            // End the Keycloak session and redirect
            // the browser to the initial login page
            keycloak.logout({
                redirectUri: window.location.origin // Return the user to the bank's home page after logout
            });
        });
    }

    // Pipeline Onboarding
    onboardingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (authenticationBlocked || sessionEnded || onboardingBusy || accountState !== 'empty') return;
        const context = requestContext();
        const payload = {
            holder_name: document.getElementById('holderName').value,
            initial_deposit: parseFloat(document.getElementById('initialDeposit').value)
        };
        onboardingBusy = true;
        document.getElementById('onboardingError').hidden = true;
        renderAccountState('creating');
        try {
            const response = await authenticatedFetch(`${GATEWAY_URL}/api/v1/accounts`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }, context);

            if (!response.ok) throw new Error('Account creation was not confirmed. Check your account before trying again.');
            
            const result = await response.json();
            if (!isCurrentRequest(context)) return;
            showAccount(result.account_details);
            showToast('Your account is ready.', 'success');
        } catch {
            if (isCurrentRequest(context)) {
                const message = authenticationBlocked ? AUTHENTICATION_PAUSED
                    : 'Account creation was not confirmed. Check your account before trying again.';
                renderAccountState(authenticationBlocked ? 'empty' : 'error', message);
                const error = document.getElementById('onboardingError');
                error.textContent = message;
                error.hidden = false;
            }
        } finally {
            if (isCurrentRequest(context)) {
                onboardingBusy = false;
                renderAccountState(accountState, document.getElementById('accountStatus').textContent);
            }
        }
    });

    transferForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!transferRequests || transferRequests.busy || transferRequests.active) return;
        runTransferAction(async requests => {
            const intent = requests.create({ source_account: sourceAccountInput.value,
                target_account: document.getElementById('targetAccount').value,
                amount: document.getElementById('transferAmount').value });
            await requests.send(intent.transfer_request_id);
        });
    });
    document.getElementById('savedTransfer').addEventListener('change', event => {
        runTransferAction(requests => requests.select(event.target.value || null));
    });
    document.getElementById('newTransfer').addEventListener('click', () => {
        runTransferAction(requests => {
            requests.startNew();
            sourceAccountInput.value = activeAccountID || '';
            document.getElementById('targetAccount').value = '';
            document.getElementById('transferAmount').value = '';
        });
    });
    document.getElementById('checkTransfer').addEventListener('click', () => {
        runTransferAction(requests => requests.recover(requests.active.transfer_request_id));
    });
    document.getElementById('replayTransfer').addEventListener('click', () => {
        const intent = transferRequests?.active;
        if (!intent || transferRequests.busy) return;
        if (window.confirm(`Replay request ${intent.transfer_request_id}?\n${intent.source_account} → ${intent.target_account}\n€${intent.amount}\n\nThe same UUID and values will be sent. If admission already exists, its workflow will not restart. If the earlier request never arrived, it may be admitted now.`)) {
            runTransferAction(requests => requests.send(intent.transfer_request_id));
        }
    });
    document.getElementById('confirmDuplicate').addEventListener('click', () => {
        const original = transferRequests?.active;
        if (!original || transferRequests.busy) return;
        if (window.confirm(`Confirm a separate duplicate transfer?\nSource: ${original.source_account}\nDestination: ${original.target_account}\nAmount: €${original.amount}\n\nAn identical transfer is already pending. This action creates a new UUID with explicit duplicate approval. Only one exception is allowed per pending cycle.`)) {
            runTransferAction(async requests => {
                const approved = requests.approveDuplicate(original.transfer_request_id);
                await requests.send(approved.transfer_request_id);
            });
        }
    });
}

function authenticatedScope() {
    try { return keycloak.authenticated ? userScope(keycloak.tokenParsed) : null; } catch { return null; }
}

function requestContext() {
    return { scope: authenticatedScope(), generation: authenticationGeneration };
}

function isCurrentRequest(context) {
    return !sessionEnded && context.scope && context.scope === authenticatedScope()
        && context.generation === authenticationGeneration;
}

function pauseAuthenticatedRequests() {
    if (authenticationBlocked) return;
    authenticationBlocked = true;
    stopLedgerPolling();
    if (sourceAccountInput) {
        document.getElementById('btnOnboard').disabled = true;
        document.getElementById('retryAccount').hidden = true;
        renderTransferState();
        showToast(AUTHENTICATION_PAUSED, 'error');
    }
}

function endAuthenticationSession() {
    if (sessionEnded) return;
    sessionEnded = true;
    authenticationBlocked = true;
    suspendTransferView();
}

async function getAccessToken(context) {
    if (authenticationBlocked || !isCurrentRequest(context)) throw new Error(AUTHENTICATION_PAUSED);
    try {
        // Share one refresh across polling, onboarding and transfer requests.
        if (!tokenRefresh) tokenRefresh = keycloak.updateToken(30);
        const pending = tokenRefresh;
        try { await pending; }
        finally { if (tokenRefresh === pending) tokenRefresh = null; }
    } catch {
        if (isCurrentRequest(context)) pauseAuthenticatedRequests();
        throw new Error(AUTHENTICATION_PAUSED);
    }
    // Logout and identity changes invalidate even a successfully refreshed token.
    if (authenticationBlocked || !isCurrentRequest(context)) throw new Error(AUTHENTICATION_PAUSED);
    if (typeof keycloak.token !== 'string' || !keycloak.token.trim()) {
        pauseAuthenticatedRequests();
        throw new Error(AUTHENTICATION_PAUSED);
    }
    return keycloak.token;
}

async function sendAuthenticatedRequest(url, options, context) {
    if (authenticationBlocked || !isCurrentRequest(context)) throw new Error(AUTHENTICATION_PAUSED);
    const response = await fetch(url, options);
    // Never retry an API request, including a financial POST, after a 401.
    if (response.status === 401 && isCurrentRequest(context)) pauseAuthenticatedRequests();
    return response;
}

async function authenticatedFetch(url, options, context) {
    const token = await getAccessToken(context);
    return sendAuthenticatedRequest(url, { ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` } }, context);
}

function initializeTransfers() {
    transferLoadError = false;
    const context = requestContext();
    try {
        transferRequests = new TransferRequests({ storage: window.sessionStorage, crypto: window.crypto,
            fetch: (url, options) => sendAuthenticatedRequest(url, options, context),
            getClaims: () => keycloak.authenticated ? keycloak.tokenParsed : null,
            getToken: () => getAccessToken(context),
            onChange: renderTransferState });
    } catch {
        transferRequests = null;
        transferLoadError = true;
    }
    renderTransferState();
}

function suspendTransferView() {
    authenticationGeneration++;
    transferRequests?.detach();
    transferRequests = null;
    transferLoadError = false;
    activeAccountID = null;
    onboardingBusy = false;
    historyLoaded = false;
    stopLedgerPolling();
    if (!sourceAccountInput) return;
    sourceAccountInput.value = '';
    document.getElementById('targetAccount').value = '';
    document.getElementById('transferAmount').value = '';
    onboardingTarget.textContent = '';
    onboardingTarget.classList.add('hidden');
    renderAccountState('signed-out');
    document.getElementById('onboardingError').hidden = true;
    showTransferError('');
    document.getElementById('holderName').value = '';
    document.getElementById('initialDeposit').value = '1000.00';
    renderHistoryTable([]);
    document.querySelector('.user-name').textContent = 'Sign in to continue';
    document.querySelector('.user-role').textContent = 'Signed out';
    document.querySelector('.avatar').textContent = '--';
    toast.classList.add('hidden');
    renderTransferState();
}

function renderTransferState() {
    const requests = transferRequests?.isCurrent() ? transferRequests : null;
    const active = requests?.active;
    const busy = requests?.busy || false;
    const unavailable = busy || authenticationBlocked;
    const saved = document.getElementById('savedTransfer');
    const recovery = document.getElementById('transferRecovery');
    const status = document.getElementById('transferStatus');
    const details = document.getElementById('transferDetails');
    saved.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'New transfer — enter values above';
    saved.append(empty);
    for (const intent of (requests?.intents || []).reverse()) {
        const option = document.createElement('option');
        option.value = intent.transfer_request_id;
        option.textContent = `${intent.outcome} · €${intent.amount} · ${intent.transfer_request_id}`;
        saved.append(option);
    }
    saved.value = active?.transfer_request_id || '';
    saved.disabled = unavailable || !requests;
    recovery.hidden = !(requests?.intents.length || transferLoadError || authenticationBlocked);
    details.textContent = active ? `Request: ${active.transfer_request_id}\nSource: ${active.source_account}\nDestination: ${active.target_account}\nAmount: €${active.amount}\nDuplicate approval: ${active.allowDuplicatePendingTransfer ? 'yes' : 'no'}`
        + (active.transaction_id ? `\nTransaction: ${active.transaction_id}` : '')
        + (active.confirmation_request_id ? `\nSeparate duplicate request: ${active.confirmation_request_id}` : '') : '';
    status.textContent = transferLoadError
        ? 'Saved transfer data is unavailable. Nothing will be sent. Preserve this tab’s sessionStorage for recovery.'
        : active ? (busy ? 'Contacting Orchestrator. The saved UUID and transfer values are unchanged. ' : '') + describeIntent(active)
        : 'Saved requests are retained. Starting another transfer creates a separate intent with a new UUID.';
    if (authenticationBlocked && !sessionEnded) status.textContent = AUTHENTICATION_PAUSED + '\n' + status.textContent;
    for (const id of ['sourceAccount', 'targetAccount', 'transferAmount']) {
        document.getElementById(id).readOnly = Boolean(active) || unavailable || !requests;
    }
    if (active) {
        sourceAccountInput.value = active.source_account;
        document.getElementById('targetAccount').value = active.target_account;
        document.getElementById('transferAmount').value = active.amount;
    }
    document.getElementById('btnTransfer').disabled = !requests || unavailable || Boolean(active) || requests.storageFailed;
    document.getElementById('btnTransfer').textContent = busy ? 'Processing…' : 'Send transfer';
    document.getElementById('transferForm').setAttribute('aria-busy', String(busy));
    document.getElementById('checkTransfer').disabled = !active || unavailable;
    document.getElementById('replayTransfer').disabled = !active || unavailable || requests?.storageFailed
        || ['APPROVED', 'FAILED', 'REJECTED'].includes(active?.outcome);
    document.getElementById('newTransfer').disabled = !requests || unavailable || requests.storageFailed;
    const duplicate = document.getElementById('confirmDuplicate');
    duplicate.hidden = !(active?.outcome === 'REJECTED' && active.rejection_code === 'DUPLICATE_APPROVAL_REQUIRED'
        && !active.allowDuplicatePendingTransfer && !active.confirmation_request_id);
    duplicate.disabled = unavailable || !requests || requests.storageFailed;
}

async function runTransferAction(action) {
    const requests = transferRequests;
    if (authenticationBlocked || !requests || !requests.isCurrent() || requests.busy) return;
    showTransferError('');
    try { await action(requests); }
    catch (error) {
        if (requests.isCurrent()) {
            showTransferError(error.message);
            showToast(error.message, 'error');
        }
    }
    finally {
        if (requests === transferRequests && requests.isCurrent()) {
            renderTransferState();
            if (!authenticationBlocked && activeAccountID) fetchLedgerHistory(activeAccountID);
        }
    }
}

function textElement(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
}

function showTransferError(message) {
    const error = document.getElementById('transferError');
    error.textContent = message;
    error.hidden = !message;
}

function formatMoney(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(value) : 'Unavailable';
}

function formatTimestamp(value) {
    // PostgreSQL timestamps have no timezone here; preserve the Ledger's wall-clock time.
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):\d{2}(?:\.\d+)?$/.exec(String(value));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (!match || !months[Number(match[2]) - 1]) return value;
    return `${match[3]} ${months[Number(match[2]) - 1]} ${match[1]}, ${match[4]}:${match[5]}`;
}

function renderHistoryMessage(message) {
    document.getElementById('historyTable').classList.add('is-empty');
    document.getElementById('tableHelp').hidden = true;
    const row = document.createElement('tr');
    const cell = textElement('td', message);
    cell.colSpan = 5;
    cell.className = 'empty-state';
    row.append(cell);
    historyTableBody.replaceChildren(row);
}

function renderHistoryTable(transactions) {
    historyTableBody.replaceChildren();
    if (!transactions || transactions.length === 0) {
        renderHistoryMessage(activeAccountID ? 'No transactions found for this account.'
            : 'Load or open an account to view its transactions.');
        return;
    }
    document.getElementById('historyTable').classList.remove('is-empty');
    document.getElementById('tableHelp').hidden = false;
    for (const tx of transactions) {
        const row = document.createElement('tr');
        const knownStatus = ['PENDING', 'APPROVED', 'FAILED'].includes(tx.status);
        const statusLabel = knownStatus ? tx.status[0] + tx.status.slice(1).toLowerCase() : tx.status;
        const fields = [['strong', tx.transaction_id], ['code', tx.target_iban],
            ['strong', formatMoney(tx.amount)], ['span', statusLabel], ['small', formatTimestamp(tx.timestamp)]];
        for (const [index, [tag, text]] of fields.entries()) {
            const cell = document.createElement('td');
            const content = textElement(tag, text);
            if (index === 2) cell.className = 'amount-cell';
            if (tag === 'span') {
                const status = String(tx.status).toLowerCase();
                content.className = ['pending', 'approved', 'failed'].includes(status)
                    ? `status-pill ${status}` : 'status-pill';
            }
            cell.append(content);
            row.append(cell);
        }
        historyTableBody.append(row);
    }
}

function showToast(message, type) {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    setTimeout(() => { toast.classList.add('hidden'); }, 5000);
}
