# Two private buckets, both encrypted at rest and refusing plain HTTP:
# - media: customer voice notes, photos, documents, replies and knowledge
#   files, all under tenants/{tenantId}/ (brief §5), expired by lifecycle.
# - ops: database backups and release bundles, versioned.

locals {
  buckets = {
    media = "${local.name}-media-${local.account_id}"
    ops   = "${local.name}-ops-${local.account_id}"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets
  bucket   = each.value
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3 by default; the app also asks for AES256 on every write (D-091).
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = aws_s3_bucket.this

  statement {
    sid       = "DenyPlainHttp"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.tls_only[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.this["media"].id

  rule {
    id     = "expire-tenant-media"
    status = "Enabled"

    filter {
      prefix = "tenants/"
    }

    expiration {
      days = var.media_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_versioning" "ops" {
  bucket = aws_s3_bucket.this["ops"].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "ops" {
  bucket = aws_s3_bucket.this["ops"].id

  rule {
    id     = "expire-backups"
    status = "Enabled"

    filter {
      prefix = "backups/"
    }

    expiration {
      days = var.backup_retention_days
    }

    # A deleted or overwritten backup stays recoverable for a week.
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  rule {
    id     = "expire-releases"
    status = "Enabled"

    filter {
      prefix = "releases/"
    }

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.ops]
}
