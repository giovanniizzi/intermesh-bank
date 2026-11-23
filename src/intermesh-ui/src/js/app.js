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
    document.querySelector('.user-role').textContent = "Verified Profile Context";
    if (keycloak.tokenParsed.given_name && keycloak.tokenParsed.family_name) {
        document.querySelector('.avatar').textContent = 
            keycloak.tokenParsed.given_name[0] + keycloak.tokenParsed.family_name[0];
    }
}

// --- ACCOUNT DISCOVERY ON PAGE RELOAD ---
async function checkExistingAccount(userID) {
    const context = requestContext();
    try {
        console.log("[Account Lookup] Checking for an existing account.");
        const response = await authenticatedFetch(`${GATEWAY_URL}/api/v1/accounts/${userID}`, {}, context);
        
        if (response.status === 200) {
            const accountData = await response.json();
            if (!isCurrentRequest(context)) return;
            
            // Update the internal state variable
            activeAccountID = accountData.account_id;
            
            // Hide onboarding because the user already has an active account
            document.getElementById('onboardingForm').classList.add('hidden');
            
            // CRUCIAL FIX: Set the account ID directly in the transfer's "Source Account" field
            if (sourceAccountInput) {
                sourceAccountInput.value = activeAccountID;
            }
            
            // Update the account summary with the welcome message
            onboardingTarget.replaceChildren(
                textElement('strong', `Welcome Back ${accountData.holder_name}!`), document.createElement('br'),
                textElement('strong', 'Account Number:'), document.createTextNode(` ${activeAccountID}`), document.createElement('br'),
                textElement('strong', 'IBAN:'), document.createTextNode(` ${accountData.iban}`), document.createElement('br'),
                textElement('strong', 'Balance snapshot (reload to update):'), document.createTextNode(` €${accountData.balance.toFixed(2)}`)
            );
            onboardingTarget.classList.remove('hidden');
            
            // Start polling to display Ledger transactions
            renderTransferState();
            startLedgerPolling(activeAccountID);
        } else if (response.status === 404) {
            console.log("[Channel Hub Context] No pre-existing account discovered. Fresh onboarding required.");
        }
    } catch {
        console.error("[Account Lookup] Account discovery failed.");
    }
}

function startLedgerPolling(accountId) {
    stopLedgerPolling();
    if (authenticationBlocked || sessionEnded) return;
    const context = requestContext();
    const runPolling = () => {
        if (authenticationBlocked || !isCurrentRequest(context) || accountId !== activeAccountID) return;
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
}

async function fetchLedgerHistory(accountId) {
    const context = requestContext();
    if (authenticationBlocked || !isCurrentRequest(context) || accountId !== activeAccountID) return;
    if (historyRequest?.generation === context.generation) return;
    historyRequest = context;
    try {
        const response = await authenticatedFetch(`${GATEWAY_URL}/api/v1/account/${accountId}/transactions`, {}, context);
        if (!response.ok) return;

        const transactions = await response.json();
        if (isCurrentRequest(context) && accountId === activeAccountID) renderHistoryTable(transactions);
    } catch {} finally {
        if (historyRequest === context) historyRequest = null;
    }
}

function setupEventListeners() {
    const onboardingForm = document.getElementById('onboardingForm');
    const transferForm = document.getElementById('transferForm');

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
        if (authenticationBlocked || sessionEnded) return;
        const context = requestContext();
        const payload = {
            holder_name: document.getElementById('holderName').value,
            initial_deposit: parseFloat(document.getElementById('initialDeposit').value)
        };
        try {
            const response = await authenticatedFetch(`${GATEWAY_URL}/api/v1/accounts`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }, context);

            if (!response.ok) throw new Error('Onboarding execution rejected by Mesh guards.');
            
            const result = await response.json();
            if (!isCurrentRequest(context)) return;
            const accountDetails = result.account_details;
            activeAccountID = accountDetails.account_id;

            sourceAccountInput.value = activeAccountID; // Populate the transfer field immediately after account creation
            onboardingTarget.replaceChildren(
                textElement('strong', 'Active Account Provisioned:'), document.createTextNode(` ${activeAccountID} `),
                document.createElement('br'), textElement('strong', 'IBAN:'), document.createTextNode(` ${accountDetails.iban}`)
            );
            onboardingTarget.classList.remove('hidden');
            
            renderTransferState();
            showToast('Account successfully provisioned in Core Ledger!', 'success');
            startLedgerPolling(activeAccountID);
        } catch (error) {
            if (isCurrentRequest(context)) showToast(authenticationBlocked ? AUTHENTICATION_PAUSED : error.message, 'error');
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
    stopLedgerPolling();
    if (!sourceAccountInput) return;
    sourceAccountInput.value = '';
    document.getElementById('targetAccount').value = '';
    document.getElementById('transferAmount').value = '';
    onboardingTarget.textContent = '';
    onboardingTarget.classList.add('hidden');
    document.getElementById('onboardingForm').classList.remove('hidden');
    document.getElementById('holderName').value = '';
    document.getElementById('initialDeposit').value = '1000.00';
    renderHistoryTable([]);
    document.querySelector('.user-name').textContent = 'Sign in to continue';
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
    try { await action(requests); }
    catch (error) { if (requests.isCurrent()) showToast(error.message, 'error'); }
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

function renderHistoryTable(transactions) {
    historyTableBody.replaceChildren();
    if (!transactions || transactions.length === 0) {
        const row = document.createElement('tr');
        const cell = textElement('td', 'No transactions recorded yet for this asset.');
        cell.colSpan = 5;
        cell.className = 'empty-state';
        row.append(cell);
        historyTableBody.append(row);
        return;
    }
    for (const tx of transactions) {
        const row = document.createElement('tr');
        const fields = [['strong', tx.transaction_id], ['code', tx.target_iban],
            ['strong', `€${tx.amount.toFixed(2)}`], ['span', tx.status], ['small', tx.timestamp]];
        for (const [tag, text] of fields) {
            const cell = document.createElement('td');
            const content = textElement(tag, text);
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
