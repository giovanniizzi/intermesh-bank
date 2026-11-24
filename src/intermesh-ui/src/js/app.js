import Keycloak from './libs/keycloak.js';
import { TransferRequests, describeIntent, userScope, exactAmount } from './transfer-requests.js';
import { validateIban, formatIban, italianIbanParts } from './iban.js';

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
let transferReview = null;
const appState = {
    view: 'dashboard', account: null, transactions: null, copyingIban: false,
    historyMessage: 'Load or open an account to view its transactions.'
};
const views = {
    dashboard: { title: 'Dashboard', subtitle: 'Welcome back. Your everyday banking, all in one place.' },
    accountOverview: { title: 'My Account', subtitle: 'Your account details and balance snapshot.' },
    transfers: { title: 'Transfers', subtitle: 'Send a payment or check a saved transfer.' },
    transactions: { title: 'History', subtitle: 'Review your account activity and transfer statuses.' }
};

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
    document.getElementById('ibanCopyControls').hidden = state !== 'ready';
    document.getElementById('copyIban').disabled = authenticationBlocked || appState.copyingIban || state !== 'ready';
    renderDashboardAccount(state, status.textContent);
}

function accountBalancePanel(account, noteText = 'Balance snapshot at account load. Reload to update.') {
    const balance = document.createElement('div');
    balance.className = 'account-balance';
    const label = textElement('span', 'Available balance');
    label.className = 'balance-label';
    const value = textElement('strong', formatMoney(account.balance));
    value.className = 'balance-value';
    const note = textElement('p', noteText);
    note.className = 'balance-note';
    balance.append(label, value, note);
    return balance;
}

function renderDashboardAccount(state, message) {
    const status = document.getElementById('dashboardAccountStatus');
    const summary = document.getElementById('dashboardAccountSummary');
    const ready = state === 'ready' && appState.account !== null;
    status.textContent = message;
    status.hidden = ready;
    summary.hidden = !ready;
    summary.replaceChildren();
    document.getElementById('dashboardAccountLink').textContent = state === 'empty' ? 'Open account' : 'View account';
    if (ready) {
        summary.append(accountBalancePanel(appState.account), textElement('p', `Account ${appState.account.account_id}`));
        const iban = appState.account.iban.trim();
        if (iban.length > 8) {
            const abbreviatedIban = textElement('p', `IBAN ${iban.slice(0, 4)} … ${iban.slice(-4)}`);
            abbreviatedIban.className = 'dashboard-iban';
            summary.append(abbreviatedIban);
        }
    }
    renderDashboardActivity();
}

function renderDashboardActivity() {
    const list = document.getElementById('recentTransactionsList');
    const status = document.getElementById('recentTransactionsStatus');
    const recent = appState.account ? (appState.transactions || []).slice(0, 3) : [];
    list.replaceChildren();
    list.hidden = recent.length === 0;
    status.hidden = recent.length > 0;
    const empty = Array.isArray(appState.transactions) && appState.transactions.length === 0;
    status.textContent = !appState.account ? 'Load or open an account to see recent activity.'
        : empty ? 'No recent transactions yet. Make a transfer to see activity here.' : appState.historyMessage;
    for (const transaction of recent) {
        const item = document.createElement('li');
        const description = document.createElement('div');
        const details = document.createElement('div');
        description.append(textElement('span', transaction.target_iban), textElement('small', formatTimestamp(transaction.timestamp)));
        details.append(textElement('strong', formatMoney(transaction.amount)), transactionStatus(transaction.status));
        item.append(description, details);
        list.append(item);
    }
}

function showAccount(account) {
    if (!account || typeof account.account_id !== 'string' || !account.account_id.trim()
            || typeof account.iban !== 'string' || !account.iban.trim() || !Number.isFinite(account.balance)) {
        throw new Error('Account information is unavailable.');
    }
    appState.account = account;
    document.getElementById('historyNotice').hidden = true;
    appState.transactions = null;
    activeAccountID = account.account_id;
    sourceAccountInput.value = activeAccountID;
    document.getElementById('ibanCopyStatus').textContent = '';
    const details = document.createElement('dl');
    details.className = 'account-details';
    for (const [title, text] of [['Account number', activeAccountID], ['IBAN', account.iban]]) {
        const item = document.createElement('div');
        const description = textElement('dd', title === 'IBAN' ? formatIban(text) : text);
        if (title === 'IBAN') {
            description.className = 'iban';
            const parts = italianIbanParts(text);
            if (parts) description.setAttribute('aria-label', parts.map(([label, value]) => `${label}: ${value}`).join(', '));
        }
        item.append(textElement('dt', title), description);
        details.append(item);
    }
    onboardingTarget.replaceChildren(accountBalancePanel(account, 'Your balance when this account was loaded. Reload to see an updated snapshot.'), details);
    renderAccountState('ready');
    historyLoaded = false;
    renderHistoryMessage('Loading transactions…');
    renderTransferState();
    startLedgerPolling(activeAccountID);
}

