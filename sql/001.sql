DROP TABLE IF EXISTS intermesh_accounts;
DROP SEQUENCE IF EXISTS intermesh_account_seq;

CREATE SEQUENCE intermesh_account_seq START WITH 4000;

CREATE TABLE intermesh_accounts (
    account_id VARCHAR(50) PRIMARY KEY,   
    user_id VARCHAR(50) NOT NULL,         
    iban VARCHAR(34) NOT NULL UNIQUE,
    holder_name VARCHAR(100) NOT NULL,
    balance NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    frozen_balance NUMERIC(15, 2) NOT NULL DEFAULT 0.00
);

INSERT INTO intermesh_accounts (account_id, user_id, iban, holder_name, balance, frozen_balance) 
VALUES ('ACC-1001', 'mario.rossi', 'IT99X0306905000000100001001', 'Mario Rossi', 10000.00, 0.00);

INSERT INTO intermesh_accounts (account_id, user_id, iban, holder_name, balance, frozen_balance) 
VALUES ('ACC-2002', 'john.doe', 'DE880306905000000100002002', 'John Doe', 500.00, 0.00);

INSERT INTO intermesh_accounts (account_id, user_id, iban, holder_name, balance, frozen_balance) 
VALUES ('ACC-3003', 'giovanni.izzi', 'IT99X0306905000000100003003', 'Giovanni Luca Izzi', 100.00, 0.00);