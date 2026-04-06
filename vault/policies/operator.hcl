# Vault Policy: krw-dex-operator
# Grants the DEX server read-only access to the operator signing key.
# The server reads the key at startup and uses it to sign on-chain settlements.
#
# Apply: vault policy write krw-dex-operator vault/policies/operator.hcl

# Operator private key (used for on-chain settlement signing)
path "secret/data/krw-dex/operator-key" {
  capabilities = ["read"]
}

# Allow token renewal (so server tokens don't expire mid-run)
path "auth/token/renew-self" {
  capabilities = ["update"]
}

# Allow token lookup (for health checks)
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