async function copyIban() {
    const context = requestContext();
    const account = appState.account;
    if (!isCurrentRequest(context) || authenticationBlocked || accountState !== 'ready' || !account || appState.copyingIban) return;
    const button = document.getElementById('copyIban');
    const status = document.getElementById('ibanCopyStatus');
    appState.copyingIban = true;
    button.disabled = true;
    status.textContent = 'Copying IBAN…';
    try {
        await navigator.clipboard.writeText(account.iban);
        if (isCurrentRequest(context) && account === appState.account) status.textContent = 'IBAN copied.';
    } catch {
        if (isCurrentRequest(context) && account === appState.account) {
            status.textContent = 'Copy isn’t available. Select the IBAN in your account details and copy it manually.';
        }
    } finally {
        if (isCurrentRequest(context) && account === appState.account) {
            appState.copyingIban = false;
            button.disabled = authenticationBlocked;
        }
    }
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
        if (!response.ok) throw new Error('History unavailable');

        const transactions = await response.json();
        if (transactions !== null && !Array.isArray(transactions)) throw new Error('History unavailable');
        if (isCurrentRequest(context) && accountId === activeAccountID) {
            renderHistoryTable(transactions);
            document.getElementById('historyNotice').hidden = true;
            historyLoaded = true;
        }
    } catch {
        if (isCurrentRequest(context) && accountId === activeAccountID) {
            if (!historyLoaded) renderHistoryMessage(authenticationBlocked ? 'Sign in again to load transaction history.'
                : 'Transaction history is unavailable. We’ll check again on the next update.');
            else {
                const notice = document.getElementById('historyNotice');
                notice.textContent = authenticationBlocked ? 'Sign in again to update transaction history.'
                    : 'We couldn’t update your history. Showing the last available transactions.';
                notice.hidden = false;
                document.getElementById('historyTransferLink').hidden = true;
            }
        }
    } finally {
        if (historyRequest === context) historyRequest = null;
    }
}

function setupNavigation() {
    const navigation = [...document.querySelectorAll('.nav-item')];
    const showView = (focus) => {
        const requested = window.location.hash.slice(1);
        const selected = Object.hasOwn(views, requested) ? requested : 'dashboard';
        appState.view = selected;
        const help = document.getElementById('transferHelp');
        if (selected !== 'transfers' && help.open) help.close();
        if (selected !== 'transfers') closeTransferReview();
        for (const id of Object.keys(views)) document.getElementById(id).hidden = id !== selected;
        document.getElementById('pageTitle').textContent = views[selected].title;
        document.getElementById('pageSubtitle').textContent = views[selected].subtitle;
        document.title = `${views[selected].title} · InterMesh Bank`;
        for (const link of navigation) {
            const current = link.getAttribute('href') === `#${selected}`;
            link.classList[current ? 'add' : 'remove']('active');
            if (current) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        }
        if (focus) {
            window.scrollTo(0, 0);
            document.getElementById('pageTitle').focus({ preventScroll: true });
        }
    };
    window.addEventListener('hashchange', () => showView(true));
    document.getElementById('skipToContent').addEventListener('click', event => {
        event.preventDefault();
        document.getElementById('pageTitle').focus();
    });
    showView(Boolean(window.location.hash));
}

