# CI reaches AWS through GitHub's OIDC provider: short-lived credentials, no
# stored keys. Two roles, each for one job:
# - push: builds on main push images to ECR and the release bundle to S3.
# - deploy: only the "production" GitHub environment (which can require your
#   approval) may run the deploy command on the instance.

locals {
  github_oidc_url   = "token.actions.githubusercontent.com"
  github_push_sub   = "${var.github_oidc_subject_prefix}:ref:refs/heads/main"
  github_deploy_sub = "${var.github_oidc_subject_prefix}:environment:production"
  github_oidc_provider_arn = (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : "arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.github_oidc_url}"
  )
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_oidc_url}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  for_each = {
    push   = local.github_push_sub
    deploy = local.github_deploy_sub
  }

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = [each.value]
    }
  }
}

resource "aws_iam_role" "github" {
  for_each = data.aws_iam_policy_document.github_assume

  name                 = "${local.name}-github-${each.key}"
  assume_role_policy   = each.value.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_push" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for repo in aws_ecr_repository.app : repo.arn]
  }

  statement {
    sid       = "ReleaseBundle"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this["ops"].arn}/releases/*"]
  }
}

resource "aws_iam_role_policy" "github_push" {
  name   = "push"
  role   = aws_iam_role.github["push"].id
  policy = data.aws_iam_policy_document.github_push.json
}

# Run Command on this one instance with the stock shell document, and read
# the result. Nothing else: no shell on other instances, no other documents.
data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid     = "SendDeployCommand"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.app.arn,
      "arn:${local.partition}:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }

  # Read-only: the status and output of the command just sent.
  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github["deploy"].id
  policy = data.aws_iam_policy_document.github_deploy.json
}
