DROP TABLE IF EXISTS intermesh_transactions;

CREATE TABLE intermesh_transactions (
    transaction_id VARCHAR(50) PRIMARY KEY,
    source_account_id VARCHAR(50) REFERENCES intermesh_accounts(account_id),
    target_iban VARCHAR(34) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    status VARCHAR(20) NOT NULL, -- 'PENDING', 'APPROVED', 'FAILED'
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);