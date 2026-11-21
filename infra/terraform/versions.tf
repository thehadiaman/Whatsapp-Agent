# Terraform 1.10+ for S3-native state locking (use_lockfile); versions pinned
# to releases at least two weeks old when written (2026-11-21).
terraform {
  required_version = ">= 1.17.1, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }

  # Partial configuration: the bucket and region come from backend.hcl
  # (see backend.hcl.example and docs/RUNBOOK.md), so no account details are
  # committed. Create the bucket once with infra/terraform/bootstrap.
  backend "s3" {
    key          = "support-desk/prod.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name       = "${var.project}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  # Every runtime setting and secret lives under this path (SSM Parameter Store).
  ssm_path = "/${var.project}/${var.environment}"
}
