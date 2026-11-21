# Run once, with local state, before the main configuration: creates the
# versioned, encrypted bucket that holds the main configuration's state.
#   terraform -chdir=infra/terraform/bootstrap init
#   terraform -chdir=infra/terraform/bootstrap apply -var region=ap-south-1
# Then write its output into infra/terraform/backend.hcl (docs/RUNBOOK.md).

terraform {
  required_version = ">= 1.17.1, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "support-desk-tfstate-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}
