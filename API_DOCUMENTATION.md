# Crypto Gift Card Platform - API Documentation

This backend handles the sale of gift cards using cryptocurrency payments (ETH/USDC) on the Sepolia testnet.

## 🚀 Payment Lifecycle

1.  **Selection**: The user fetches available cards using `GET /cards`.
2.  **Intent**: The user initiates a purchase via `POST /buy`. The backend creates a `pending` payment.
3.  **Transfer**: The user sends the specified amount of ETH/USDC to the server's wallet.
4.  **Verification**: Alchemy sends a webhook notification. The server matches the transaction hash to the pending intent and moves it to `holding`.
5.  **Delivery**: The user is immediately granted access to download the gift card file via `GET /download/:tx_hash`.
6.  **Settlement**: After a 24-hour hold period, a cron job transfers the funds to the business account and marks the payment as `completed`.

---

## 🛠 Endpoints

### 1. Get Active Cards
Returns a list of all cards currently available for sale.
*   **URL**: `GET /cards`
*   **Response**: `200 OK`
    ```json
    [
      {
        "id": 1,
        "name": "Amazon $50 Card",
        "description": "Valid for US region",
        "price": 0.005,
        "status": "active"
      }
    ]
    ```

### 2. Create Payment Intent
Initiates the buying process for a specific card.
*   **URL**: `POST /buy`
*   **Body**:
    ```json
    { "card_id": 1 }
    ```
*   **Response**: `201 Created`
    ```json
    {
      "message": "Payment intent created.",
      "payment_id": 12,
      "amount": 0.005,
      "asset": "ETH",
      "pay_to": "0xYourServerWalletAddress...",
      "hold_period_hours": 24
    }
    ```

### 3. Download Card File
Allows the user to download the gift card after the transaction is confirmed.
*   **URL**: `GET /download/:tx_hash`
*   **Parameters**: `tx_hash` (The transaction hash from the user's wallet transfer)
*   **Response**: File download (Binary) or `403 Forbidden` if not confirmed.

---

## 🔒 Security & Hold Period
To prevent fraud and allow for refunds, all incoming payments are held in the server wallet for **24 hours**. 
*   **Status: pending**: Intent created, waiting for transfer.
*   **Status: holding**: Transfer detected by webhook. User can now download the file.
*   **Status: completed**: 24 hours passed, funds moved to the business account.
