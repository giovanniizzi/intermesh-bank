BEGIN;

CREATE TABLE intermesh_transfer_requests (
    transfer_request_id UUID PRIMARY KEY,
    issuer TEXT NOT NULL
        CHECK (char_length(issuer) <= 2048 AND issuer ~ '[^[:space:]]'),
    subject TEXT NOT NULL
        CHECK (char_length(subject) <= 255 AND subject ~ '[^[:space:]]'),
    source_account_id VARCHAR(50) NOT NULL
        REFERENCES intermesh_accounts(account_id),
    target_iban VARCHAR(34) NOT NULL CHECK (target_iban ~ '[^[:space:]]'),
    amount NUMERIC(15,2) NOT NULL
        CHECK (amount > 0 AND amount <= 9999999999999.99),
    allow_duplicate_pending_transfer BOOLEAN NOT NULL,
    admission_status VARCHAR(8) NOT NULL,
    rejection_code VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT ck_intermesh_request_admission CHECK (
        (
            admission_status = 'ADMITTED'
            AND rejection_code IS NULL
        )
        OR
        (
            admission_status = 'REJECTED'
            AND rejection_code IS NOT NULL
            AND rejection_code IN (
                'DUPLICATE_APPROVAL_REQUIRED',
                'DUPLICATE_APPROVAL_NOT_ELIGIBLE',
                'DUPLICATE_EXCEPTION_USED',
                'ACTIVE_CYCLE_BLOCKED',
                'ACTIVE_CYCLE_CONFLICT',
                'INSUFFICIENT_FUNDS'
            )
        )
    )
);

ALTER TABLE intermesh_transactions
    ADD COLUMN transfer_request_id UUID,
    ADD COLUMN duplicate_pending_approved BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN ordinary_transaction_id VARCHAR(50),

    ADD CONSTRAINT fk_intermesh_transaction_request
        FOREIGN KEY (transfer_request_id)
        REFERENCES intermesh_transfer_requests(transfer_request_id),

    ADD CONSTRAINT uq_intermesh_transaction_request
        UNIQUE (transfer_request_id),

    ADD CONSTRAINT fk_intermesh_transaction_ordinary
        FOREIGN KEY (ordinary_transaction_id)
        REFERENCES intermesh_transactions(transaction_id),

    ADD CONSTRAINT ck_intermesh_duplicate_association CHECK (
        (
            ordinary_transaction_id IS NULL
            AND NOT duplicate_pending_approved
        )
        OR
        (
            ordinary_transaction_id IS NOT NULL
            AND duplicate_pending_approved
            AND transfer_request_id IS NOT NULL
            AND ordinary_transaction_id <> transaction_id
        )
    ),

    ADD CONSTRAINT ck_intermesh_registered_transaction CHECK (
        transfer_request_id IS NULL
        OR
        (
            source_account_id IS NOT NULL
            AND amount > 0
            AND amount <= 9999999999999.99
            AND status IN ('PENDING', 'APPROVED', 'FAILED')
        )
    );

CREATE UNIQUE INDEX uq_intermesh_ordinary_duplicate
    ON intermesh_transactions (ordinary_transaction_id)
    WHERE ordinary_transaction_id IS NOT NULL;

CREATE INDEX ix_intermesh_pending_transfer
    ON intermesh_transactions (source_account_id, target_iban, amount)
    WHERE status = 'PENDING';

COMMIT;
