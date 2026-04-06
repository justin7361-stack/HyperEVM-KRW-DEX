#!/usr/bin/env bash
# vault/setup.sh — R-2: One-time Vault setup after `vault operator init`
#
# Prerequisites:
#   1. vault operator init         # save 5 unseal keys + root token
#   2. vault operator unseal       # x3 (default threshold)
#   3. export VAULT_TOKEN=<root>   # use root token ONLY for this script
#   4. export VAULT_ADDR=https://vault.hyperkrw.xyz
#
# After this script:
#   - Revoke the root token (vault token revoke $VAULT_TOKEN)
#   - Use AppRole tokens for the server

set -euo pipefail

echo "=== HyperKRW Vault Setup (R-2) ==="
echo "VAULT_ADDR: $VAULT_ADDR"

# 1. Enable KV v2 secrets engine
vault secrets enable -path=secret kv-v2
echo "[1/5] KV v2 enabled at secret/"

# 2. Write operator private key (replace 0x... with real key)
echo "Enter OPERATOR_PRIVATE_KEY (0x...): "
read -rs OPERATOR_KEY
vault kv put secret/krw-dex/operator-key value="$OPERATOR_KEY"
echo "[2/5] Operator key stored"
unset OPERATOR_KEY

# 3. Write oracle private key
echo "Enter ORACLE_PRIVATE_KEY (0x...): "
read -rs ORACLE_KEY
vault kv put secret/krw-dex/oracle-key value="$ORACLE_KEY"
echo "[3/5] Oracle key stored"
unset ORACLE_KEY

# 4. Apply policies
vault policy write krw-dex-operator "$(dirname "$0")/policies/operator.hcl"
vault policy write krw-dex-oracle   "$(dirname "$0")/policies/oracle.hcl"
echo "[4/5] Policies applied"

# 5. Enable AppRole auth + create roles for server + oracle
vault auth enable approle

vault write auth/approle/role/dex-server \
  token_policies="krw-dex-operator" \
  token_ttl="1h" \
  token_max_ttl="24h" \
  token_num_uses=0 \
  secret_id_ttl="0"   # never expire (server restarts need to re-auth)

vault write auth/approle/role/dex-oracle \
  token_policies="krw-dex-oracle" \
  token_ttl="1h" \
  token_max_ttl="24h" \
  token_num_uses=0 \
  secret_id_ttl="0"

echo "[5/5] AppRole auth configured"

# Print role IDs (share with server via environment — NOT secret)
SERVER_ROLE_ID=$(vault read -field=role_id auth/approle/role/dex-server/role-id)
ORACLE_ROLE_ID=$(vault read -field=role_id auth/approle/role/dex-oracle/role-id)
echo ""
echo "=== Add to server .env ==="
echo "VAULT_ADDR=$VAULT_ADDR"
echo "VAULT_ROLE_ID=$SERVER_ROLE_ID"
echo "VAULT_SECRET_ID=<generate below>"
echo ""
echo "Generate secret IDs (store securely — treat as passwords):"
echo "  vault write -f auth/approle/role/dex-server/secret-id"
echo "  vault write -f auth/approle/role/dex-oracle/secret-id"
echo ""
echo "=== IMPORTANT ==="
echo "1. Revoke root token: vault token revoke \$VAULT_TOKEN"
echo "2. Store unseal keys in separate secure locations (HSM, paper, etc.)"
echo "3. Test server auth: vault write auth/approle/login role_id=... secret_id=..."
