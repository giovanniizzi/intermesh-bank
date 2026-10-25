import Keycloak from './libs/keycloak.js';

// --- VARIABILI GLOBALI DEL MODULO (Scope Smart) ---
const GATEWAY_URL = window.location.origin; 
let activeAccountID = null;
let pollingInterval = null;

// Riferimenti agli elementi HTML (Dichiarati sopra, valorizzati al boot)
let sourceAccountInput, onboardingTarget, historyTableBody, toast;

const keycloak = new Keycloak({
    url: 'PLACEHOLDER_KEYCLOAK_URL',
    realm: 'intermesh-bank',
    clientId: 'intermesh-frontend'
});

// Enforce modern authentication loop
keycloak.init({ 
    onLoad: 'login-required',
    checkLoginIframe: false,
    pkceMethod: 'S256'
}).then((authenticated) => {
    if (authenticated) {
        console.log("[Keycloak] Boundary Token Verified. Launching core systems...");
        
        // FASE 1: Agganciamo SUBITO gli elementi HTML prima di fare qualsiasi altra operazione
        bindUIElements();
        
        // FASE 2: Popoliamo l'interfaccia utente (Nome, Avatar)
        populateUserProfile();
        
        // FASE 3: Attiviamo i listener per l'invio dei form
        setupEventListeners();
        
        // FASE 4: Solo ora che sourceAccountInput è PRONTO ed esistente, cerchiamo il conto nel DB
        const userID = keycloak.tokenParsed.preferred_username;
        if (userID) {
            checkExistingAccount(userID);
        }
    } else {
        window.location.reload();
    }
}).catch((error) => {
    console.error("[Keycloak Critical Fault Details]:", error);
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

// --- PIPELINE DI AUTO-DISCOVERY AL REFRESH ---
async function checkExistingAccount(userID) {
    try {
        console.log(`[Channel Hub Lookup] Checking existing assets for: ${userID}`);
        const response = await fetch(`${GATEWAY_URL}/api/v1/accounts/${userID}`, {
            headers: { 'Authorization': `Bearer ${keycloak.token}` }
        });
        
        if (response.status === 200) {
            const accountData = await response.json();
            
            // Valorizziamo la variabile di stato interna
            activeAccountID = accountData.account_id;
            
            // Nascondiamo il form di onboarding perché l'utente ha già un conto attivo
            document.getElementById('onboardingForm').classList.add('hidden');
            
            // CRUCIAL FIX: Iniettiamo l'ID del conto direttamente nel campo "Source Account" del Bonifico
            if (sourceAccountInput) {
                sourceAccountInput.value = activeAccountID;
            }
            
            // Aggiorniamo il box informativo per dare il benvenuto
            onboardingTarget.innerHTML = `<strong>Welcome Back ${accountData.holder_name}!</strong><br><strong>Account Number:</strong> ${activeAccountID}<br><strong>IBAN:</strong> ${accountData.iban}<br><strong>Live Balance:</strong> €${accountData.balance.toFixed(2)}`;
            onboardingTarget.classList.remove('hidden');
            
            // Facciamo partire il polling automatico per mostrare i movimenti nel Ledger
            startLedgerPolling(activeAccountID);
        } else {
            console.log("[Channel Hub Context] No pre-existing account discovered. Fresh onboarding required.");
        }
    } catch (error) {
        console.error("[Channel Hub Link Fault] Profile discovery failed:", error);
    }
}

function startLedgerPolling(accountId) {
    const runPolling = () => {
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

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            runPolling();
        } else {
            stopPolling();
        }
    };

    document.removeEventListener('visibilitychange', handleVisibilityChange);

    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (document.visibilityState === 'visible') {
        runPolling();
    }
}

async function fetchLedgerHistory(accountId) {
    try {
        const response = await fetch(`${GATEWAY_URL}/api/v1/account/${accountId}/transactions`, {
            headers: { 'Authorization': `Bearer ${keycloak.token}` }
        });
        if (!response.ok) return;

        const transactions = await response.json();
        renderHistoryTable(transactions);
    } catch (e) {}
}

function setupEventListeners() {
    const onboardingForm = document.getElementById('onboardingForm');
    const transferForm = document.getElementById('transferForm');

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            console.log("[Keycloak Perimeter] Terminating user session link...");
            
            // Pulisce preventivamente i cicli di polling attivi per evitare memory leak
            if (pollingInterval) clearInterval(pollingInterval);
            
            // Questo comando distrugge la sessione su Keycloak e reindirizza 
            // automaticamente il browser alla pagina di login iniziale
            keycloak.logout({
                redirectUri: window.location.origin // Riporta l'utente alla home della banca dopo il logout
            });
        });
    }

    // Pipeline Onboarding
    onboardingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
            holder_name: document.getElementById('holderName').value,
            initial_deposit: parseFloat(document.getElementById('initialDeposit').value)
        };
        try {
            const response = await fetch(`${GATEWAY_URL}/api/v1/accounts`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${keycloak.token}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error('Onboarding execution rejected by Mesh guards.');
            
            const result = await response.json();
            const accountDetails = result.account_details;
            activeAccountID = accountDetails.account_id;

            sourceAccountInput.value = activeAccountID; // Valorizzazione immediata del campo bonifico dopo la creazione
            onboardingTarget.innerHTML = `<strong>Active Account Provisioned:</strong> ${activeAccountID} <br> <strong>IBAN:</strong> ${accountDetails.iban}`;
            onboardingTarget.classList.remove('hidden');
            
            showToast('Account successfully provisioned in Core Ledger!', 'success');
            startLedgerPolling(activeAccountID);
        } catch (error) {
            showToast(error.message, 'error');
        }
    });

    // Pipeline Bonifico
    transferForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
            source_account: sourceAccountInput.value,
            target_account: document.getElementById('targetAccount').value,
            amount: parseFloat(document.getElementById('transferAmount').value)
        };
        showToast('Processing wire transfer transaction...', 'success');
        try {
            const response = await fetch(`${GATEWAY_URL}/api/v1/transfers`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${keycloak.token}`
                },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (response.status === 200) {
                const txId = result.ledgerTransferResponseDTO.transaction_id;
                showToast(`Transfer approved successfully! TxID: ${txId}`, 'success');
            } else {
                showToast(`Transaction rejected: ${result.reason || 'Insufficient funds'}`, 'error');
            }
            if (activeAccountID) fetchLedgerHistory(activeAccountID);
        } catch (error) {
            showToast('Mesh Link connection interruption.', 'error');
        }
    });
}

function renderHistoryTable(transactions) {
    if (!transactions || transactions.length === 0) {
        historyTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">No transactions recorded yet for this asset.</td></tr>`;
        return;
    }
    historyTableBody.innerHTML = transactions.map(tx => `
        <tr>
            <td><strong>${tx.transaction_id}</strong></td>
            <td><code>${tx.target_iban}</code></td>
            <td><strong>€${tx.amount.toFixed(2)}</strong></td>
            <td><span class="status-pill ${tx.status.toLowerCase()}">${tx.status}</span></td>
            <td><small>${tx.timestamp}</small></td>
        </tr>
    `).join('');
}

function showToast(message, type) {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    setTimeout(() => { toast.classList.add('hidden'); }, 5000);
}