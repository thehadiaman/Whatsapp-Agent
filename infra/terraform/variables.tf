variable "project" {
  description = "Prefix for every resource name."
  type        = string
  default     = "support-desk"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.project))
    error_message = "Lowercase letters, digits and hyphens, 3 to 21 characters."
  }
}

variable "environment" {
  description = "Environment name, part of resource names and the SSM path."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS Region. Mumbai: Claude through a global inference profile, Cohere in-region (D-090, D-109)."
  type        = string
  default     = "ap-south-1"
}

variable "domain" {
  description = "Public host name for the desk, e.g. desk.example.com. Point its A record at the elastic IP; Caddy then obtains the certificate."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "A lowercase host name such as desk.example.com."
  }
}

variable "instance_type" {
  description = "One ARM instance with about 4 GB runs everything (brief §5)."
  type        = string
  default     = "t4g.medium"

  validation {
    condition     = can(regex("^(t4g|m7g|m8g|c7g|r7g)\\.", var.instance_type))
    error_message = "The images are built for arm64: use a Graviton type."
  }
}

variable "root_volume_gb" {
  description = "Root volume: the OS, Docker and its images."
  type        = number
  default     = 20
}

variable "data_volume_gb" {
  description = "Separate volume for Postgres, Redis and Caddy's certificates. It outlives the instance."
  type        = number
  default     = 20
}

variable "media_retention_days" {
  description = "Customer media (voice notes, photos, documents, replies) expires after this many days (brief §5)."
  type        = number
  default     = 90

  validation {
    condition     = var.media_retention_days >= 1
    error_message = "At least one day."
  }
}

variable "backup_retention_days" {
  description = "Nightly database backups are kept this long."
  type        = number
  default     = 30
}

variable "chat_model" {
  description = "Claude inference profile ID on bedrock-runtime (D-109). global.* may process requests in any commercial Region; in.anthropic.claude-haiku-4-5-20251001-v1:0 stays in India."
  type        = string
  default     = "global.anthropic.claude-haiku-5-5"

  validation {
    condition     = can(regex("^[a-z]+\\.anthropic\\.", var.chat_model))
    error_message = "An inference profile ID such as global.anthropic.claude-haiku-5-5: Mumbai has no in-Region Claude Haiku."
  }
}

variable "embed_model" {
  description = "Embedding model on Bedrock (D-090)."
  type        = string
  default     = "cohere.embed-multilingual-v3"
}

variable "github_oidc_subject_prefix" {
  description = <<-EOT
    The start of GitHub's OIDC "sub" claim for this repository, without the ref
    or environment part. "repo:OWNER/REPO", or for repositories created after
    2026-07-15 (immutable subject claims) "repo:OWNER@OWNER_ID/REPO@REPO_ID".
    docs/RUNBOOK.md shows how to read the exact value.
  EOT
  type        = string

  validation {
    condition     = can(regex("^repo:[^:/]+/[^:/]+$", var.github_oidc_subject_prefix))
    error_message = "Expected repo:OWNER/REPO (optionally with @IDs), nothing after it."
  }
}

variable "create_github_oidc_provider" {
  description = "An account has one GitHub OIDC provider. Set false if it already exists."
  type        = bool
  default     = true
}

variable "budget_monthly_usd" {
  description = "Monthly cost budget; an email goes out at 80% actual and 100% forecast."
  type        = number
  default     = 40
}

variable "budget_email" {
  description = "Where budget alerts go. Empty: no budget is created."
  type        = string
  default     = ""
}
