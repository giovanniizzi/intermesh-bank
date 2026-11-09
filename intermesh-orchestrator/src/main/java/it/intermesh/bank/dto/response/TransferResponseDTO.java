package it.intermesh.bank.dto.response;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class TransferResponseDTO {
    private LedgerTransferResponseDTO ledgerTransferResponseDTO;

    public TransferResponseDTO(LedgerTransferResponseDTO ledgerTransferResponseDTO) {
        this.ledgerTransferResponseDTO = ledgerTransferResponseDTO;
    }

    public LedgerTransferResponseDTO getLedgerTransferResponseDTO() { 
        return ledgerTransferResponseDTO; 
    }
    public void setLedgerTransferResponseDTO(LedgerTransferResponseDTO ledgerTransferResponseDTO) { 
        this.ledgerTransferResponseDTO = ledgerTransferResponseDTO; 
    }   
}