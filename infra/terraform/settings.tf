# Runtime settings in SSM Parameter Store, read by the deploy script into the
# containers' environment. Plain settings are managed here. Secrets are NOT:
# their values would sit in the Terraform state, so infra/scripts/put-secrets.sh
# writes them as SecureString straight to Parameter Store.

locals {
  settings = {
    APP_MODE              = "live"
    AWS_REGION            = var.region
    PUBLIC_APP_URL        = "https://${var.domain}"
    MEDIA_BUCKET          = aws_s3_bucket.this["media"].id
    MEDIA_URL_TTL_SECONDS = "300"
    BEDROCK_CHAT_MODEL    = var.chat_model
    BEDROCK_EMBED_MODEL   = var.embed_model
    LOG_LEVEL             = "info"
    ASSISTANT_ENABLED     = "true"
    # The demo's customer side, behind a password (D-113).
    SIM_DOMAIN = "sim.${var.domain}"
    DEMO_USER  = "demo"
  }
}

resource "aws_ssm_parameter" "setting" {
  for_each = local.settings

  name  = "${local.ssm_path}/${each.key}"
  type  = "String"
  value = each.value
}
