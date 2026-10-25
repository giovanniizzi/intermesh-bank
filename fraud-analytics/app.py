from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel
import time
import logging

# Initialize the FastAPI application for InterMesh Fraud Engine
app = FastAPI(title="InterMesh Fraud Analytics Engine")
logging.basicConfig(level=logging.INFO)

# TransactionPayload defines the required fields for fraud assessment
class TransactionPayload(BaseModel):
    source_account: str
    target_account: str
    amount: float

@app.post("/v2/fraud/analyze")
async def analyze_transaction(
    payload: TransactionPayload,
    x_intermesh_channel: str = Header(None),
    x_intermesh_route_class: str = Header(None)
):
    if not x_intermesh_channel or not x_intermesh_route_class:
        logging.warning("Access Denied: Missing mandatory InterMesh routing headers!")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Security Context Violation: Missing required structural routing headers."
        )

    logging.info(f"Security Context Validated. Channel: {x_intermesh_channel} | Class: {x_intermesh_route_class}")
    logging.info(f"Analyzing risk score for transaction of €{payload.amount} towards {payload.target_account}")

    # CONDITIONAL LATENCY: Simulate deeper AML/Fraud checks for foreign accounts (e.g., German IBAN)
    if payload.target_account.startswith("DE"):
        logging.info("Foreign account detected (Extra-SEPA). Triggering deep AI risk assessment compliance loop...")
        time.sleep(4.0)
    else:
        # Fast-track path for domestic transactions
        time.sleep(0.1)

    return {
        "fraud_status": "APPROVED",
        "risk_score": 0.01,
        "processed_by": "InterMesh-AI-v2"
    }