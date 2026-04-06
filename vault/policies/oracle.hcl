# Vault Policy: krw-dex-oracle
# Grants the oracle operator read-only access to the oracle signing key.
#
# Apply: vault policy write krw-dex-oracle vault/policies/oracle.hcl

path "secret/data/krw-dex/oracle-key" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