function setupEventListeners() {
    const onboardingForm = document.getElementById('onboardingForm');
    const transferForm = document.getElementById('transferForm');
    const helpButton = document.getElementById('transferHelpButton');
    const helpDialog = document.getElementById('transferHelp');
    helpButton.addEventListener('click', () => {
        if (!helpDialog.open) helpDialog.showModal();
    });
    document.getElementById('closeTransferHelp').addEventListener('click', () => helpDialog.close());
    helpDialog.addEventListener('close', () => {
        if (appState.view === 'transfers') helpButton.focus({ preventScroll: true });
    });
    setupNavigation();
    document.getElementById('copyIban').addEventListener('click', copyIban);
    const reviewDialog = document.getElementById('transferReview');
    document.getElementById('editTransfer').addEventListener('click', closeTransferReview);
    reviewDialog.addEventListener('close', () => {
        if (reviewDialog.open) return;
        closeTransferReview();
        if (appState.view === 'transfers' && !authenticationBlocked) {
            document.getElementById(transferRequests?.active ? 'transferLifecycle' : 'btnTransfer').focus({ preventScroll: true });
        }
    });
    document.getElementById('confirmTransfer').addEventListener('click', () => {
        const review = transferReview;
        if (!review || !reviewDialog.open || !isCurrentRequest(review.context) || authenticationBlocked
                || transferRequests?.busy || transferRequests?.active) return;
        closeTransferReview();
        runTransferAction(async requests => {
            const intent = requests.create(review.payload);
            await requests.send(intent.transfer_request_id);
        });
        document.getElementById('transferLifecycle').focus({ preventScroll: true });
    });
    document.getElementById('retryAccount').addEventListener('click', () => {
        const userID = keycloak.tokenParsed?.preferred_username;
        if (!authenticationBlocked && userID) checkExistingAccount(userID);
    });
    for (const id of ['sourceAccount', 'targetAccount', 'transferAmount']) {
        document.getElementById(id).addEventListener('input', () => {
            document.getElementById(id).removeAttribute('aria-invalid');
            document.getElementById(id + 'Error').hidden = true;
            closeTransferReview();
            showTransferError('');
        });
    }
    transferForm.addEventListener('invalid', event => {
        event.target.setAttribute('aria-invalid', 'true');
        const error = document.getElementById(event.target.getAttribute('id') + 'Error');
        error.textContent = event.target.validationMessage;
        error.hidden = false;
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
        if (!transferRequests || !transferRequests.isCurrent() || transferRequests.busy || transferRequests.active
                || authenticationBlocked || transferRequests.storageFailed || transferReview) return;
        reviewTransfer();
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
        if (window.confirm(`Resend saved transfer ${intent.transfer_request_id}?\n${intent.source_account} → ${intent.target_account}\n€${intent.amount}\n\nThe original transfer details will be used. If already accepted, the transfer will not be started again. If the earlier request never arrived, it may be accepted now.`)) {
            runTransferAction(requests => requests.send(intent.transfer_request_id));
        }
    });
    document.getElementById('confirmDuplicate').addEventListener('click', () => {
        const original = transferRequests?.active;
        if (!original || transferRequests.busy) return;
        if (window.confirm(`Confirm a separate duplicate transfer?\nSource: ${original.source_account}\nDestination: ${original.target_account}\nAmount: €${original.amount}\n\nAn identical transfer is already pending. Only confirm if you intend to request another payment with the same details. Only one separate duplicate can be approved while matching transfers are pending.`)) {
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
    closeTransferReview();
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
    closeTransferReview();
    transferRequests?.detach();
    transferRequests = null;
    transferLoadError = false;
    activeAccountID = null;
    appState.account = null;
    appState.transactions = null;
    appState.copyingIban = false;
    onboardingBusy = false;
    historyLoaded = false;
    stopLedgerPolling();
    if (!sourceAccountInput) return;
    sourceAccountInput.value = '';
    document.getElementById('targetAccount').value = '';
    document.getElementById('transferAmount').value = '';
    onboardingTarget.textContent = '';
    onboardingTarget.classList.add('hidden');
    document.getElementById('ibanCopyStatus').textContent = '';
    document.getElementById('historyNotice').hidden = true;
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
    const authenticationStatus = document.getElementById('authenticationStatus');
    authenticationStatus.hidden = !authenticationBlocked || sessionEnded;
    authenticationStatus.textContent = authenticationStatus.hidden ? '' : AUTHENTICATION_PAUSED;
    document.getElementById('copyIban').disabled = authenticationBlocked || appState.copyingIban || accountState !== 'ready';
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
        ? 'Saved transfer information is unavailable. Nothing will be sent. Keep this tab open for recovery.'
        : active ? (busy ? 'Checking your transfer. The saved request and transfer details are unchanged. ' : '') + describeIntent(active)
        : 'Saved requests are retained. Start a new transfer only if you intend to request another payment.';
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
    document.getElementById('btnTransfer').textContent = busy ? 'Processing…' : 'Review transfer';
    const lifecycle = document.getElementById('transferLifecycle');
    lifecycle.textContent = busy ? 'Processing — please wait. Do not submit another transfer.'
        : authenticationBlocked || transferLoadError || requests?.storageFailed ? 'Temporarily unavailable — no new transfer will be sent.'
        : active?.notice === 'TRANSFER_PERSISTENCE_UNAVAILABLE' ? 'Temporarily unavailable — the latest financial outcome is not confirmed. Check status before sending again.'
        : active?.notice === 'COMMIT_OUTCOME_UNKNOWN' || active?.outcome === 'UNRESOLVED' ? 'Outcome unknown — check status before sending another payment.'
        : ({ APPROVED: 'Completed', PENDING: 'Pending — this transfer is not completed.',
            FAILED: 'Reported failed', REJECTED: 'Request rejected' }[active?.outcome] || 'Ready to submit');
    lifecycle.className = 'transfer-lifecycle' + (lifecycle.textContent === 'Completed' ? ' completed' : '');
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

function closeTransferReview() {
    transferReview = null;
    const dialog = document.getElementById('transferReview');
    document.getElementById('transferReviewDetails').replaceChildren();
    document.getElementById('transferBalanceWarning').hidden = true;
    if (dialog.open) dialog.close();
}

function transferMoney(amount) {
    const [whole, fraction] = amount.split('.');
    return '€' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction;
}

function reviewTransfer() {
    const payload = {};
    let invalid = null;
    showTransferError('');
    for (const [id, key, validate] of [
        ['sourceAccount', 'source_account', value => {
            if (!value || [...value].length > 50 || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) {
                throw new Error('Enter a valid source account number.');
            }
            return value;
        }],
        ['targetAccount', 'target_account', validateIban],
        ['transferAmount', 'amount', value => {
            if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value.trim())) {
                throw new Error('Enter a positive amount with up to two decimal places, using a decimal point.');
            }
            return exactAmount(value.trim());
        }]
    ]) {
        const field = document.getElementById(id);
        const error = document.getElementById(id + 'Error');
        field.removeAttribute('aria-invalid');
        error.hidden = true;
        try { payload[key] = validate(field.value); }
        catch (failure) {
            field.setAttribute('aria-invalid', 'true');
            error.textContent = failure.message;
            error.hidden = false;
            if (!invalid) {
                invalid = field;
                showTransferError(failure.message);
            }
        }
    }
    if (invalid) { invalid.focus(); return; }
    document.getElementById('targetAccount').value = payload.target_account;
    const details = document.getElementById('transferReviewDetails');
    details.replaceChildren();
    for (const [label, value] of [['From account', payload.source_account],
        ['Recipient IBAN', formatIban(payload.target_account)], ['Amount', transferMoney(payload.amount)]]) {
        const item = document.createElement('div');
        item.append(textElement('dt', label), textElement('dd', value));
        details.append(item);
    }
    // A loaded balance is a snapshot; only the backend can authorize available funds.
    const account = appState.account;
    document.getElementById('transferBalanceWarning').hidden = !account
        || account.account_id !== payload.source_account || Number(payload.amount) <= account.balance;
    transferReview = { payload: Object.freeze(payload), context: requestContext() };
    document.getElementById('transferReview').showModal();
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
    appState.historyMessage = message;
    document.getElementById('historyTable').classList.add('is-empty');
    document.getElementById('tableHelp').hidden = true;
    document.getElementById('historyTransferLink').hidden = message !== 'No transactions found for this account.' || !activeAccountID;
    const row = document.createElement('tr');
    const cell = textElement('td', message);
    cell.colSpan = 5;
    cell.className = 'empty-state';
    row.append(cell);
    historyTableBody.replaceChildren(row);
    renderDashboardActivity();
}

function renderHistoryTable(transactions) {
    appState.transactions = transactions || [];
    historyTableBody.replaceChildren();
    if (!transactions || transactions.length === 0) {
        renderHistoryMessage(activeAccountID ? 'No transactions found for this account.'
            : 'Load or open an account to view its transactions.');
        return;
    }
    document.getElementById('historyTable').classList.remove('is-empty');
    document.getElementById('historyTransferLink').hidden = true;
    document.getElementById('tableHelp').hidden = false;
    for (const tx of transactions) {
        const row = document.createElement('tr');
        const fields = [['strong', tx.transaction_id], ['code', formatIban(tx.target_iban)],
            ['strong', formatMoney(tx.amount)], ['span', tx.status], ['small', formatTimestamp(tx.timestamp)]];
        for (const [index, [tag, text]] of fields.entries()) {
            const cell = document.createElement('td');
            const content = tag === 'span' ? transactionStatus(text) : textElement(tag, text);
            if (index === 2) cell.className = 'amount-cell';
            cell.append(content);
            row.append(cell);
        }
        historyTableBody.append(row);
    }
    renderDashboardActivity();
}

function transactionStatus(status) {
    const known = ['PENDING', 'APPROVED', 'FAILED'].includes(status);
    const label = known ? status[0] + status.slice(1).toLowerCase() : status;
    const element = textElement('span', label);
    element.className = known ? `status-pill ${status.toLowerCase()}` : 'status-pill';
    return element;
}

function showToast(message, type) {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    setTimeout(() => { toast.classList.add('hidden'); }, 5000);
}
