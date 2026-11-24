# The instance role: everything the box needs and nothing more. No long-lived
# AWS keys exist anywhere; containers get these credentials from the instance
# metadata service (IMDSv2, hop limit 2 so Docker containers can reach it).

locals {
  # "global.anthropic.claude-haiku-5-5" -> "anthropic.claude-haiku-5-5"
  chat_foundation_model = regex("^(?:[a-z]+\\.)?(anthropic\\..+)$", var.chat_model)[0]
  chat_profile_arn      = "arn:${local.partition}:bedrock:${var.region}:${local.account_id}:inference-profile/${var.chat_model}"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager (shell access and Run Command for deploys) without SSH.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "instance" {
  # Runtime settings and secrets. SecureString values use the AWS managed key
  # aws/ssm, which needs no KMS statement here (Parameter Store docs).
  statement {
    sid     = "ReadSettings"
    actions = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
    resources = [
      "arn:${local.partition}:ssm:${var.region}:${local.account_id}:parameter${local.ssm_path}",
      "arn:${local.partition}:ssm:${var.region}:${local.account_id}:parameter${local.ssm_path}/*",
    ]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for repo in aws_ecr_repository.app : repo.arn]
  }

  # Media: the app reads, writes and deletes only under tenants/ (D-091).
  # Transcribe reads voice notes and writes transcripts with the caller's
  # permissions, which these cover (Transcribe IAM docs: GetObject and
  # ListBucket on input, PutObject on output).
  statement {
    sid       = "MediaList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this["media"].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["tenants/*"]
    }
  }

  statement {
    sid       = "MediaObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.this["media"].arn}/tenants/*"]
  }

  # Ops bucket: fetch release bundles; write and read backups (restore drill).
  statement {
    sid       = "Releases"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this["ops"].arn}/releases/*"]
  }

  statement {
    sid       = "BackupObjects"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.this["ops"].arn}/backups/*"]
  }

  statement {
    sid       = "BackupList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this["ops"].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["backups/*"]
    }
  }

  # StartTranscriptionJob has no resource type; its output must go to the
  # media bucket. Jobs are named voice-{messageId} (D-092).
  statement {
    sid       = "TranscribeStart"
    actions   = ["transcribe:StartTranscriptionJob"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "transcribe:OutputBucketName"
      values   = [aws_s3_bucket.this["media"].id]
    }
  }

  statement {
    sid       = "TranscribeJobs"
    actions   = ["transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"]
    resources = ["arn:${local.partition}:transcribe:${var.region}:${local.account_id}:transcription-job/voice-*"]
  }

  statement {
    sid       = "Polly"
    actions   = ["polly:SynthesizeSpeech"]
    resources = ["*"]
  }

  # Claude through an inference profile on bedrock-runtime (D-109). For a
  # global profile, AWS's "global cross-Region inference" docs require three
  # resources: the profile in this Region, the foundation model in this
  # Region, and the Region-less global foundation model. Each model grant only
  # applies when the call comes through this profile.
  statement {
    sid       = "ClaudeProfile"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.chat_profile_arn]
  }

  statement {
    sid     = "ClaudeModelThroughProfile"
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:${local.partition}:bedrock:*::foundation-model/${local.chat_foundation_model}",
      "arn:${local.partition}:bedrock:::foundation-model/${local.chat_foundation_model}",
    ]

    condition {
      test     = "StringEquals"
      variable = "bedrock:InferenceProfileArn"
      values   = [local.chat_profile_arn]
    }
  }

  # Cohere embeddings in-region. The Marketplace subscription is made once by
  # a person (docs/RUNBOOK.md), so the instance needs no aws-marketplace actions.
  statement {
    sid       = "Embeddings"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:${local.partition}:bedrock:${var.region}::foundation-model/${var.embed_model}"]
  }
}

resource "aws_iam_role_policy" "instance" {
  name   = "app"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}
