# HashiCorp Vault Configuration — R-2: Key Management (Phase R)
#
# Reference: https://developer.hashicorp.com/vault/docs/configuration
# Pattern:   dYdX v4 operator key management (software-based → HSM upgrade path)
#
# This is the Vault OSS (Phase R-2) configuration.
# Phase R-5 upgrade: swap `seal` block for PKCS#11 HSM (AWS CloudHSM / Thales).
#
# Usage:
#   docker run -d --name vault \
#     -p 8200:8200 \
#     -v $(pwd)/vault/vault.hcl:/vault/config/vault.hcl \
#     -v vault_data:/vault/data \
#     --cap-add=IPC_LOCK \
#     hashicorp/vault:latest server
#
#   export VAULT_ADDR=http://127.0.0.1:8200
#   vault operator init       # save unseal keys + root token SECURELY
#   vault operator unseal     # x3 (threshold = 3 of 5)

storage "file" {
  path = "/vault/data"
}

listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_disable   = "false"
  tls_cert_file = "/vault/tls/vault.crt"
  tls_key_file  = "/vault/tls/vault.key"
}

# Phase R-5 upgrade: replace this block with PKCS#11 HSM seal
# seal "pkcs11" {
#   lib            = "/usr/lib/cloudhsm/libbcrypt.so"
#   slot           = "0"
#   key_label      = "hyperkrw-vault-seal"
#   hmac_key_label = "hyperkrw-vault-hmac"
#   mechanism      = "CKM_AES_CBC"
# }

api_addr     = "https://vault.hyperkrw.xyz"
cluster_addr = "https://vault.hyperkrw.xyz:8201"

ui           = false   # disable web UI in production

# Audit log — required for compliance
audit {
  type = "file"
  options = {
    path = "/vault/logs/audit.log"
  }
}
